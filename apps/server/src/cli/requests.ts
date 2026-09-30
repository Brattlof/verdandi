import type { Question, ThreadView } from "@verdandi/contracts";

export type PendingRequest = ThreadView["pendingRequests"][number];

const clip = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The approval prompt: the tool and its input, since the SDK's own title is often absent (ADR 0003). */
export const approvalPrompt = (r: Extract<PendingRequest, { type: "approval.requested" }>) =>
  `\n[approval] ${r.toolName} ${clip(JSON.stringify(r.input))}\nAllow? [y/n] `;

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
