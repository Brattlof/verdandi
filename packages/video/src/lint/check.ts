/**
 * `check`: lint, then the rules only a running page can answer, at sampled times in headless Chrome: runtime errors
 * and failed requests, clips that end after the composition, tweens that fight the runtime over a clip's visibility,
 * text that leaves the canvas or its clipping box, and a composition where nothing ever moves.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type Env, launchBrowser, openComposition } from "../engine/browser.ts";
import { serveProject } from "../engine/server.ts";
import type { Manifest } from "../runtime/player.ts";
import { type LintResult, lintProject, summarize } from "./lint.ts";
import type { Finding } from "./rules.ts";

export type CheckResult = LintResult & { readonly browserSkipped: boolean; readonly samples: readonly number[] };

type PageIssue = {
  readonly code: string;
  readonly severity: Finding["severity"];
  readonly message: string;
  readonly fix: string;
  readonly time?: number;
};

/** Runs in the page: tweens on registered timelines that set a clip's visibility, display or autoAlpha. */
const clipTweens = () => {
  const out: PageIssue[] = [];
  for (const [id, tl] of Object.entries(window.__timelines)) {
    const children = (tl as { getChildren?: (n: boolean, t: boolean, tl: boolean) => unknown[] }).getChildren?.(true, true, false) ?? [];
    for (const tw of children as { targets?: () => unknown[]; vars?: Record<string, unknown> }[]) {
      const props = Object.keys(tw.vars ?? {}).filter((k) => k === "autoAlpha" || k === "visibility" || k === "display");
      if (!props.length) continue;
      for (const target of tw.targets?.() ?? [])
        if (target instanceof Element && target.hasAttribute("data-start"))
          out.push({
            code: "gsap_animates_clip_element",
            severity: "error",
            message: `Timeline "${id}" tweens ${props.join(", ")} on the clip ${target.id ? `#${target.id}` : `<${target.tagName.toLowerCase()}>`}, which the runtime shows and hides by its window.`,
            fix: "Animate opacity on a child of the clip instead.",
          });
    }
  }
  return out;
};

/** Runs in the page at time `t`: visible text outside the canvas, or cut off by an ancestor that clips it. */
const layoutAt = (t: number, tolerance: number) => {
  const root = document.querySelector("[data-composition-id]");
  if (!root) return [];
  const canvas = root.getBoundingClientRect();
  const out: PageIssue[] = [];
  const name = (el: Element) =>
    el.id
      ? `#${el.id}`
      : `<${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? ` class="${el.className}"` : ""}>`;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent?.trim()) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    if (style.visibility !== "visible" || Number(style.opacity) === 0 || el.closest("[data-layout-ignore]")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (
      r.left < canvas.left - tolerance ||
      r.top < canvas.top - tolerance ||
      r.right > canvas.right + tolerance ||
      r.bottom > canvas.bottom + tolerance
    )
      out.push({
        code: "text_outside_canvas",
        severity: "warning",
        time: t,
        message: `Text in ${name(el)} runs outside the canvas at ${t.toFixed(2)}s.`,
        fix: "Shrink or reposition it, or mark it data-layout-ignore if it leaves on purpose.",
      });
    // The root clips everything to the canvas; that is text_outside_canvas, not clipping by a box.
    for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflow === "visible" && s.overflowX === "visible" && s.overflowY === "visible") continue;
      const box = a.getBoundingClientRect();
      if (
        r.left < box.left - tolerance ||
        r.top < box.top - tolerance ||
        r.right > box.right + tolerance ||
        r.bottom > box.bottom + tolerance
      )
        out.push({
          code: "clipped_text",
          severity: "warning",
          time: t,
          message: `Text in ${name(el)} is cut off by ${name(a)} (overflow: ${s.overflow}) at ${t.toFixed(2)}s.`,
          fix: "Give the text room, make it smaller, or let the box grow.",
        });
      break;
    }
  }
  return out;
};

/**
 * Lints `projectDir`, then (when lint found no errors: a broken page would only repeat them) samples it in Chrome at
 * `samples` midpoints. A finding seen at several times is reported once, with the first time.
 */
export const checkProject = async (options: {
  readonly projectDir: string;
  readonly entry?: string;
  readonly env: Env;
  readonly samples?: number;
  readonly tolerance?: number;
}): Promise<CheckResult> => {
  const projectDir = realpathSync(resolve(options.projectDir));
  const entry = options.entry ?? "index.html";
  const lint = await lintProject(projectDir, entry);
  if (!lint.ok) return { ...lint, browserSkipped: true, samples: [] };
  const n = Math.max(1, options.samples ?? 9);
  const tolerance = options.tolerance ?? 2;
  const server = await serveProject(projectDir, { render: { fps: 30 } });
  const browser = await launchBrowser(options.env);
  const issues: PageIssue[] = [];
  let samples: number[] = [];
  let opened: Awaited<ReturnType<typeof openComposition>> | undefined;
  try {
    opened = await openComposition(browser, `${server.url}/${entry}`, { width: 1920, height: 1080 }).catch((error: unknown) => {
      issues.push({
        code: "composition_not_ready",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        fix: "Fix what it reports; the runtime must finish starting before anything renders.",
      });
      return undefined;
    });
    if (opened) {
      const manifest = (await opened.evaluate(() => window.__vd?.manifest())) as Manifest;
      await opened.setViewport({ width: manifest.width, height: manifest.height, deviceScaleFactor: 1 });
      if (!(manifest.duration > 0))
        issues.push({
          code: "no_duration",
          severity: "error",
          message: "The composition has no length.",
          fix: "Set data-duration on the root, or register a timeline or media that ends.",
        });
      for (const c of manifest.clips)
        if (c.end !== null && c.end > manifest.duration + 0.05)
          issues.push({
            code: "clip_ends_past_root_duration",
            severity: "warning",
            message: `${c.id ? `#${c.id}` : c.label} ends at ${c.end.toFixed(2)}s, after the composition's ${manifest.duration.toFixed(2)}s, so it is cut off.`,
            fix: "Extend the root's data-duration, or shorten the clip.",
          });
      issues.push(...(await opened.evaluate(clipTweens)));
      await opened.evaluate(`window.__vdLayout = ${layoutAt.toString()}`);
      samples = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * manifest.duration);
      const frames = new Set<string>();
      for (const t of samples) {
        const found = await opened.evaluate(
          async (time, tol) => {
            await window.__vd?.seek(time);
            return (window as unknown as { __vdLayout: (t: number, tol: number) => PageIssue[] }).__vdLayout(time, tol);
          },
          t,
          tolerance,
        );
        issues.push(...found);
        frames.add(Bun.hash(await opened.screenshot({ type: "jpeg", quality: 50 })).toString());
      }
      if (manifest.duration >= 3 && n > 1 && frames.size === 1)
        issues.push({
          code: "sweep_static",
          severity: "warning",
          message: `Every sampled frame (${n} across ${manifest.duration.toFixed(1)}s) looks the same: nothing moves.`,
          fix: "Check that the timeline is registered under the root's id and that clips have data-start.",
        });
    }
    for (const message of new Set(opened?.problems.errors))
      issues.push({ code: "console_error", severity: "error", message: `The page reported: ${message}`, fix: "Fix what it reports." });
    for (const url of new Set(opened?.problems.failedRequests))
      issues.push({
        code: "request_failed",
        severity: "error",
        message: `The page couldn't load ${url.replace(server.url, "")}.`,
        fix: "Fix the path, or add the file to the project.",
      });
  } finally {
    await browser.close().catch(() => undefined);
    server.stop();
  }
  const seen = new Set<string>();
  const findings: Finding[] = [...lint.findings];
  for (const i of issues) {
    const key = `${i.code}|${i.message.replace(/ at \d+\.\d+s/, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ code: i.code, severity: i.severity, message: i.message, fix: i.fix, file: entry });
  }
  return { ...summarize(findings, lint.files), browserSkipped: false, samples };
};
