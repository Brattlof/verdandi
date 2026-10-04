import { expect, test } from "bun:test";
import { atPin, type BudgetMode, type InteractionMode, type TaskClass } from "@verdandi/contracts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

/** `given`: Verdandi gives the task its class, as it does its own background reviews, instead of classifying the text. */
type Golden = { text: string; mode?: InteractionMode; taskClass: TaskClass; routes: Record<BudgetMode, string>; given?: true };

// The DESIGN §8.5 table on a Claude-only setup, as "model effort". Thrifty is one step down, Max one step up.
const GOLDENS: Golden[] = [
  {
    text: "Where is the auth middleware?",
    taskClass: "ask.search",
    routes: { thrifty: "haiku low", balanced: "haiku low", max: "sonnet low" },
  },
  {
    text: "What does this reducer do?",
    taskClass: "ask.explain",
    routes: { thrifty: "haiku low", balanced: "sonnet low", max: "sonnet medium" },
  },
  {
    text: "Write a commit message for these changes",
    taskClass: "chore.git",
    routes: { thrifty: "haiku low", balanced: "haiku low", max: "sonnet low" },
  },
  {
    text: "Update the README with the new install steps",
    taskClass: "docs.write",
    routes: { thrifty: "haiku low", balanced: "sonnet low", max: "sonnet medium" },
  },
  {
    text: "Rename getUser to fetchUser",
    taskClass: "code.edit.mechanical",
    routes: { thrifty: "haiku low", balanced: "sonnet low", max: "sonnet medium" },
  },
  {
    text: "Fix the date parsing bug in src/dates.ts",
    taskClass: "code.edit.local",
    routes: { thrifty: "sonnet low", balanced: "sonnet medium", max: "sonnet high" },
  },
  {
    text: "Add unit tests for the tokenizer",
    taskClass: "test.write",
    routes: { thrifty: "sonnet low", balanced: "sonnet medium", max: "sonnet high" },
  },
  {
    text: "Implement dark mode for the settings page",
    taskClass: "code.feature",
    routes: { thrifty: "sonnet low", balanced: "sonnet medium", max: "sonnet high" },
  },
  {
    text: "Implement dark mode for the settings page",
    mode: "plan",
    taskClass: "code.feature",
    routes: { thrifty: "opus medium", balanced: "opus high", max: "opus xhigh" },
  },
  {
    text: "Migrate every module from callbacks to async/await",
    taskClass: "code.refactor.large",
    routes: { thrifty: "sonnet medium", balanced: "sonnet high", max: "sonnet xhigh" },
  },
  {
    text: "Migrate every module from callbacks to async/await",
    mode: "plan",
    taskClass: "code.refactor.large",
    routes: { thrifty: "opus medium", balanced: "opus high", max: "opus xhigh" },
  },
  {
    text: "The server crashes on startup:\nTypeError: x is undefined\n    at boot (src/main.ts:12:5)",
    taskClass: "debug.investigate",
    routes: { thrifty: "sonnet high", balanced: "opus high", max: "fable high" },
  },
  {
    text: "Review my changes for security problems",
    taskClass: "review",
    routes: { thrifty: "opus low", balanced: "opus medium", max: "opus high" },
  },
  {
    text: "What are the trade-offs between SQLite and Postgres for our event store design?",
    taskClass: "design.architecture",
    routes: { thrifty: "opus medium", balanced: "opus high", max: "fable high" },
  },
  {
    text: "Thanks, that's all for today",
    taskClass: "chat.general",
    routes: { thrifty: "haiku low", balanced: "haiku low", max: "sonnet low" },
  },
  // Background review stays on the cheap target whatever the budget mode (DESIGN §14.5).
  {
    text: "Verdandi is reviewing a finished task for what's worth keeping.",
    taskClass: "aux.review",
    given: true,
    routes: { thrifty: "haiku low", balanced: "haiku low", max: "haiku low" },
  },
  // So does a handoff's summary, written before a thread's new session on another harness (DESIGN §8.2 lever 5).
  {
    text: "Verdandi is handing a thread over from Claude Code to Verdandi's native agent.",
    taskClass: "aux.handoff",
    given: true,
    routes: { thrifty: "haiku low", balanced: "haiku low", max: "haiku low" },
  },
  {
    text: "Verdandi is compressing a long session of its native agent.",
    taskClass: "aux.compress",
    given: true,
    routes: { thrifty: "haiku low", balanced: "haiku low", max: "haiku low" },
  },
];

/** How a reason names a "model effort" route: Haiku takes no effort level, so its reason names none. */
const said = (r: string) => (r.startsWith("haiku ") ? "haiku" : `${r.replace(" ", " at ")} effort`);

for (const g of GOLDENS) {
  for (const mode of ["thrifty", "balanced", "max"] as const) {
    test(`${g.taskClass}${g.mode === "plan" ? " (plan)" : ""} in ${mode}: ${g.routes[mode]}`, () => {
      const classify = g.given ? () => ({ taskClass: g.taskClass, difficulty: 0.1, confidence: 1, why: "given" }) : rules;
      const d = route({ text: g.text, mode: g.mode ?? "build" }, loadPolicy([{ source: "test", data: { mode } }]), classify);
      expect(d.taskClass).toBe(g.taskClass);
      expect(`${d.target.model} ${d.effort}`).toBe(g.routes[mode]);
      expect(d.source).toBe("policy");
      expect(d.reason).toStartWith(`Looks like ${g.taskClass}`);
      // The mode is named exactly when it moved the route off the balanced one.
      const moved = g.routes[mode] !== g.routes.balanced;
      expect(d.reason.includes(`so in ${mode} mode it runs on ${said(g.routes[mode])}.`)).toBe(moved);
      if (!moved) expect(d.reason).toEndWith(`so it runs on ${said(g.routes[mode])}.`);
    });
  }
}

test("every taxonomy class has a golden", () => {
  expect(new Set(GOLDENS.map((g) => g.taskClass)).size).toBe(Object.keys(loadPolicy().routes).length);
});

// Stage 3 reads intent words, not names: `docs/DESIGN.md` or a URL is no cue, so it neither picks a class nor makes one unsure.
// A README or changelog is the exception: it is the docs it names. The reason quotes what it read.
const NAMED: { text: string; taskClass: TaskClass; read: string; route: string }[] = [
  { text: "Fix the typo in docs/DESIGN.md", taskClass: "code.edit.local", read: `"fix", "typo"`, route: "sonnet medium" },
  { text: "Fix the date parsing bug in src/review/dates.ts:42", taskClass: "code.edit.local", read: `"fix"`, route: "sonnet medium" },
  {
    text: "Should we use SQLite or Postgres for the event store? See docs/DESIGN.md",
    taskClass: "design.architecture",
    read: `"should we use"`,
    route: "opus high",
  },
  {
    text: "Where is the auth middleware? See https://example.com/docs/design",
    taskClass: "ask.search",
    read: `"where is"`,
    route: "haiku low",
  },
  { text: "Update README.md with the new install steps", taskClass: "docs.write", read: "a readme or changelog", route: "sonnet low" },
];

for (const g of NAMED) {
  test(`${g.taskClass}, naming a file or URL: ${g.text}`, () => {
    const d = route({ text: g.text, mode: "build" }, loadPolicy(), rules);
    expect([d.taskClass, d.reason]).toEqual([g.taskClass, `Looks like ${g.taskClass} (${g.read}), so it runs on ${said(g.route)}.`]);
  });
}

// An approved plan's build (DESIGN §8.2 lever 3): the task's class keeps, and its route drops the `plan` override.
const PLANNED: { taskClass: TaskClass; routes: Record<BudgetMode, string> }[] = [
  { taskClass: "code.feature", routes: { thrifty: "sonnet low", balanced: "sonnet medium", max: "sonnet high" } },
  { taskClass: "code.refactor.large", routes: { thrifty: "sonnet medium", balanced: "sonnet high", max: "sonnet xhigh" } },
];

for (const g of PLANNED) {
  for (const mode of ["thrifty", "balanced", "max"] as const) {
    test(`${g.taskClass} after its plan is approved, in ${mode}: ${g.routes[mode]}`, () => {
      const classify = () => ({ taskClass: g.taskClass, difficulty: 0.5, confidence: 0.9, why: "the task's class" });
      const d = route(
        { text: "1. Edit src/a.ts", mode: "build", planApproved: true },
        loadPolicy([{ source: "test", data: { mode } }]),
        classify,
      );
      expect(`${d.target.model} ${d.effort}`).toBe(g.routes[mode]);
      expect(d.reason).toStartWith(`The plan for this ${g.taskClass} task is approved, so`);
      expect(d.reason).toEndWith(`it runs on ${said(g.routes[mode])}.`);
    });
  }
}

// DESIGN §8.4 stage 0: a leading `@name` pins its task, and only its task.
test("@haiku skips classification-based routing with the pin as the reason, and the next task without it routes by class", () => {
  const text = "Fix the date parsing bug in src/dates.ts";
  const at = atPin(`@haiku ${text}`);
  if (!at) throw new Error("@haiku wasn't read as a pin");
  expect(at.text).toBe(text);
  const pinned = route({ text: at.text, at: at.name, mode: "build" }, loadPolicy(), rules);
  expect(pinned).toMatchObject({ source: "pin", taskClass: "code.edit.local", target: { model: "haiku" }, effort: "medium" });
  expect(pinned.reason).toBe("Pinned with @haiku.");
  expect(pinned.trace.map((t) => t.stage)).not.toContain("policy");
  const next = route({ text, mode: "build" }, loadPolicy(), rules);
  expect(next).toMatchObject({ source: "policy", target: { model: "sonnet" }, effort: "medium" });
  expect(next.reason).toStartWith("Looks like code.edit.local");
});

test("a feature routed with an explorer on Haiku keeps its main route in every mode", () => {
  const subagents = { explorer: { prefer: ["cc-haiku"], effort: "low" } };
  for (const mode of ["thrifty", "balanced", "max"] as const) {
    const policy = loadPolicy([{ source: "test", data: { mode, routes: { "code.feature": { subagents } } } }]);
    const d = route({ text: "Implement dark mode for the settings page", mode: "build" }, policy, rules);
    expect(`${d.target.model} ${d.effort}`).toBe({ thrifty: "sonnet low", balanced: "sonnet medium", max: "sonnet high" }[mode]);
    expect(d.subagents).toEqual({ explorer: { model: "haiku", effort: "low" } });
  }
});

// DESIGN §8.4 stage 1: a restriction applies to a file the task names, however the text cites it.
test("a restricted file cited with a line, a column or closing punctuation still lifts the task to tier L", () => {
  const policy = loadPolicy([{ source: "test", data: { restrictions: [{ match: "src/auth/**", minTier: "L" }] } }]);
  const routed = (text: string) => {
    const d = route({ text, mode: "build" }, policy, rules);
    return [text, `${d.target.model} ${d.effort}`, d.trace.find((t) => t.stage === "signals")?.note, d.reason];
  };
  const lifted =
    'Looks like code.edit.local ("fix"), but sonnet is unavailable, so it runs on opus at medium effort, the cheapest capable target left.';
  const kept = 'Looks like code.edit.local ("fix"), so it runs on sonnet at medium effort.';
  for (const cite of ["", ".", ":42", ":42.", ":42:7!", ":42?", ":42: it"]) {
    const text = `Fix the expired-session bug in src/auth/session.ts${cite}`;
    expect(routed(text)).toEqual([text, "opus medium", "build mode, 1 file reference", lifted]);
  }
  const billing = "Fix the expired-card bug in src/billing/invoice.ts:42.";
  expect(routed(billing)).toEqual([billing, "sonnet medium", "build mode, 1 file reference", kept]);
  const prose = "Fix the bug with async/await and/or callbacks, see https://example.com/src/auth/a.ts.";
  expect(routed(prose)).toEqual([prose, "sonnet medium", "build mode, 0 file references", kept]);
});
