import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, lineDiff, type Question, type ThreadView } from "@verdandi/contracts";
import { shell } from "../verifiers/verify.ts";

export type PendingRequest = ThreadView["pendingRequests"][number];

/** The approval prompt: the tool and its input, since the SDK's own title is often absent (ADR 0003). */
export const approvalPrompt = (r: Extract<PendingRequest, { type: "approval.requested" }>) =>
  `\n[approval] ${r.toolName} ${clip(JSON.stringify(r.input), 400)}\nAllow? [y/n] `;

const marks = { context: " ", del: "-", add: "+" } as const;

/** What a skill proposal would do, in a few words. */
export const skillChangeTitle = ({ action, skill, path }: Extract<PendingRequest, { type: "skill.proposed" }>["change"]) =>
  action === "create"
    ? `create the skill ${skill}`
    : action === "delete"
      ? `delete the skill ${skill} (its whole folder)`
      : `${action === "patch" ? "patch" : "write"} ${skill}/${path}`;

/** A skill proposal prints its whole diff, like a plan: the user approves what they read. */
export const skillPrompt = (r: Extract<PendingRequest, { type: "skill.proposed" }>) => {
  const diff = lineDiff(r.change.before ?? "", r.change.after ?? "").map((l) => `${marks[l.line]} ${l.text}`);
  return `\n[skill] The agent proposes to ${skillChangeTitle(r.change)}:\n${diff.join("\n")}\nAllow? [y/n] `;
};

/** A background review's proposed memory (DESIGN §14.5): what it would remember, and where. */
export const memoryPrompt = (r: Extract<PendingRequest, { type: "memory.proposed" }>) =>
  `\n[memory] A background review of this thread's task proposes remembering, in ${r.scope === "user" ? "your user" : "this project's"} memory:\n${r.text}\nRemember it? [y/n] `;

/** A plan and, when approving it moves the build to another route, where and why. */
export const planPrompt = (r: Extract<PendingRequest, { type: "plan.requested" }>) => {
  const moves = r.execute ? `[approving moves the build to ${r.execute.target.model} ${r.execute.effort}: ${r.execute.reason}]\n` : "";
  return `\n[plan${r.filePath ? ` ${r.filePath}` : ""}]\n${r.plan}\n${moves}Approve and build? [y/n, or e to edit it first] `;
};

/** `$VISUAL`, then `$EDITOR`, then the platform's own. */
const defaultEditor = () => process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");

/**
 * Opens `plan` in the user's editor on a temp file through the platform shell, waits for it to close, and returns
 * what it saved, or why there's nothing to approve. Called while `verdandi chat`'s line reader waits on the answer,
 * so the editor has the terminal; the event loop keeps running, so the connection stays alive however long it takes.
 */
export const editPlan = async (plan: string, editor = defaultEditor()): Promise<{ readonly plan: string } | { readonly error: string }> => {
  const dir = mkdtempSync(join(tmpdir(), "verdandi-plan-"));
  try {
    const file = join(dir, "plan.md");
    writeFileSync(file, plan);
    const exitCode = await Bun.spawn({ ...shell(`${editor} "${file}"`), stdio: ["inherit", "inherit", "inherit"] }).exited;
    if (exitCode !== 0)
      return {
        error: `The editor (${editor}) exited with ${exitCode}, so nothing was approved. Set $VISUAL or $EDITOR to one that works.`,
      };
    const edited = readFileSync(file, "utf8").replaceAll("\r\n", "\n").trimEnd();
    if (!edited.trim()) return { error: "The edited plan was empty, so nothing was approved." };
    if (edited.trim() === plan.trim()) return { error: "The plan came back unchanged, so nothing was approved." };
    return { plan: edited };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const questionPrompt = (q: Question) => {
  const options = q.options.map((o, i) => `  ${i + 1}. ${o.label}: ${o.description}`).join("\n");
  const pick = q.multiSelect ? "Pick numbers separated by commas" : "Pick a number";
  return `\n[question] ${q.question}\n${options}\n${pick}, or type your own answer (/skip declines): `;
};

/** Option numbers become their labels (multi-select joined with ", "); anything else is a typed answer. */
export const parseAnswer = (q: Question, line: string): string | undefined => {
  const text = line.trim();
  if (!text) return undefined;
  if (!/^\d+(\s*,\s*\d+)*$/.test(text)) return text;
  const picked = text.split(",").map((n) => q.options[Number(n.trim()) - 1]?.label);
  if (picked.some((label) => label === undefined) || (!q.multiSelect && picked.length > 1)) return undefined;
  return picked.join(", ");
};
