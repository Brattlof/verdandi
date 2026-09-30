import { expect, test } from "bun:test";
import type { BudgetMode, InteractionMode, TaskClass } from "@verdandi/contracts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

type Golden = { text: string; mode?: InteractionMode; taskClass: TaskClass; routes: Record<BudgetMode, string> };

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
];

for (const g of GOLDENS) {
  for (const mode of ["thrifty", "balanced", "max"] as const) {
    test(`${g.taskClass}${g.mode === "plan" ? " (plan)" : ""} in ${mode}: ${g.routes[mode]}`, () => {
      const d = route({ text: g.text, mode: g.mode ?? "build" }, loadPolicy([{ source: "test", data: { mode } }]), rules);
      expect(d.taskClass).toBe(g.taskClass);
      expect(`${d.target.model} ${d.effort}`).toBe(g.routes[mode]);
      expect(d.source).toBe("policy");
      expect(d.reason).toStartWith(`Looks like ${g.taskClass}`);
    });
  }
}

test("every taxonomy class has a golden", () => {
  expect(new Set(GOLDENS.map((g) => g.taskClass)).size).toBe(Object.keys(loadPolicy().routes).length);
});
