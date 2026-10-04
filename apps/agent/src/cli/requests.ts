import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, lineDiff, type Question, type ThreadView, type TrustPurpose, trustSubjects } from "@verdandi/contracts";
import { childEnv } from "../home/child-env.ts";
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
      ? `delete the skill ${skill} (its whole folder moves to the archive)`
      : `${action === "patch" ? "patch" : "write"} ${skill}/${path}`;

/** A skill proposal prints its whole diff, like a plan: the user approves what they read. */
export const skillPrompt = (r: Extract<PendingRequest, { type: "skill.proposed" }>) => {
  const diff = lineDiff(r.change.before ?? "", r.change.after ?? "").map((l) => `${marks[l.line]} ${l.text}`);
  return `\n[skill] The agent proposes to ${skillChangeTitle(r.change)}:\n${diff.join("\n")}\nAllow? [y/n] `;
};

type InstallRequest = Extract<PendingRequest, { type: "skill.install.proposed" }>;

/** What a hub install request would do, in a few words: install or update, from where, at which commit. */
export const installTitle = ({ from, skill, pin }: InstallRequest) =>
  `${from ? "update" : "install"} the hub skill ${skill} from ${pin.source} to ${pin.sha.slice(0, 12)}${pin.ref === pin.sha ? "" : ` (${pin.ref})`}`;

const diffText = (before: string | null, after: string | null) =>
  lineDiff(before ?? "", after ?? "")
    .map((l) => `${marks[l.line]} ${l.text}`)
    .join("\n");

const tag = (before: string | null, after: string | null) => (before === null ? " (new)" : after === null ? " (removed)" : "");

/**
 * A hub install's every file as a diff, the scans' advice, then the files the user changed, which it keeps, each with
 * upstream's change to take or leave: the user approves what they read (DESIGN §14.4).
 */
export const installText = (r: InstallRequest) => {
  const files = r.changes.map((c) => `=== ${c.path}${tag(c.before, c.after)}\n${diffText(c.before, c.after)}\n`);
  const none = r.changes.length === 0 ? "No file changes: allowing it records the new commit.\n" : "";
  const kept = r.kept.map(
    (k) =>
      `=== ${k.path}: you changed it, so it stays as you left it. Upstream's change, to take with \`verdandi skills update ${r.skill} --ref ${r.pin.ref}${[...r.taken, k.path].map((p) => ` --take ${p}`).join("")}\`:\n${diffText(k.before, k.after)}\n`,
  );
  const advice =
    r.advice.length === 0
      ? "The scans flagged nothing, which proves nothing: read it before you allow it.\n"
      : `The scans flagged, as advice:\n${r.advice.map((a) => `  ${a.path}: ${a.why}`).join("\n")}\n`;
  return `${files.join("")}${none}${kept.join("")}${advice}`;
};

/** A hub install or update, from the Skills hub thread: its whole diff, then the question. */
export const installPrompt = (r: InstallRequest) =>
  `\n[skill hub] Verdandi would ${installTitle(r)} in your profile's skills folder:\n${installText(r)}Allow? [y/n] `;

/**
 * A proposed memory: from a background review (DESIGN §14.5), or the agent's own save in a turn that read untrusted
 * input (§17). What it would remember, where, and why it asks.
 */
export const memoryPrompt = (r: Extract<PendingRequest, { type: "memory.proposed" }>) =>
  `\n[memory] ${proposer(r)} proposes remembering, in ${r.scope === "user" ? "your user" : "this project's"} memory:\n${r.text}\nRemember it? [y/n] `;

/** Who proposes a memory, and why it waits for the user. */
const proposer = (r: Extract<PendingRequest, { type: "memory.proposed" }>) =>
  r.untrusted
    ? `The agent saved this after reading untrusted input (${r.untrusted.source}, turn ${r.untrusted.turn}), which may have planted it, so it`
    : "A background review of this thread's task";

type TrustRequest = Extract<PendingRequest, { type: "commands.trust.requested" }>;

/** What a trust request covers: the exact commands and the project file they come from, or the flagged files. */
export const trustedCommandsLine = (r: { readonly purpose: TrustPurpose; readonly commands: readonly string[] }) =>
  `${trustSubjects[r.purpose]}: ${r.commands.map((c) => `\`${c}\``).join(", ")}`;

/**
 * The project's own commands, which Verdandi runs only once trusted, or flagged context files, which the harness loads
 * only once trusted: allowing them trusts this exact list in the project.
 */
export const trustPrompt = (r: TrustRequest) =>
  r.purpose === "context"
    ? `\n[trust] The agent would start with ${trustedCommandsLine(r)}. Its harness loads them by itself and can't leave one out.\nAllowing trusts these files as they are now in this project, until you revoke it with /untrust; denying ends the turn. Allow? [y/n] `
    : `\n[trust] Verdandi would run ${trustedCommandsLine(r)}\nAllowing trusts this list in this project until you revoke it with /untrust. Allow? [y/n] `;

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
    const exitCode = await Bun.spawn({ ...shell(`${editor} "${file}"`), env: childEnv(), stdio: ["inherit", "inherit", "inherit"] }).exited;
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
