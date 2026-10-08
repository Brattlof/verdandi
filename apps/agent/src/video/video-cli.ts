import { join, resolve } from "node:path";
import {
  checkProject,
  type Format,
  findingsText,
  formats,
  initProject,
  inspect,
  lintProject,
  type Manifest,
  type Quality,
  qualities,
  type RenderProgress,
  type Resolution,
  render,
  resolutions,
  snapshot,
} from "@verdandi/video";
import { childEnv } from "../home/child-env.ts";
import { flag } from "../home/home.ts";

const oneOf = <T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T => {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")}; got "${value}".`);
};

const number = (name: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, e.g. ${name} 30; got "${value}".`);
  return n;
};

/** The first argument that isn't a flag or a flag's value: the project folder (default: the current folder). */
const positional = (argv: readonly string[], valued: readonly string[]) =>
  argv.find((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1] ?? ""));

const seconds = (s: number) => `${s.toFixed(2)}s`;

/** One line that rewrites itself on a terminal, so a long render shows where it is without scrolling. */
const progressLine = () => {
  const tty = process.stderr.isTTY;
  const labels = {
    open: "Opening composition",
    extract: "Decoding videos",
    audio: "Mixing audio",
    capture: "Capturing frame",
    encode: "Encoding",
  };
  let last = "";
  return (p: RenderProgress) => {
    const text = p.stage === "capture" ? `${labels.capture} ${p.done}/${p.total}` : labels[p.stage];
    if (!tty) {
      if (p.stage !== last) process.stderr.write(`${labels[p.stage]}…\n`);
      last = p.stage;
      return;
    }
    process.stderr.write(`\r\x1b[2K${text}`);
    if (p.stage === "encode") process.stderr.write("\n");
  };
};

/** Tracks and clips, one line per clip, as the Studio timeline lays them out. */
export const timelineText = (m: Manifest) => {
  const lines = [`${m.id || "composition"}  ${m.width}×${m.height}  ${seconds(m.duration)}`];
  const tracks = [...new Set(m.clips.map((c) => c.track))].sort((a, b) => a - b);
  for (const track of tracks) {
    lines.push(`track ${track}`);
    for (const c of m.clips.filter((x) => x.track === track).sort((a, b) => a.start - b.start))
      lines.push(
        `  ${seconds(c.start).padStart(8)} → ${(c.end === null ? "end" : seconds(c.end)).padEnd(8)} ${c.kind.padEnd(11)} ${c.id ?? c.label}${c.hidden ? "  (hidden)" : ""}`,
      );
  }
  return `${lines.join("\n")}\n`;
};

const subcommands: Record<string, (argv: readonly string[]) => Promise<void>> = {
  async init(argv) {
    const dir = positional(argv, ["--resolution"]);
    if (!dir) throw new Error("Name the new project's folder, e.g. verdandi video init my-video.");
    const resolution = oneOf("--resolution", flag(argv, "--resolution"), Object.keys(resolutions) as Resolution[], "landscape");
    const project = initProject(dir, { resolution });
    console.log(
      `Created ${project.dir} (${project.width}×${project.height}).\nNext: edit index.html, then verdandi video snapshot ${dir} --at 1 and verdandi video render ${dir}`,
    );
  },

  async render(argv) {
    const valued = ["--output", "-o", "--format", "--quality", "--fps", "--crf", "--entry", "--variables"];
    const dir = resolve(positional(argv, valued) ?? ".");
    const format = oneOf("--format", flag(argv, "--format"), formats, "mp4");
    const quality = oneOf("--quality", flag(argv, "--quality"), qualities, "standard");
    const variables = flag(argv, "--variables");
    const ext = format === "png-sequence" ? "" : `.${format}`;
    const output = resolve(
      flag(argv, "--output") ?? flag(argv, "-o") ?? join(dir, "renders", `${dir.split(/[\\/]/).pop() || "video"}${ext}`),
    );
    const fps = number("--fps", flag(argv, "--fps"));
    const crf = number("--crf", flag(argv, "--crf"));
    const entry = flag(argv, "--entry");
    const started = performance.now();
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort(new Error("Render cancelled.")));
    const result = await render({
      projectDir: dir,
      output,
      format: format as Format,
      quality: quality as Quality,
      env: childEnv(),
      signal: controller.signal,
      onProgress: progressLine(),
      ...(fps !== undefined && { fps }),
      ...(crf !== undefined && { crf }),
      ...(entry && { entry }),
      ...(variables && { variables: JSON.parse(variables) as Record<string, unknown> }),
    });
    const t = result.timings;
    const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;
    console.log(
      `${result.output}\n  ${result.width}×${result.height} · ${seconds(result.duration)} · ${result.frames} frames · rendered in ${ms(performance.now() - started)}\n  open ${ms(t.open)} · decode ${ms(t.extract)} · audio ${ms(t.audio)} · capture ${ms(t.capture)} · encode ${ms(t.encode)}`,
    );
  },

  async snapshot(argv) {
    const dir = resolve(positional(argv, ["--at", "--frames", "--output", "-o", "--entry"]) ?? ".");
    const at = flag(argv, "--at");
    const entry = flag(argv, "--entry");
    let times = at?.split(",").map((s) => number("--at", s.trim()) ?? 0);
    if (!times) {
      const n = number("--frames", flag(argv, "--frames")) ?? 5;
      const { duration } = await inspect({ projectDir: dir, env: childEnv(), ...(entry && { entry }) });
      // Evenly spaced, the last moved just inside the end so it isn't the blank after the final clip.
      times = Array.from({ length: n }, (_, i) => (n === 1 ? 0 : (i / (n - 1)) * (duration - Math.max(0.05, duration * 0.03))));
    }
    const { files } = await snapshot({
      projectDir: dir,
      times,
      outDir: resolve(flag(argv, "--output") ?? flag(argv, "-o") ?? join(dir, "snapshots")),
      env: childEnv(),
      ...(entry && { entry }),
    });
    console.log(files.join("\n"));
  },

  async lint(argv) {
    const dir = resolve(positional(argv, ["--entry"]) ?? ".");
    const result = await lintProject(dir, flag(argv, "--entry"));
    process.stdout.write(
      argv.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : findingsText(result, argv.includes("--verbose")),
    );
    if (!result.ok) process.exitCode = 1;
  },

  async check(argv) {
    const dir = resolve(positional(argv, ["--entry", "--samples"]) ?? ".");
    const entry = flag(argv, "--entry");
    const samples = number("--samples", flag(argv, "--samples"));
    const result = await checkProject({
      projectDir: dir,
      env: childEnv(),
      ...(entry && { entry }),
      ...(samples !== undefined && { samples }),
    });
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(findingsText(result, argv.includes("--verbose")));
      if (result.browserSkipped) process.stdout.write("Skipped the browser pass: fix the lint errors first.\n");
    }
    const strict = argv.includes("--strict");
    if (!result.ok || (strict && result.warnings > 0)) process.exitCode = 1;
  },

  async timeline(argv) {
    const dir = resolve(positional(argv, ["--entry"]) ?? ".");
    const entry = flag(argv, "--entry");
    const manifest = await inspect({ projectDir: dir, env: childEnv(), ...(entry && { entry }) });
    process.stdout.write(argv.includes("--json") ? `${JSON.stringify(manifest, null, 2)}\n` : timelineText(manifest));
  },
};

/** `verdandi video <init|render|snapshot|timeline> …`: make videos from HTML compositions. */
export const video = async (argv: readonly string[]) => {
  const [name, ...rest] = argv;
  const sub = subcommands[name ?? ""];
  if (!sub) throw new Error(`Usage: verdandi video ${Object.keys(subcommands).join("|")} … (see verdandi help).`);
  await sub(rest);
};
