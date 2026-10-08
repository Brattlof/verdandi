/** The in-page runtime and render clock as script text, built once per process from `src/runtime`. */
import { join } from "node:path";

const build = async (entry: string) => {
  const out = await Bun.build({
    entrypoints: [join(import.meta.dir, "../runtime", entry)],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!out.success || !out.outputs[0]) throw new Error(`Could not bundle the video runtime (${entry}): ${out.logs.join("\n")}`);
  // A literal `</script>` inside would end the inline script early.
  return (await out.outputs[0].text()).replaceAll("</script", "<\\/script");
};

let runtime: Promise<string> | undefined;
let clock: Promise<string> | undefined;

/** The runtime that mounts, times and seeks a composition (`window.__vd`). */
export const runtimeScript = () => {
  runtime ??= build("entry.ts");
  return runtime;
};

/** The render clock, which must run before any other script on the page. */
export const virtualTimeScript = () => {
  clock ??= build("virtual-time.ts");
  return clock;
};

/** GSAP's minified build, copied into projects so they render offline. */
export const gsapPath = () => Bun.resolveSync("gsap/dist/gsap.min.js", import.meta.dir);
