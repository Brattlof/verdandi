// Manual script, not a test: the compression recall exam (#207, ADR 0033) over the exam set in the gitignored
// evals/compression/private/ (native transcripts from exam-convert.ts, each with a `<name>.exam.json` of questions).
// By default it scores each policy offline, with no model call and no key: the tokens each policy's next request keeps
// and the share of answers still in it, and the live run's estimated cost. With --live it spends metered dollars on
// the native harness's Anthropic key: a model answers each question closed-book from each policy's request, exact
// answers matched as strings and the rest graded by a cheap model. It stops before --max-usd, or the profile's spend
// caps' headroom, whichever is less; its spend isn't recorded in Verdandi's ledger.
//   bun apps/agent/src/compression/exam-run.ts [--dir <dir>] [--policies full,truncate,recency] [--window 200000]
//   bun apps/agent/src/compression/exam-run.ts --live --max-usd <n> [--answerer <model>] [--grader <model>] [--home <dir>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { CompressionExam, type ExamQuestion, listCost } from "@verdandi/contracts";
import {
  answersExactly,
  type ExamSession,
  examPolicies,
  findAnthropicKey,
  loadTranscript,
  nativeCatalog,
  nextRequest,
  offlineScore,
} from "@verdandi/harness-native";
import { makeFakeAnthropic } from "@verdandi/testkit";
import { Effect, Result, Schema } from "effect";
import { flag, resolveHome } from "../home/home.ts";
import { loadSpendCaps as spendAgainstCaps } from "../spend/spend.ts";
import { loadSpendCaps } from "../spend/spend-caps.ts";

type Body = Awaited<ReturnType<typeof nextRequest>>;
type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

/** The new turn each policy's request ends with; a live run's question follows it in the same message. */
const instruction =
  "This is Verdandi's recall exam about the conversation above. Answer the question below from the conversation alone, without tools. Reply with the answer only, as short as it can be: when the question asks for an identifier (a path, a SHA, a command, an error, a number), give it exactly as the conversation has it. If the conversation doesn't say, reply \"Not in the context.\"";

const usd = (n: number) => `$${n.toFixed(2)}`;
const price = (model: string) => {
  const entry = nativeCatalog.find((e) => e.model === model);
  if (!entry) throw new Error(`The catalog doesn't price ${model}. Pick one of ${nativeCatalog.map((e) => e.model).join(", ")}.`);
  return entry;
};

/** Every exam in `dir` with its transcript, failing on a malformed file with its name. */
const loadExams = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".exam.json"))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      let exam: CompressionExam;
      try {
        exam = Schema.decodeUnknownSync(CompressionExam)(JSON.parse(readFileSync(path, "utf8")), {
          onExcessProperty: "error",
          errors: "all",
        });
      } catch (e) {
        throw new Error(`${path} isn't a valid exam: ${e instanceof Error ? e.message : String(e)}`);
      }
      const transcript = loadTranscript(dir, basename(exam.transcript, ".jsonl"));
      if (!transcript) throw new Error(`${path} names ${exam.transcript}, which isn't in ${dir}.`);
      const session: ExamSession = { prefix: transcript.prefix, entries: transcript.entries };
      return { name: basename(file, ".exam.json"), exam, session };
    });

/** The question's request: the policy's, with no automatic cache breakpoint, one on the instruction, and the question last. */
const asking = (body: Body, q: ExamQuestion, answerer: string) => {
  const messages = structuredClone(body.messages);
  const last = messages.at(-1);
  if (last?.role !== "user" || !Array.isArray(last.content)) throw new Error("A policy's request doesn't end with the exam's turn.");
  const at = last.content.length - 1;
  last.content[at] = { ...(last.content[at] as object), cache_control: { type: "ephemeral" } } as (typeof last.content)[number];
  last.content.push({ type: "text", text: `Question: ${q.question}` });
  return { model: answerer, max_tokens: 400, system: body.system, tools: body.tools, tool_choice: { type: "none" }, messages };
};

/** The live run's estimated cost for one policy's request of `tokens`: a cache write, reads for the other questions, short replies, grading. */
const estimate = (tokens: number, exam: CompressionExam, answerer: string, grader: string) => {
  const n = exam.questions.length;
  const judged = exam.questions.filter((q) => q.kind === "judged").length;
  return (
    listCost(price(answerer).price, {
      inputTokens: n * 60,
      outputTokens: n * 60,
      cacheWriteTokens: tokens,
      cacheReadTokens: (n - 1) * tokens,
    }) + listCost(price(grader).price, { inputTokens: judged * 300, outputTokens: judged * 5, cacheReadTokens: 0, cacheWriteTokens: 0 })
  );
};

/** What's left under the profile's spend caps today and this month (and the folder's, if it's a project), read-only. */
const capsHeadroom = async (home: string) => {
  const caps = await Effect.runPromise(loadSpendCaps(home));
  if (Result.isFailure(caps)) throw new Error(caps.failure);
  const db = join(home, "verdandi.db");
  const configured = Object.values(caps.success.profile);
  if (!existsSync(db)) return configured.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...configured);
  const spent = await Effect.runPromise(
    spendAgainstCaps(caps.success, process.cwd(), new Date()).pipe(Effect.provide(SqliteClient.layer({ filename: db, readonly: true }))),
  );
  return spent.reduce((least, c) => Math.min(least, c.limitUsd - c.spentUsd), Number.POSITIVE_INFINITY);
};

/** A Messages API call (`path` under /v1/messages), retried after a rate limit or overload as the API asks. */
const call = async (key: string, path: string, body: unknown): Promise<Record<string, unknown>> => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://api.anthropic.com/v1/messages${path}`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    if (response.ok) return json;
    if ((response.status === 429 || response.status === 529) && attempt < 4) {
      await Bun.sleep(Number(response.headers.get("retry-after") ?? 10) * 1000);
      continue;
    }
    throw new Error(`The Anthropic API answered ${response.status}: ${JSON.stringify(json.error ?? json)}`);
  }
};

const usageOf = (reply: Record<string, unknown>): Usage => {
  const u = (reply.usage ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
};
const replyText = (reply: Record<string, unknown>) =>
  ((reply.content ?? []) as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("");

export const main = async (argv: readonly string[]) => {
  const dir = flag(argv, "--dir") ?? join(import.meta.dir, "../../../../evals/compression/private");
  const window = Number(flag(argv, "--window") ?? 200_000);
  const names = (flag(argv, "--policies") ?? "full,truncate,recency").split(",");
  const answerer = flag(argv, "--answerer") ?? "claude-sonnet-5-5";
  const grader = flag(argv, "--grader") ?? "claude-haiku-4-5";
  const live = argv.includes("--live");
  for (const n of names)
    if (!examPolicies[n]) throw new Error(`There's no policy ${n}. Pick from ${Object.keys(examPolicies).join(", ")}.`);
  if (!Number.isInteger(window) || window <= 0) throw new Error("--window takes a number of tokens, e.g. --window 200000.");
  const room = price(answerer).context - 400;

  const exams = loadExams(dir);
  if (exams.length === 0) throw new Error(`${dir} has no *.exam.json. Convert sessions with exam-convert.ts, then write their questions.`);
  const runs = [];
  let malformed = false;
  console.log(`Offline, in a ${window.toLocaleString("en-US")}-token window (tokens estimated; live cost at catalog list prices):`);
  for (const { name, exam, session } of exams) {
    for (const policy of names) {
      const fake = makeFakeAnthropic([{ blocks: [{ type: "text", text: "ok" }] }]);
      const body = await nextRequest(session, examPolicies[policy]?.(session, window) ?? [], fake, instruction);
      const score = offlineScore(body, exam);
      const fits = score.tokens <= room;
      const cost = fits ? estimate(score.tokens, exam, answerer, grader) : 0;
      runs.push({ name, exam, policy, body, score, fits, cost });
      const share = `${((score.held / score.questions) * 100).toFixed(1)}%`;
      console.log(
        `  ${name.slice(0, 8)}  ${policy.padEnd(9)} ~${Math.round(score.tokens / 1000)}K tokens  ${share.padStart(6)} of answers held  ${fits ? `live ~${usd(cost)}` : `too big for ${answerer}, skipped live`}`,
      );
      if (policy === "full" && score.missing.length > 0) {
        malformed = true;
        console.log(`    Not in the whole transcript, so the exam is wrong: ${score.missing.join(", ")}`);
      }
    }
  }
  const total = runs.reduce((sum, r) => sum + r.cost, 0);
  console.log(`Estimated live cost: ${usd(total)} (${answerer} answers, ${grader} grades).`);
  if (malformed) process.exitCode = 1;
  if (!live || malformed) return;

  const maxFlag = flag(argv, "--max-usd");
  if (maxFlag === undefined || !(Number(maxFlag) > 0)) throw new Error("--live needs --max-usd <dollars>: the most the run may spend.");
  const headroom = await capsHeadroom(resolveHome(argv));
  const budget = Math.min(Number(maxFlag), headroom);
  if (total > budget)
    throw new Error(
      `The estimate, ${usd(total)}, is over the budget of ${usd(budget)} (--max-usd, or what the spend caps leave). Raise it, or run fewer policies.`,
    );
  const found = await findAnthropicKey(process.env, Bun.secrets);
  if (found.key === undefined) throw new Error(`The live run needs the native harness's key: ${found.reason}`);
  const key = found.key;

  let spent = 0;
  const results = [];
  for (const run of runs.filter((r) => r.fits)) {
    const counted = await call(key, "/count_tokens", {
      model: answerer,
      system: run.body.system,
      tools: run.body.tools,
      messages: run.body.messages,
    });
    let correct = 0;
    const answers = [];
    for (const q of run.exam.questions) {
      if (spent >= budget) throw new Error(`Stopped at the budget of ${usd(budget)}, with ${usd(spent)} spent.`);
      const reply = await call(key, "", asking(run.body, q, answerer));
      spent += listCost(price(answerer).price, usageOf(reply));
      const answer = replyText(reply).trim();
      let right = false;
      if (q.kind === "exact") right = answersExactly(answer, q);
      else {
        const graded = await call(key, "", {
          model: grader,
          max_tokens: 5,
          messages: [
            {
              role: "user",
              content: `Grade an answer to a question about a coding session.\nQuestion: ${q.question}\nGold answer: ${q.answer}\nCandidate answer: ${answer}\nDoes the candidate give the gold answer's substance? Reply yes or no.`,
            },
          ],
        });
        spent += listCost(price(grader).price, usageOf(graded));
        right = /^\s*yes/i.test(replyText(graded));
      }
      if (right) correct++;
      answers.push({ id: q.id, answer, right });
    }
    const recall = correct / run.exam.questions.length;
    const tokens = Number(counted.input_tokens ?? 0);
    results.push({ transcript: run.name, policy: run.policy, tokens, recall, held: run.score.held / run.score.questions, answers });
    console.log(
      `  ${run.name.slice(0, 8)}  ${run.policy.padEnd(9)} ${(recall * 100).toFixed(1).padStart(5)}% recall @ ${Math.round(tokens / 1000)}K tokens  (${usd(spent)} spent so far)`,
    );
  }
  for (const policy of names) {
    const of = results.filter((r) => r.policy === policy);
    if (of.length === 0) continue;
    const avg = (f: (r: (typeof of)[number]) => number) => of.reduce((s, r) => s + f(r), 0) / of.length;
    console.log(
      `  AVG       ${policy.padEnd(9)} ${(avg((r) => r.recall) * 100).toFixed(1).padStart(5)}% recall @ ${Math.round(avg((r) => r.tokens) / 1000)}K tokens`,
    );
  }
  const out = join(dir, `results-${new Date().toISOString().replaceAll(":", "-")}.json`);
  writeFileSync(out, JSON.stringify({ window, answerer, grader, spentUsd: spent, results }, null, 2));
  console.log(`Spent ${usd(spent)}. Answers in ${out}.`);
};

if (import.meta.main)
  await main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
