import { join, resolve } from "node:path";
import {
  addBlock,
  checkProject,
  type Format,
  findingsText,
  formats,
  initProject,
  inspect,
  installSkills,
  lintProject,
  listBlocks,
  type Manifest,
  type Quality,
  qualities,
  type RenderProgress,
  type Resolution,
  removeSkills,
  render,
  resolutions,
  searchBlocks,
  snapshot,
} from "@verdandi/video";
import { web } from "../cli/web.ts";
import { childEnv } from "../home/child-env.ts";
import { flag, resolveHome } from "../home/home.ts";

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
      `Created ${project.dir} (${project.width}×${project.height}).\nNext: edit index.html, then verdandi video check ${dir} and verdandi video snapshot ${dir} --at 1 to look at it; render (verdandi video render ${dir}) once it's right.`,
    );
  },

  async render(argv) {
    const valued = ["--output", "-o", "--format", "--quality", "--fps", "--crf", "--entry", "--variables", "--workers"];
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
    const workers = number("--workers", flag(argv, "--workers"));
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
      ...(workers !== undefined && { workers }),
      ...(entry && { entry }),
      ...(variables && { variables: JSON.parse(variables) as Record<string, unknown> }),
    });
    const t = result.timings;
    const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;
    console.log(
      `${result.output}\n  ${result.width}×${result.height} · ${seconds(result.duration)} · ${result.frames} frames · rendered in ${ms(performance.now() - started)} · ${result.workers} worker${result.workers === 1 ? "" : "s"}\n  open ${ms(t.open)} · decode ${ms(t.extract)} · audio ${ms(t.audio)} · capture ${ms(t.capture)} · encode ${ms(t.encode)}`,
    );
  },

  async snapshot(argv) {
    // `--at 1,2.5` or `--at 1 2.5`: the numbers right after --at are times, never the project folder.
    const atIndex = argv.findIndex((a) => a === "--at" || a.startsWith("--at="));
    const timeArgs: string[] = [];
    if (atIndex !== -1) {
      const first = argv[atIndex]?.startsWith("--at=") ? argv[atIndex]?.slice(5) : argv[atIndex + 1];
      if (!first) throw new Error("--at needs times, e.g. --at 1,2.5");
      timeArgs.push(first);
      for (let i = atIndex + (argv[atIndex]?.startsWith("--at=") ? 1 : 2); /^\d*\.?\d+(?:,\d*\.?\d+)*$/.test(argv[i] ?? ""); i++)
        timeArgs.push(argv[i] ?? "");
    }
    const rest = argv.filter((_, i) => i < atIndex || i > atIndex + timeArgs.length || atIndex === -1);
    const dir = resolve(positional(rest, ["--frames", "--output", "-o", "--entry"]) ?? ".");
    const entry = flag(argv, "--entry");
    let times = timeArgs.length ? timeArgs.flatMap((a) => a.split(",")).map((s) => number("--at", s.trim()) ?? 0) : undefined;
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
      process.stdout.write(
        result.browserSkipped
          ? "Skipped the browser pass: fix the lint errors first.\n"
          : `Ran it in Chrome at ${result.samples.map((t) => `${t}s`).join(", ")}.\n`,
      );
    }
    const strict = argv.includes("--strict");
    if (!result.ok || (strict && result.warnings > 0)) process.exitCode = 1;
  },

  async add(argv) {
    const valued = ["--project", "--vars"];
    const name = positional(argv, valued);
    if (!name) throw new Error("Name the block to add, e.g. verdandi video add lower-third (list them with verdandi video catalog).");
    const vars = flag(argv, "--vars");
    const result = addBlock(resolve(flag(argv, "--project") ?? "."), name, {
      force: argv.includes("--force"),
      ...(vars && { values: JSON.parse(vars) as Record<string, unknown> }),
    });
    console.log(
      `Added ${result.block.title}:\n${result.files.map((f) => `  ${f}`).join("\n")}\nMount it in a composition, then set data-start:\n${result.snippet}`,
    );
  },

  async catalog(argv) {
    const query = argv.filter((a) => !a.startsWith("--")).join(" ");
    const blocks = query ? searchBlocks(query) : listBlocks();
    if (argv.includes("--json")) return void process.stdout.write(`${JSON.stringify(blocks, null, 2)}\n`);
    if (!blocks.length) return void console.log(query ? `No block matches "${query}".` : "No blocks.");
    for (const b of blocks)
      console.log(
        `${b.name.padEnd(24)} ${`${b.duration}s`.padStart(5)}  ${b.title}: ${b.description} [${b.tags.join(", ")}]${b.variables?.length ? `\n${" ".repeat(32)}variables (--vars): ${b.variables.map((v) => `${v.id}=${JSON.stringify(v.default)}`).join(", ")}` : ""}`,
      );
  },

  async skills(argv) {
    const target = join(resolveHome(argv), "skills");
    if (argv.includes("--remove")) {
      const { removed, kept } = removeSkills(target, { force: argv.includes("--force") });
      console.log(
        [
          removed.length ? `Removed ${removed.join(", ")} from ${target}.` : "No video skills to remove.",
          ...(kept.length ? [`Kept your edited ${kept.join(", ")}; pass --force to remove ${kept.length === 1 ? "it" : "them"} too.`] : []),
        ].join("\n"),
      );
      return;
    }
    const { added, updated, kept } = installSkills(target, { force: argv.includes("--force") });
    const lines = [
      ...(added.length ? [`Installed ${added.join(", ")}.`] : []),
      ...(updated.length ? [`Replaced ${updated.join(", ")}.`] : []),
      ...(kept.length
        ? [`Kept your edited ${kept.join(", ")}; pass --force to replace ${kept.length === 1 ? "it" : "them"} with Verdandi's.`]
        : []),
    ];
    console.log(
      lines.length
        ? `${lines.join("\n")}\nThey are in ${target}; agents in new sessions see them.`
        : `The video skills in ${target} are up to date.`,
    );
  },

  async preview(argv) {
    const valued = ["--home", "--port", "--host"];
    const at = argv.findIndex((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1] ?? ""));
    const dir = resolve(at === -1 ? "." : (argv[at] ?? "."));
    await lintProject(dir); // fails fast, naming the fix, when this isn't a project
    await web(
      argv.filter((_, i) => i !== at),
      new URLSearchParams({ view: "video", project: dir }).toString(),
    );
  },

  async present(argv) {
    const valued = ["--home", "--port", "--host"];
    const at = argv.findIndex((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1] ?? ""));
    const dir = resolve(at === -1 ? "." : (argv[at] ?? "."));
    await lintProject(dir);
    await web(
      argv.filter((_, i) => i !== at),
      new URLSearchParams({ view: "video", project: dir, present: "1" }).toString(),
    );
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
