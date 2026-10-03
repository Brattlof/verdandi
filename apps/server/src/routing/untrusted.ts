import { type HarnessId, handedSourceLabel, type Item, type TurnId, type UntrustedInput } from "@verdandi/contracts";

/**
 * Tools whose results come from the network (DESIGN §17): Claude Code's, and the native harness's once it has them
 * (§9.6). A shell command that fetches (`curl` in Bash) can't be told apart reliably, so it isn't one, and tools
 * from the user's own MCP servers are trusted like the shell.
 */
const NETWORK_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch", "web_fetch", "web_search"]);

/**
 * Pure: the untrusted input an item of a turn brings in, or undefined, the same way for every harness. From the first
 * one on, the rest of the turn is tainted, and the session holds untrusted input.
 */
export const untrustedSource = (item: Item): string | undefined =>
  item.kind === "tool.call" && NETWORK_TOOLS.has(item.name)
    ? item.name
    : item.kind === "injection"
      ? `${handedSourceLabel[item.source]}, flagged as an injection`
      : undefined;

/**
 * Whether a harness's sessions have tools that write files or run commands, so untrusted input in one can do harm and
 * holds its route at the policy's floor. The native harness has neither yet (#178, #179).
 */
const canHarm: Record<HarnessId, boolean> = { "claude-code": true, native: false, fake: true };

/**
 * Pure: the first untrusted input the thread's warm session on `harness` took in, from `turns` (the thread's, oldest
 * first, each with its own first source): those from `sessionFirstTurn` on (all, when unknown) that weren't forked
 * away. Undefined without a session, or on a harness whose sessions can't do harm with it.
 */
export const sessionUntrusted = (
  turns: readonly { readonly turnId: TurnId; readonly reverted: 0 | 1 | 2; readonly untrusted: string | null }[],
  session: { readonly harness: HarnessId; readonly sessionId: string | null; readonly sessionFirstTurn: TurnId | null },
): UntrustedInput | undefined => {
  if (session.sessionId === null || !canHarm[session.harness]) return undefined;
  const from = Math.max(
    0,
    turns.findIndex((t) => t.turnId === session.sessionFirstTurn),
  );
  const index = turns.findIndex((t, i) => i >= from && t.reverted !== 2 && t.untrusted !== null);
  const source = turns[index]?.untrusted;
  return source ? { source, turn: index + 1 } : undefined;
};
