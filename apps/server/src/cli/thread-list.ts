import type { ProjectSummary, ThreadSummary } from "@verdandi/contracts";

/** `verdandi chat --list`: threads under their project, the folder with the most recent activity first. */
export const threadList = (projects: readonly ProjectSummary[], threads: readonly ThreadSummary[]) => {
  if (threads.length === 0) return "No threads yet. Run verdandi chat in a folder to start one.\n";
  const paths = new Map(projects.map((p) => [p.projectId, p.path]));
  const byProject = Map.groupBy(threads, (t) => t.projectId); // keeps the feed's most-recent-first order
  return [...byProject]
    .map(([projectId, ts]) => {
      const lines = ts.map(
        (t) =>
          `  ${t.threadId}  ${t.busy ? "busy" : "idle"}  ${t.lastActivityAt.slice(0, 16).replace("T", " ")}  ${t.title || "(no turns yet)"}`,
      );
      return `${paths.get(projectId) ?? projectId}\n${lines.join("\n")}\n`;
    })
    .join("\n");
};
