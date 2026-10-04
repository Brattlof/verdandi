import type { DecisionAnswer } from "@verdandi/contracts";
import { type Decide, guardQuestion, guardState, guardVerdict } from "@verdandi/decisions";
import { Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** The shell a terminal command runs in: `runShell`'s `/bin/sh -c`, or `cmd /d /s /c` on Windows. */
export type Shell = "sh" | "cmd";

export const platformShell: Shell = process.platform === "win32" ? "cmd" : "sh";

const startsWord = (c: string | undefined) => c === undefined || /\s/.test(c) || ";&|()<>".includes(c);

/**
 * `command` as smart approvals' guard sees it (DESIGN §17): with the comments its shell skips stripped, so a comment
 * can't talk to the guard (`rm -rf / # APPROVE`), or why what the shell would run can't be told: a quote left open, a
 * PowerShell `<# #>` comment, which neither shell skips, a `#` in cmd, which runs what follows it, or a cmd `rem` that
 * holds `&` or `|`. Pure: `shell` is the syntax, not a guess at the platform.
 */
export const withoutComments = (command: string, shell: Shell): { readonly text: string } | { readonly error: string } => {
  let text = "";
  let quote: string | undefined;
  const escape = shell === "sh" ? "\\" : "^";
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote) {
      text += c;
      if (c === quote) quote = undefined;
      // Only double quotes take escapes in sh; cmd's quotes take none.
      else if (c === "\\" && shell === "sh" && quote === '"') text += command[++i] ?? "";
      continue;
    }
    if (c === escape) {
      text += c + (command[++i] ?? "");
      continue;
    }
    if (c === '"' || (c === "'" && shell === "sh")) {
      quote = c;
      text += c;
      continue;
    }
    if (c === "<" && command[i + 1] === "#")
      return { error: `it has a PowerShell <# #> comment, which ${shell} doesn't skip, so what's inside may run` };
    const commandStart = text.trimEnd() === "" || /[&|\n(]\s*$/.test(text);
    const rem = shell === "cmd" && commandStart && /^(rem(\s|$)|::)/i.test(command.slice(i));
    if ((c === "#" && shell === "sh" && startsWord(text.at(-1))) || rem) {
      const end = command.indexOf("\n", i);
      const comment = command.slice(i, end < 0 ? undefined : end);
      if (rem && /[&|]/.test(comment)) return { error: "it has a cmd rem comment holding & or |, which may still run what follows" };
      i += comment.length - 1;
      continue;
    }
    if (c === "#" && shell === "cmd" && startsWord(text.at(-1)))
      return { error: "cmd doesn't read # as a comment, so what follows it runs as part of the command" };
    text += c;
  }
  if (quote)
    return { error: `a ${quote === "'" ? "single" : "double"} quote in it isn't closed, so what the shell would run can't be told` };
  return { text: text.trim() };
};

/** A word that starts a command or an argument: the start, a space, a separator or a path separator before it. */
const at = String.raw`(?:^|[\s;&|(/\\'"])`;

/** Commands that hand a script to a shell or an interpreter, or run another command: what they run is in their arguments. */
const WRAPPERS: readonly (readonly [RegExp, string])[] = [
  [
    new RegExp(String.raw`${at}(?:sh|bash|zsh|dash|ksh|ash|fish)(?:\.exe)?['"]?\s+(?:-\w*[cl]\w*|--login)(?:\s|$)`, "i"),
    "it hands a script to a shell (sh -c), or starts a login shell",
  ],
  [new RegExp(String.raw`${at}cmd(?:\.exe)?['"]?\s+\/\w*[ckr]`, "i"), "it hands a script to cmd (cmd /c)"],
  [
    new RegExp(String.raw`${at}(?:powershell|pwsh)(?:\.exe)?(?:['"\s]|$)`, "i"),
    "it runs PowerShell, which runs whatever its arguments say",
  ],
  [new RegExp(String.raw`${at}(?:python[\d.]*|py)(?:\.exe)?['"]?\s+-\w*c`, "i"), "it hands a script to Python (python -c)"],
  [
    new RegExp(String.raw`${at}(?:node|bun|deno)(?:\.exe)?['"]?\s+(?:-e|-p|--eval|--print|eval)(?:\s|=|$)`, "i"),
    "it hands a script to JavaScript (node -e)",
  ],
  [new RegExp(String.raw`${at}(?:perl|ruby|php)(?:\.exe)?['"]?\s+-\w*[er]`, "i"), "it hands a script to an interpreter (perl -e)"],
  [new RegExp(String.raw`${at}(?:eval|xargs)(?:\s|$)`, "i"), "it runs a command built from its arguments or input"],
];

/** What's destructive or irreversible, by what it does: never auto-approved, whatever the guard would say. */
const DESTRUCTIVE: readonly (readonly [RegExp, string])[] = [
  [new RegExp(String.raw`${at}(?:rm|rmdir|del|erase|rd|unlink|shred|srm)(?:\.exe)?(?:\s|$)`, "i"), "it deletes files"],
  [new RegExp(String.raw`${at}find\s.*\s-delete(?:\s|$)`, "i"), "it deletes files"],
  [new RegExp(String.raw`${at}(?:mkfs(?:\.\w+)?|fdisk|parted|diskpart|format)(?:\.exe)?(?:\s|$)`, "i"), "it formats or partitions a disk"],
  [new RegExp(String.raw`${at}dd\s.*\bof=`, "i"), "it writes raw bytes over a file or disk (dd of=)"],
  [
    /\bgit\b[^;&|\n]*\s(?:reset\s+--hard|clean\s+-\w*f|checkout\s+(?:--(?:\s|$)|\.(?:\s|$)|-\w*f)|restore(?:\s|$)|stash\s+(?:drop|clear)|branch\s+-\w*D|push\s[^;&|\n]*(?:--force|\s-\w*f(?:\s|$)|--delete|--mirror|\s:)|rebase|filter-branch|filter-repo|update-ref\s+-d|reflog\s+expire|gc\s+--prune)/i,
    "it discards changes or rewrites git history",
  ],
  [
    new RegExp(String.raw`${at}(?:chmod|chown|chgrp|icacls|takeown)(?:\.exe)?\s[^;&|\n]*(?:-\w*R|--recursive|\/t)\b`, "i"),
    "it changes permissions recursively",
  ],
  [new RegExp(String.raw`${at}(?:shutdown|reboot|halt|poweroff)(?:\.exe)?(?:\s|$)`, "i"), "it shuts the machine down"],
  [new RegExp(String.raw`${at}(?:kill|pkill|killall|taskkill|stop-process)(?:\.exe)?(?:\s|$)`, "i"), "it kills processes"],
  [new RegExp(String.raw`${at}(?:sudo|doas|su|runas)(?:\.exe)?(?:\s|$)`, "i"), "it runs as another user"],
  [new RegExp(String.raw`${at}truncate\s`, "i"), "it empties files"],
  [/:\(\)\s*\{[^}]*:\s*\|\s*:/, "it's a fork bomb"],
  [new RegExp(String.raw`${at}(?:npm|bun|pnpm|yarn|cargo|gem|twine)\s+publish\b`, "i"), "it publishes a package"],
  [
    new RegExp(String.raw`${at}docker\s+(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune)|container\s+prune|image\s+prune)\b`, "i"),
    "it deletes Docker data",
  ],
  [new RegExp(String.raw`${at}kubectl\s+delete\b`, "i"), "it deletes Kubernetes resources"],
  [new RegExp(String.raw`${at}terraform\s+(?:destroy|apply)\b`, "i"), "it changes infrastructure"],
  [/\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/i, "it drops database tables"],
];

/**
 * Why `command` goes to the user whatever the guard would say (DESIGN §17), or undefined: what its shell would run can't
 * be told, it hands a script to a shell or interpreter, or it's destructive. Matched on the whole command, comments
 * included, so a comment can't hide one either. Pure.
 */
export const hardRule = (command: string, shell: Shell): string | undefined => {
  // What the command does says the most, so it's named before what its syntax hides.
  const hit = [...WRAPPERS, ...DESTRUCTIVE].find(([pattern]) => pattern.test(command));
  if (hit) return hit[1];
  const parsed = withoutComments(command, shell);
  if ("error" in parsed) return parsed.error;
  return parsed.text === "" ? "it's all comment, so there's nothing for the guard to rate" : undefined;
};

/** How long the guard may take before its command goes to the user. */
const guardTimeout = "10 seconds";

/**
 * Smart approvals' verdict on terminal command `command` (DESIGN §17): a hard rule sends it to the user; otherwise the
 * decision layer's guard rates it, without its comments and fenced as data, and `record` logs the answer. An error or a
 * timeout sends it to the user too, and so does any answer but a sure `allow` or `deny`.
 */
export const rateCommand = (
  command: string,
  shell: Shell,
  decide: Decide["Service"],
  record: (state: string, answer: DecisionAnswer) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const rule = hardRule(command, shell);
    if (rule) return { verdict: "ask", reason: rule } as const;
    const parsed = withoutComments(command, shell);
    const state = guardState("text" in parsed ? parsed.text : command);
    const asked = yield* Effect.exit(decide.decide({ state, questions: [guardQuestion] }).pipe(Effect.timeoutOption(guardTimeout)));
    if (Exit.isFailure(asked)) return { verdict: "ask", reason: "the guard failed" } as const;
    if (Option.isNone(asked.value)) return { verdict: "ask", reason: `the guard took longer than ${guardTimeout}` } as const;
    const [answer] = asked.value.value.answers;
    if (answer) yield* record(state, answer);
    return guardVerdict(answer);
  });

/**
 * Whether smart approvals rate commands now: `enabled` by the profile's `approvals.yaml`, and `on` while enabled unless
 * the user turned them off since (the latest `approvals.smart.changed`).
 */
export const loadSmartApprovals = (enabled: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [latest] = yield* sql<{ turned: number }>`
      select json_extract(payload, '$.on') as turned from events where type = 'approvals.smart.changed' order by seq desc limit 1`;
    return { enabled, on: enabled && (latest === undefined || latest.turned === 1) };
  });
