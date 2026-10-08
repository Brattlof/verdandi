/**
 * WCAG contrast of on-screen text at one time: each visible text element's colour against the median of the pixels
 * behind it, read from a screenshot taken with every glyph hidden. AA asks 4.5:1, or 3:1 for large text (24px, or 19px
 * bold). Pixels are read in the page (canvas), so no image decoder is needed here.
 */
import type { Page } from "puppeteer-core";

export type ContrastSample = {
  readonly name: string;
  readonly text: string;
  readonly ratio: number;
  readonly required: number;
  readonly fg: string;
  readonly bg: string;
};

/** Runs in the page: hides every visible text element's glyphs and returns what was hidden, to measure and restore. */
const hideText = () => {
  const root = document.querySelector('[data-composition-id][data-root="true"]') ?? document.querySelector("[data-composition-id]");
  const out: { i: number; color: string; x: number; y: number; w: number; h: number; large: boolean; name: string; text: string }[] = [];
  if (!root) return out;
  const els = [...root.querySelectorAll<HTMLElement>("*")].filter(
    (el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) && !el.closest("[data-layout-ignore]"),
  );
  for (const [i, el] of els.entries()) {
    const s = getComputedStyle(el);
    if (s.visibility !== "visible" || s.display === "none") continue;
    let opacity = 1;
    for (let a: HTMLElement | null = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
    if (opacity < 0.5) continue; // mid-fade: judged when it is fully shown
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    // Text something else covers isn't read against its background: what's on top is what shows.
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && !el.contains(top)) continue;
    const size = Number.parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    out.push({
      i,
      color: s.color,
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      large: size >= 24 || (size >= 19 && bold),
      name: el.id ? `#${el.id}` : `<${el.tagName.toLowerCase()}${el.classList.length ? ` class="${el.className}"` : ""}>`,
      text: (el.textContent ?? "").trim().slice(0, 40),
    });
    // The author's own inline values, put back exactly by restoreText.
    el.dataset.vdContrast = JSON.stringify(
      ["color", "-webkit-text-fill-color"].map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]),
    );
    el.style.setProperty("color", "transparent", "important");
    el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
  }
  return out;
};

const restoreText = () => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-vd-contrast]")) {
    for (const [prop, value, priority] of JSON.parse(el.dataset.vdContrast ?? "[]") as [string, string, string][]) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    delete el.dataset.vdContrast;
  }
};

/** Runs in the page: the ratio for each hidden element, sampling the screenshot `png` (base64) on a 12×6 grid. */
const measure = async (png: string, items: ReturnType<typeof hideText>) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0);
  const lum = ([r, g, b]: number[]) => {
    const c = [r, g, b].map((v) => {
      const x = (v ?? 0) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
  };
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  return items.flatMap((it) => {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let gy = 0; gy < 6; gy++)
      for (let gx = 0; gx < 12; gx++) {
        const x = Math.min(canvas.width - 1, Math.max(0, Math.round(it.x + 1 + ((it.w - 2) * (gx + 0.5)) / 12)));
        const y = Math.min(canvas.height - 1, Math.max(0, Math.round(it.y + 1 + ((it.h - 2) * (gy + 0.5)) / 6)));
        const [r = 0, g = 0, b = 0] = ctx.getImageData(x, y, 1, 1).data;
        rs.push(r);
        gs.push(g);
        bs.push(b);
      }
    const bg = [median(rs), median(gs), median(bs)];
    const m = /rgba?\(([^)]+)\)/.exec(it.color);
    const parts = (m?.[1] ?? "0,0,0")
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    const a = parts[3] ?? 1;
    if (a < 0.05) return [];
    // Translucent text is seen over its background.
    const fg = [0, 1, 2].map((k) => (parts[k] ?? 0) * a + (bg[k] ?? 0) * (1 - a));
    const [l1, l2] = [lum(fg), lum(bg)].sort((p, q) => q - p);
    const ratio = ((l1 ?? 0) + 0.05) / ((l2 ?? 0) + 0.05);
    return [{ name: it.name, text: it.text, ratio, required: it.large ? 3 : 4.5, fg: hex(fg), bg: hex(bg) }];
  });
};

/** Every visible text element's contrast at the page's current time (seek first). */
export const contrastNow = async (page: Page, width: number, height: number): Promise<ContrastSample[]> => {
  const items = await page.evaluate(hideText);
  if (!items.length) return [];
  try {
    const png = await page.screenshot({
      type: "png",
      encoding: "base64",
      clip: { x: 0, y: 0, width, height },
      captureBeyondViewport: false,
    });
    return await page.evaluate(measure, png, items);
  } finally {
    await page.evaluate(restoreText);
  }
};
