// Manual live check, not a test: makes real Claude Code calls on your subscription.
// Runs one Haiku turn, a resumed second turn, a steered third turn and a planned fourth turn in a temp
// folder, printing the normalized events. The third turn should end with STEERED; the fourth should
// propose two plans, the first rejected with feedback, and end with greeting.txt created. The fifth
// delegates to a subagent, whose steps should carry parentToolUseId. The sixth delegates to a background
// subagent: its steps and the reply to them should arrive before the turn's turn.finished.
//   bun packages/harness-claude-code/src/smoke.ts
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessEvent, InteractionMode, Resolution, ThreadId, TurnId } from "@verdandi/contracts";
import { Effect, Stream } from "effect";
import { findClaude, makeClaudeCodeAdapter } from "./adapter.ts";

const claudePath = findClaude();
if (!claudePath) throw new Error("Claude Code CLI not found on PATH. Install it and run `claude` once to log in.");
const cwd = mkdtempSync(join(tmpdir(), "verdandi smoke "));
const route = { harness: "claude-code", model: "haiku", effort: "low" } as const;
const threadId = crypto.randomUUID() as ThreadId;
let sessionId: string | undefined;
let transcriptPath: string | undefined;
let subagentSteps = 0;

// The first plan is rejected with feedback and later ones approved; tool approvals are allowed (it's a temp folder).
let plans = 0;
const answer = (e: HarnessEvent): Resolution | undefined => {
  if (e.type === "plan.requested") {
    return ++plans === 1 ? { decision: "deny", feedback: "Name the file greeting.txt instead." } : { decision: "allow" };
  }
  return e.type === "approval.requested" ? { decision: "allow" } : undefined;
};

const turn = (
  text: string,
  adapter: HarnessAdapter = makeClaudeCodeAdapter({ claudePath }),
  steers: Stream.Stream<string> = Stream.empty,
  mode: InteractionMode = "build",
) =>
  Effect.runPromise(
    adapter.run({ threadId, cwd, route, resumeSessionId: sessionId, turnId: crypto.randomUUID() as TurnId, text, mode, steers }).pipe(
      Stream.runForEach((e: HarnessEvent) => {
        if (e.type === "session.started") ({ sessionId, transcriptPath } = e);
        if (e.type === "item" && "parentToolUseId" in e.item) subagentSteps++;
        console.log(e.type === "text.delta" ? `  delta ${JSON.stringify(e.text)}` : `  ${JSON.stringify(e)}`);
        const resolution = answer(e);
        return resolution && "requestId" in e ? adapter.respond(threadId, e.requestId, resolution) : Effect.void;
      }),
    ),
  );

console.log(`claude: ${claudePath}\ncwd: ${cwd}\n-- turn 1`);
await turn("Remember the code word ZEBRA-42. Reply with exactly: OK");
console.log("-- turn 2, new adapter (as after a verdandid restart), resuming");
await turn("What was the code word? Reply with only the code word.");
console.log("-- turn 3, steered while it runs; its tool call is the boundary the steer lands at");
const later = Stream.fromEffect(Effect.as(Effect.sleep("1 second"), "Change of plan: reply with exactly STEERED instead of DONE."));
await turn(
  "Use the Bash tool to run `echo hi`. Whatever happens, then reply with exactly: DONE",
  makeClaudeCodeAdapter({ claudePath }),
  later,
);
console.log("-- turn 4, plan mode: the first plan is rejected with feedback, the second approved and built");
await turn(
  "Create a file named hello.txt containing the word hi. Propose a one-line plan first.",
  makeClaudeCodeAdapter({ claudePath }),
  Stream.empty,
  "plan",
);
console.log(`plans proposed: ${plans}, greeting.txt created: ${existsSync(join(cwd, "greeting.txt"))}`);
console.log("-- turn 5, a subagent");
// In the foreground: a background subagent reports after the turn has ended.
await turn(
  "Use the Agent tool with run_in_background: false to have a general-purpose subagent run `echo hi` with Bash and wait for it. Then reply with exactly: DONE",
);
console.log(
  `subagent steps: ${subagentSteps}, transcript: ${transcriptPath} (exists: ${transcriptPath ? existsSync(transcriptPath) : false})`,
);
console.log("-- turn 6, a background subagent");
subagentSteps = 0;
await turn(
  "Use the Agent tool with run_in_background: true to have a general-purpose subagent run `sleep 3; echo hi` with Bash. Do not wait for it: reply with exactly LAUNCHED now, and once it reports, reply with exactly: DONE",
);
console.log(`background subagent steps in the turn: ${subagentSteps}`);
// Each turn's adapter keeps its Claude Code process open, which would keep Bun running.
process.exit(0);
