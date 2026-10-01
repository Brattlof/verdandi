import type { SessionHit } from "@verdandi/contracts";
import { Effect } from "effect";
import { flag, readServerFile, resolveHome } from "../config/home.ts";
import { projectIdFor } from "../orchestration/decider.ts";
import { connect } from "../rpc/client.ts";
import { resolveProjectPath } from "../workspace/project.ts";

/** One hit per block: where it is, then the text around the match, the match in brackets. */
export const hitsText = (query: string, hits: readonly SessionHit[]) => {
  if ([...query.trim()].length < 3) return "Search for at least 3 characters.\n";
  if (hits.length === 0) return `Nothing in past sessions matches "${query}".\n`;
  const who = { user: "you", steer: "you, steering", assistant: "agent" } as const;
  return hits
    .map((h) => {
      const where = `${h.at.slice(0, 16).replace("T", " ")}  ${h.title || "New thread"}${h.archived ? " (archived)" : ""}  ${h.projectPath}`;
      const text = h.parts
        .map((p) => (p.match ? `[${p.text}]` : p.text))
        .join("")
        .replace(/\s+/g, " ");
      return `${where}\n  ${who[h.kind]}: ${text}\n  verdandi chat --thread ${h.threadId}\n`;
    })
    .join("\n");
};

/** `verdandi search <query> [--project <path>]`: past sessions' messages containing the query, newest first. */
export const search = async (argv: readonly string[]) => {
  const server = readServerFile(resolveHome(argv));
  const project = flag(argv, "--project");
  // The query is every word that isn't a flag or the value after `--home` or `--project` (`--project=<path>` is one word).
  const query = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--home" && argv[i - 1] !== "--project").join(" ");
  if (!query) throw new Error('Name what to search for, e.g. verdandi search "ENOENT on Windows".');
  const projectId = project === undefined ? undefined : projectIdFor(await Effect.runPromise(resolveProjectPath(project)));
  const hits = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(connect(server), (client) => client.SessionSearch({ query, ...(projectId && { projectId }) }))),
  );
  process.stdout.write(hitsText(query, hits));
};
