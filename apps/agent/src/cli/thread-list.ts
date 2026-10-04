import { describeCost, describeQuota, type ProjectSummary, type QuotaView, type ThreadSummary } from "@verdandi/contracts";

const resetTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO timestamp as `YYYY-MM-DD HH:MM` on this machine's clock, its local time zone. */
export const localMinute = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * `verdandi chat --list`: each harness's subscription window, then threads under their project, the folder
 * with the most recent activity first. Archived threads come only from `--list --archived`, marked as such.
 */
export const threadList = (
  projects: readonly ProjectSummary[],
  threads: readonly ThreadSummary[],
  quotas: readonly QuotaView[] = [],
  now = Date.now(),
) => {
  const quotaLines = quotas.length === 0 ? "" : `${quotas.map((q) => describeQuota(q, resetTime, now)).join("\n")}\n\n`;
  if (threads.length === 0) return `${quotaLines}No threads yet. Run verdandi chat in a folder to start one.\n`;
  const paths = new Map(projects.map((p) => [p.projectId, p.path]));
  const byProject = Map.groupBy(threads, (t) => t.projectId); // keeps the feed's most-recent-first order
  const list = [...byProject]
    .map(([projectId, ts]) => {
      const lines = ts.map((t) => {
        const cost = describeCost(t.cost);
        return `  ${t.threadId}  ${t.busy ? "busy" : t.archived ? "archived" : "idle"}  ${localMinute(t.lastActivityAt)}  ${t.job ? `[${t.job}] ` : ""}${t.title || "(no turns yet)"}${cost ? `  [${cost}]` : ""}`;
      });
      return `${paths.get(projectId) ?? projectId}\n${lines.join("\n")}\n`;
    })
    .join("\n");
  return `${quotaLines}${list}`;
};
