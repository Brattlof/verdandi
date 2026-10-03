import { expect, test } from "bun:test";
import type { TaskClass } from "@verdandi/contracts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";
import { signals } from "./signals.ts";

const policy = loadPolicy();

/** `read`: what the reason quotes as the classifier's cues. Each lands in its class above the policy's minimum confidence. */
type Golden = { text: string; taskClass: TaskClass; read: string };

// Bug reports that give the symptom, not the file at fault (issue #172). Not the m3 eval set's prompts: that set stays held out.
const SYMPTOMS: Golden[] = [
  {
    text: "The unread badge shows the old count after I mark everything read.",
    taskClass: "debug.investigate",
    read: `"shows the old count after"`,
  },
  {
    text: "Exporting a project with an emoji in its name crashes when the zip is written.",
    taskClass: "debug.investigate",
    read: `"crashes"`,
  },
  {
    text: "The invoice total returns the wrong amount for customers in Norway.",
    taskClass: "debug.investigate",
    read: `"returns the wrong"`,
  },
  { text: "After a restart the scheduler never fires the nightly job.", taskClass: "debug.investigate", read: `"never fires"` },
  {
    text: "Expected the cost column to show $0.12 but it shows $12.00.",
    taskClass: "debug.investigate",
    read: `"expected the cost column to show $0.12 but"`,
  },
  { text: "Renaming a project gives an error about a missing row.", taskClass: "debug.investigate", read: `"gives an error"` },
  // "fix" names no place when the text names no file, so it asks for the bug to be found.
  {
    text: "Fix this: the sidebar still shows deleted folders until I refresh the page.",
    taskClass: "debug.investigate",
    read: `"fix" with no file named, "still shows"`,
  },
];

const FEATURES: Golden[] = [
  { text: "Let users pin a thread to the top of the sidebar.", taskClass: "code.feature", read: `"let users"` },
  { text: "Add a --since flag to the export command that takes an ISO date.", taskClass: "code.feature", read: `"add a --since flag"` },
  { text: "Support dark mode in the email templates.", taskClass: "code.feature", read: `"support"` },
  { text: "Users should be able to archive several threads at once from the list.", taskClass: "code.feature", read: `"be able to"` },
  { text: "There's no way to cancel a scheduled job from the CLI; add one.", taskClass: "code.feature", read: `"there's no way to"` },
  { text: "I'd like a way to export a thread as Markdown.", taskClass: "code.feature", read: `"i'd like a way"` },
];

const TESTS: Golden[] = [
  { text: "Write tests for the retry backoff in the HTTP client.", taskClass: "test.write", read: `"write tests", "tests for"` },
  {
    text: "Extend the parser tests to cover nested quotes and escaped newlines.",
    taskClass: "test.write",
    read: `"extend the parser tests"`,
  },
  { text: "The date helpers are untested; cover them with tests.", taskClass: "test.write", read: `"untested", "cover them with tests"` },
  { text: "Add a regression test for the empty-cart checkout.", taskClass: "test.write", read: `"add a regression test", "test for"` },
  { text: "Add coverage for the fallback branch of the price calculator.", taskClass: "test.write", read: `"coverage"` },
];

// The new cues leave these alone: a bug whose file is named is a local edit, tests that only have to pass ask for none,
// and a spec's "do not" is no symptom.
const KEPT: Golden[] = [
  { text: "src/report.ts returns the wrong total for refunds, fix it", taskClass: "code.edit.local", read: `"fix"` },
  { text: "Rename getUser to fetchUser and make the tests pass", taskClass: "code.edit.mechanical", read: `"rename"` },
  { text: "Implement CSV export and do not change the public API", taskClass: "code.feature", read: `"implement"` },
  { text: "Thanks, let me know when you're done", taskClass: "chat.general", read: `"thanks"` },
];

for (const g of [...SYMPTOMS, ...FEATURES, ...TESTS, ...KEPT]) {
  test(`${g.taskClass}: ${g.text}`, () => {
    const c = rules(signals(g.text, "build"));
    expect([c.taskClass, c.confidence >= policy.minConfidence]).toEqual([g.taskClass, true]);
    const d = route({ text: g.text, mode: "build" }, policy, rules);
    expect(d.reason).toStartWith(`Looks like ${g.taskClass} (${g.read}), so`);
  });
}

test("an unsure reason quotes each class's cues, the best guess's first", () => {
  const d = route({ text: "Add the archive button and fix the typo in its label", mode: "build" }, policy, rules);
  expect(d.reason).toStartWith(
    `Not sure what kind of task this is (best guess code.edit.local, confidence 0.50: "fix", "typo"; "add the archive button" for code.feature), so`,
  );
});
