import { Effect } from "effect";
import { projectIdFor } from "../event-store/decider.ts";
import { flag, resolveHome } from "../home/home.ts";
import { resolveProjectPath } from "../projects/project.ts";
import { exportTrajectories, trajectorySettingsFile } from "./trajectory-export.ts";

const usage =
  "Usage: verdandi trajectories export --format jsonl|routing [--project <path>] [--since <date>] [--out <file>] [--home <dir>]";

/** `--since 2026-09-01` is local midnight that day; an ISO time is taken as written. */
const parseSince = (since: string) => {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00` : since);
  if (Number.isNaN(date.getTime())) throw new Error(`--since takes a date like 2026-09-01 or an ISO time, not "${since}".`);
  return date;
};

/** `verdandi trajectories export`: saved tasks as message JSONL or a routing dataset, to `--out` or stdout. */
export const trajectories = async (argv: readonly string[]) => {
  if (argv[0] !== "export") throw new Error(usage);
  const format = flag(argv, "--format");
  if (format !== "jsonl" && format !== "routing") throw new Error(`--format must be jsonl or routing.\n${usage}`);
  const home = resolveHome(argv);
  const project = flag(argv, "--project");
  const since = flag(argv, "--since");
  const out = flag(argv, "--out");
  const { lines, excluded } = exportTrajectories(home, {
    format,
    ...(project === undefined ? {} : { projectId: projectIdFor(await Effect.runPromise(resolveProjectPath(project))) }),
    ...(since === undefined ? {} : { since: parseSince(since) }),
  });
  if (out === undefined) process.stdout.write(lines.join(""));
  else await Bun.write(out, lines.join(""));
  process.stderr.write(
    `Exported ${lines.length} task${lines.length === 1 ? "" : "s"}${out === undefined ? "" : ` to ${out}`}.` +
      (excluded ? ` Left out ${excluded} from projects excluded in ${trajectorySettingsFile(home)}.` : "") +
      "\n",
  );
};
