// Manual live check, not a test: makes real Claude Code calls on your subscription.
// Runs one Haiku turn, a resumed second turn and a steered third turn in a temp folder, printing the
// normalized events. The third turn should end with STEERED.
//   bun packages/harness-claude-code/src/smoke.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, ThreadId, TurnId } from "@verdandi/contracts";
import { Effect, Stream } from "effect";
import { findClaude, makeClaudeCodeAdapter } from "./adapter.ts";

const claudePath = findClaude();
if (!claudePath) throw new Error("Claude Code CLI not found on PATH. Install it and run `claude` once to log in.");
const cwd = mkdtempSync(join(tmpdir(), "verdandi smoke "));
const route = { harness: "claude-code", model: "haiku", effort: "low" } as const;
const threadId = crypto.randomUUID() as ThreadId;
let sessionId: string | undefined;

const turn = (text: string, adapter = makeClaudeCodeAdapter({ claudePath }), steers: Stream.Stream<string> = Stream.empty) =>
  Effect.runPromise(
    adapter.run({ threadId, cwd, route, resumeSessionId: sessionId, turnId: crypto.randomUUID() as TurnId, text, steers }).pipe(
      Stream.runForEach((e: HarnessEvent) =>
        Effect.sync(() => {
          if (e.type === "session.started") sessionId = e.sessionId;
          console.log(e.type === "text.delta" ? `  delta ${JSON.stringify(e.text)}` : `  ${JSON.stringify(e)}`);
        }),
      ),
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
