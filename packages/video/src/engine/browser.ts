/**
 * Headless Chrome for rendering, snapshots and checks: `VERDANDI_CHROME` when set, else the installed Chrome stable.
 * Flags keep frames deterministic (sRGB, no hinting, scale 1) and stop Chrome throttling a page nobody looks at.
 */
import puppeteer, { type Browser, type LaunchOptions, type Page } from "puppeteer-core";

const flags = (width: number, height: number) => [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--font-render-hinting=none",
  "--force-color-profile=srgb",
  "--force-device-scale-factor=1",
  `--window-size=${width},${height}`,
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-media-suspend",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-extensions",
  "--disable-sync",
  "--disable-component-update",
  "--disable-default-apps",
  "--no-first-run",
  "--hide-scrollbars",
  "--mute-audio",
  "--enable-webgl",
  "--ignore-gpu-blocklist",
];

/** The environment for processes the engine starts: the caller's, without Verdandi's secrets (`childEnv()`). */
export type Env = Readonly<Record<string, string | undefined>>;

/** Launches Chrome with `env`; the error says how to point Verdandi at one when none is found. */
export const launchBrowser = async (env: Env, width = 1920, height = 1080): Promise<Browser> => {
  const executablePath = env.VERDANDI_CHROME;
  const options: LaunchOptions = {
    headless: true,
    args: flags(width, height),
    defaultViewport: null,
    env: { ...env },
    protocolTimeout: 300_000,
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
  };
  try {
    return await puppeteer.launch(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `Could not start Chrome (${reason}). Install Google Chrome, or set VERDANDI_CHROME to the path of a Chrome or Chromium binary.`,
    );
  }
};

/** What went wrong on a page, collected for its whole life (from before it loads): read by `check`. */
export type PageProblems = { readonly errors: string[]; readonly warnings: string[]; readonly failedRequests: string[] };

/**
 * Opens `url` at the composition's size and waits for the runtime's `window.__vd.ready`. A page that never gets ready
 * fails naming why: the runtime's own error, or what the page logged.
 */
export const openComposition = async (
  browser: Browser,
  url: string,
  size: { width: number; height: number },
  timeoutMs = 60_000,
): Promise<Page & { readonly problems: PageProblems }> => {
  const page = await browser.newPage();
  const problems: PageProblems = { errors: [], warnings: [], failedRequests: [] };
  page.on("console", (m) => {
    // A failed load logs this too; it is reported once, as a failed request.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.errors.push(m.text());
    else if (m.type() === "warn") problems.warnings.push(m.text());
  });
  page.on("pageerror", (e) => problems.errors.push(`uncaught: ${e instanceof Error ? e.message : String(e)}`));
  const failed = (url: string, reason: string) => {
    // Chrome asks for /favicon.ico on its own; a composition never needs one.
    if (url.startsWith("data:") || new URL(url).pathname === "/favicon.ico") return;
    if (!problems.failedRequests.some((f) => f.startsWith(`${url} (`))) problems.failedRequests.push(`${url} (${reason})`);
  };
  page.on("requestfailed", (r) => failed(r.url(), r.failure()?.errorText ?? "failed"));
  page.on("response", (r) => {
    if (r.status() >= 400) failed(r.url(), `HTTP ${r.status()}`);
  });
  const tail = () => {
    const lines = [...problems.errors, ...problems.failedRequests.map((f) => `failed to load ${f}`)].slice(-10);
    return lines.length ? `\n${lines.join("\n")}` : "";
  };
  await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  try {
    await page.waitForFunction(() => window.__vd?.ready || window.__vd?.error, { timeout: timeoutMs, polling: 50 });
  } catch {
    throw new Error(`The composition at ${url} never became ready in ${timeoutMs / 1000}s.${tail()}`);
  }
  const error = await page.evaluate(() => window.__vd?.error);
  if (error) throw new Error(`The composition failed to start: ${error}${tail()}`);
  return Object.assign(page, { problems });
};
