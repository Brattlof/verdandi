# Verdandi — Design Document

| | |
|---|---|
| **Status** | Draft v0.3 — for review |
| **Owner** | @Brattlof |
| **Last updated** | 2026-10-02 |
| **Repo** | [Brattlof/verdandi](https://github.com/Brattlof/verdandi) (private) |

> **Changes since v0.2**
> - The runtime is **Bun** instead of Node (§19).
> - New **decision layer** (§9.8). Small judgments go to decision models instead of LLM calls: Laya runs locally, and Jev is a cloud option you have to turn on. The layer is used for routing, background review, memory selection, approvals, injection scanning and gateway triage.
> - Terminals run in a separate PTY host process (§13).

---

## 1. Summary

Verdandi is a local-first workspace and personal agent platform for AI coding and automation. It combines four things:

1. **A terminal-first agent, with a GUI when you want one.** Type `verdandi` anywhere to talk to the agent: in a project it works on that project, anywhere else in its own workspace. A web UI and a desktop app add threads side by side, diffs, approvals, worktrees, checkpoints and a terminal.
2. **An agent that runs all the time and learns.** It keeps memory across sessions and writes and improves its own skills. It records its trajectories, meaning full session histories with their outcomes, as data it can learn from. It also runs scheduled jobs and can be reached from chat apps.
3. **Many harnesses and providers.** A *harness* is whatever runs the agent loop:
   - **Claude Code**, driven through your installed and logged-in CLI, which uses your subscription;
   - **Verdandi's own native agent**, which calls model APIs directly: Anthropic API credits, OpenAI, OpenRouter, Google, local models through Ollama, and more;
   - other agent CLIs later.
4. **A task router.** This is the defining feature. For every task it picks the harness, provider, model and effort level that will finish the task at the lowest *effective* cost. It shows why, and it learns from the outcome. The small judgments along the way go to fast decision models instead of LLMs. Examples: what type of task this is, whether a command is safe, what to remember.

Verdandi starts with Claude Code, because that's what the owner uses every day. Every other part is designed from the start to work with any harness and any provider.

> **The name.** In Norse myth, the three Norns weave the threads of fate at the roots of Yggdrasil. Verðandi is the Norn of the present: what is happening now. Verdandi works the same way. Everything happens in threads, and for each one it decides, right now, which model and how much effort the next task gets: not too big, not too small.

---

## 2. Problem

- **One model for everything wastes tokens and quota.** A commit message doesn't need Opus at `xhigh`, and a subtle concurrency bug shouldn't be tried on a small local model.
- **Every way of reaching a model has a different kind of cost.** A subscription has usage limits. API credits cost money. Local models are free but weaker. No tool today weighs all three when choosing.
- **Switching naively is expensive.** Prompt caches and thinking blocks belong to one model. A switch mid-conversation bills the entire context again.
- **Agent CLIs are one terminal per session.** Running sessions in parallel, reviewing diffs and approving actions across them is clumsy, so the terminal needs a GUI beside it, not instead of it.
- **Agents forget, and they don't improve.** Every session starts from zero. A procedure you've taught once has to be taught again. Nothing learns from what worked.
- **Agents are stuck at the desk.** You can't start, steer or approve work from your phone, or have it run on a schedule.

---

## 3. Goals and non-goals

### Goals

| # | Goal | How we'll know |
|---|---|---|
| G1 | **Task-based routing** that lowers effective cost without hurting results | On our own eval set, cost per completed task is at least 30% lower than "always Opus at default effort", with no drop in success rate. |
| G2 | **Great surfaces for agent sessions** | The terminal chat is enough for daily Claude Code work, and the GUI covers parallel threads, diffs and review. |
| G3 | **Transparent, overridable routing** | Every decision has a one-line reason, and overriding takes one click. Fewer than 15% of tasks are overridden once the router is tuned. |
| G4 | **An agent that learns** | Memory and skills build up over time. Skills learned on a strong model run on a cheaper one. Recorded trajectories are good enough to train on. |
| G5 | **Many harnesses and providers** | Adding a harness or provider needs no change to the router or the orchestration core. |
| G6 | **Always on, reachable anywhere** | Scheduled jobs run without you. Tasks can be started and approved from a chat app. |
| G7 | **Local-first and private** | State lives in local SQLite. Nothing leaves the machine except calls to the providers you've configured. |

### Non-goals for now

- Hosting a cloud or multi-tenant SaaS.
- Intercepting another harness's API traffic, for example with an `ANTHROPIC_BASE_URL` proxy in front of Claude Code.
- Reading, storing or brokering Claude Code's own subscription credentials.
- Team collaboration, or a native mobile app. The web UI reached over Tailscale covers mobile.

---

## 4. Users and scenarios

**Primary user:** a developer who runs agents across many repos on Windows, macOS or Linux. They have a Claude subscription, possibly API credits with one or more providers, and possibly local models.

| # | Scenario | What Verdandi does |
|---|---|---|
| S1 | "Rename `userId` to `accountId` across the app" | Claude Code, Sonnet at `low`. Search subagents run on Haiku. |
| S2 | "Why does the websocket drop after ~30 min?" | Claude Code, Opus at `high`. |
| S3 | "Add team invites with email verification" | Plan with Opus at `high`. Once you approve the plan, build with Sonnet at `medium`. Review with Opus at `medium`. |
| S4 | "Write a commit message" / "title this thread" | Native harness with a local model, at no cost. If no local model is configured, Haiku. |
| S5 | Subscription quota almost used up at 4 pm | The router gets stricter about what's worth spending quota on. Chores move to API credits or local models, if your policy allows. |
| S6 | Nightly "update deps, fix breakages" | A scheduled task runs in a worktree, within a budget. The result goes to Telegram, and you approve the PR from your phone. |
| S7 | You fix the same kind of CI failure for the third time | Verdandi proposes a skill with a routing hint. Next time the fix runs on a cheaper route. |
| S8 | You pin Opus on a thread | The pin always wins. The override is recorded as feedback for the router. |

---

## 5. Principles

1. **Size every task correctly.** Aim for the cheapest route that completes the task, measured as cost per completed task. Quota and local compute count as costs too.
2. **Switch at boundaries.** Model, provider or harness changes happen at task boundaries.
3. **Don't break the cache.** Within a session, the system prompt and the tool list never change. Anything that changes between turns goes into the next user turn instead.
4. **Explain every decision.** Each routing decision is stored and can be inspected, and comes with a readable reason.
5. **The user always wins, and every override is data.**
6. **Complexity lives in the adapters; the core stays pure.** Each harness, provider and platform is an adapter behind a small interface. Orchestration and routing are deterministic.
7. **Save intent before acting.** Every command is saved as an event before anything else happens. The UI is a view of that event log.
8. **Use a harness's built-in features.** With Claude Code, use its subagents, skills, hooks, MCP and plan mode. With the native harness, Verdandi provides those features itself.
9. **Learn from everything.** Every task records its route, outcome and trajectory in a format that can be trained on.
10. **Keep the core small: the Footprint Ladder.** Before adding anything to the core, try these, cheapest first:
    1. extend existing code;
    2. a CLI command plus a skill;
    3. a tool that is only enabled under certain conditions;
    4. a plugin;
    5. an MCP server.

    A new core feature is the last resort.

---

## 6. System overview

```mermaid
flowchart LR
  subgraph Surfaces
    WEB[Web UI]
    DESK[Desktop app]
    CLI[verdandi CLI]
    GW[Messaging gateway]
    API[OpenAI-compatible API]
    ACP[ACP / MCP servers]
  end

  subgraph verdandid["verdandid (local server)"]
    RPC[RPC + auth]
    ORCH[Orchestrator<br/>commands → events → projections]
    ROUTER[Router]
    HREG[Harness registry]
    TOOLS[Verdandi tools]
    DEC[Decision layer<br/>rules · Laya · Jev]
    LEARN[Memory · Skills · Session index · Trajectories]
    WSVC[Workspace<br/>git · worktrees · checkpoints · PTY]
    EXEC[Execution backends<br/>local · docker · ssh · cloud]
    SCHED[Scheduler]
    DB[(SQLite)]
  end

  subgraph Harnesses
    CC[Claude Code harness<br/>Agent SDK → your claude CLI]
    NAT[Native harness<br/>Verdandi agent loop]
    OTH[Codex · OpenCode · ACP agents]
  end

  subgraph Providers["Model providers (native harness)"]
    ANT[Anthropic API]
    OAI[OpenAI / compatible]
    GOO[Google]
    ORT[OpenRouter]
    LOC[Local: Ollama · vLLM · LM Studio]
  end

  LAB[lab/ — Python<br/>datasets · router training · fine-tuning]

  WEB & DESK & CLI & GW & API & ACP --> RPC --> ORCH
  ORCH <--> ROUTER
  ROUTER -.-> DEC
  LEARN -.-> DEC
  ORCH --> HREG --> CC & NAT & OTH
  NAT --> ANT & OAI & GOO & ORT & LOC
  NAT --> TOOLS
  CC -. MCP .-> TOOLS
  TOOLS --> LEARN & EXEC & WSVC & SCHED
  SCHED --> ORCH
  ORCH <--> DB
  LEARN -. export files .-> LAB
  LAB -. trained router / models .-> ROUTER
```

| Component | Responsibility |
|---|---|
| **verdandid** | One local process per profile that owns all state and every session. All the surfaces are thin clients. It runs inside `verdandi` while you chat, or always on under `verdandi start` or the desktop app (§11). |
| **Orchestrator** | Turns commands into events and events into projections. Side effects happen only in *reactors*. |
| **Router** | A pure function from `(signals, policy, thread state, catalog, budget)` to a `RouteDecision`. The classifier is passed in from outside, so the router itself stays pure. |
| **Decision layer** | Answers small typed questions (pick one, score, yes/no) with calibrated probabilities. It uses local or cloud decision models instead of LLM calls (§9.8). |
| **Harness registry** | Holds one adapter per harness: Claude Code, native, and later others. Each declares its capabilities. |
| **Native harness** | Verdandi's own agent loop. It handles tool use, subagents, context management and prompt caching across providers. |
| **Model providers** | Adapters for each API format, the model catalog, credentials, fallbacks and health checks. Used by the native harness and for auxiliary tasks. |
| **Verdandi tools** | Memory, skills, session search, scheduling, escalation and so on. Each tool is implemented **once**. The native harness calls it directly; other harnesses reach it over MCP. |
| **Learning** | Memory, session search, the skill lifecycle, background review, and recording trajectories. |
| **Execution backends** | Where the native harness runs commands: locally, in Docker, over SSH, or in a cloud sandbox. |
| **Scheduler** | Runs tasks on a schedule, without you present. |
| **Surfaces** | The terminal chat (the default), web and desktop GUI, CLI commands, messaging gateway, OpenAI-compatible API, and ACP and MCP servers. |
| **lab/** | Python, offline. Builds datasets, trains the router, and optionally fine-tunes models. It exchanges data with the app **only through files**. |

---

## 7. Domain model

```
Profile ─┬─ Project ─┬─ Thread ─┬─ Task ─┬─ Turn ─── Item (message | tool call | approval | plan | …)
         │           │          │        ├─ RouteDecision (1)
         │           │          │        └─ TaskOutcome (1)   → Trajectory (export)
         │           │          └─ HarnessSession (resumable, 0..n)
         │           └─ RoutingPolicy (project layer)
         ├─ Memory · Skills · Schedules · Channels (gateway bindings)
         └─ Credentials refs · Provider config · Budget
UsageRecord ── per turn → rolled up per task / thread / project / day
```

- **Profile:** a completely separate Verdandi home, e.g. `work` vs `personal`. Each has its own database, memory, skills, credentials and gateway bindings.
- **Project:** a folder you work on, usually a repo. A thread that isn't about one project runs in the profile's **workspace** (`<home>/workspace`, §13): chat, chores, gateway conversations and scheduled jobs. The workspace is stored as a project like any other, so every feature works there.
- **Thread:** a lasting conversation. It can have a worktree, and a channel binding (e.g. a Telegram chat).
- **Task:** the unit of routing. A task is a continuous run of turns under **one** `RouteDecision`. A new task starts when:
  - a thread starts,
  - the phase changes (plan → implement → verify),
  - you override the route,
  - the router escalates or de-escalates,
  - the work changes sharply,
  - or the thread switches harness or provider.
- **HarnessSession:** the harness's own session handle, e.g. a Claude Code session ID or a native session ID. A thread may use several over its life.

**Why routing works per task:** per turn loses the cache, and per thread can't adapt as the work changes (§8.2).

---

## 8. Task-based routing

### 8.1 The decision

```ts
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Access = "subscription" | "metered" | "local";

interface RouteTarget {
  harness: HarnessId;      // "claude-code" | "native" | "codex" | …
  provider: ProviderId;    // "claude-subscription" | "anthropic-api" | "openrouter" | "ollama" | …
  model: string;           // "sonnet" | "claude-sonnet-5-5" | "qwen3-coder" | …
  access: Access;
}

interface RouteDecision {
  taskId: TaskId;
  taskClass: TaskClass;            // §8.4
  difficulty: number;              // 0..1
  confidence: number;              // 0..1
  target: RouteTarget;
  effort: Effort;
  interaction: "default" | "plan";
  subagents: SubagentProfile[];    // each with its own RouteTarget + effort
  escalation: EscalationPolicy;    // §8.7
  limits?: { maxTurns?: number; maxCost?: number };
  estimate: { tokens: number; cost: EffectiveCost; switchCost: EffectiveCost };
  reason: string;                  // one sentence, shown in the UI
  trace: RuleTrace[];
  source: "pin" | "policy" | "escalation" | "deescalation" | "memory" | "learned";
}
```

### 8.2 Levers, from least to most disruptive

| # | Lever | Effect on the cache | Mechanism |
|---|---|---|---|
| 1 | **Subagent routing:** send exploration, search and review to cheaper or stronger subagents | Main thread's cache untouched | Claude Code: `agents` with a `model` per agent. Native: `delegate_task`, routed per child. |
| 2 | **Effort:** same model, more or less thinking, set per task and, where the cache allows, adjusted per turn (§8.7) | Claude Code: system and tools stay cached, the conversation is re-written (ADR 0002). Other harnesses: verify per provider. | Effort setting for the harness |
| 3 | **Plan / execute split** | Switch happens at plan approval, a natural boundary | Plan mode, then a model switch |
| 4 | **Switch the main model** mid-thread | Full cache miss | Only if it passes the switch-cost gate |
| 5 | **New session with a handoff**, possibly on another **harness or provider** | Starts a new, small context | Fresh session, seeded with a structured handoff summary |

**Why route per task and not per turn.** Earlier projects point the same way:
- Hermes Agent shipped per-turn routing of short, simple messages to a cheap model, then removed it in April 2026. It had been opt-in and off by default, and it conflicts with that project's rule that the prompt stays cached for the whole conversation.
- Cursor's router and GitHub Copilot's Auto mode both include the cost of breaking the cache when they decide. They switch only at cache boundaries, or when the task has changed a lot.

**Handoff format for lever 5.** The summary always has the same sections: *Goal, Constraints, Progress, Decisions, Files touched, Open issues, Next steps.* A cheap auxiliary model writes it (§9.7). The old transcript stays searchable through `session_search`.

**Baseline to beat:** often the best option is the strongest model at lower effort, because a single model keeps a single cache. The router must beat this baseline (§8.10).

### 8.3 Effective cost across access modes

Each access mode has a different kind of cost. The router turns them all into one `EffectiveCost`, so they can be compared:

| Access | What it really costs | How the router prices it |
|---|---|---|
| **metered** (API credits) | Dollars | List prices from the catalog, with cache reads and writes priced separately |
| **subscription** (Claude Code CLI) | Usage limits | **Priced by how much quota is left.** When there's plenty left, the price is low and fixed. As the limit gets close, the price rises smoothly, so remaining quota goes to the tasks that need it most. |
| **local** (Ollama, etc.) | Time and hardware; lower quality | Close to zero, plus a latency cost and a quality penalty. Both are learned per task class from outcomes. |

The budget mode (Thrifty, Balanced or Max) sets how these weigh against each other. The policy can also forbid cheaper fallbacks for specific work, e.g. "never send billing code to local models".

### 8.4 The pipeline

```mermaid
flowchart TD
  IN[New task] --> P0{Stage 0<br/>Pin?}
  P0 -- yes --> OUT
  P0 -- no --> P1[Stage 1: Candidates and constraints<br/>harness capabilities · context size · quota · provider health · policy restrictions]
  P1 --> P2[Stage 2: Signals]
  P2 --> P3[Stage 3: Classify<br/>class · difficulty · confidence]
  P3 --> P4[Stage 4: Policy + effective cost<br/>pick cheapest candidate meeting the class's quality bar]
  P4 --> P5{Stage 5: Switch-cost gate}
  P5 -- switch --> OUT[Stage 6: Emit · persist · explain · apply]
  P5 -- stay --> ALT[Keep target;<br/>adjust effort / delegate] --> OUT
```

- **Stage 0 · Pins.** Your explicit choice always wins. Sources: a thread pin from the picker, or a leading `@name` in a message (`@opus`: a catalog model on a running harness; later also `@local` / `@native`), which pins only the task that message starts and leaves the thread's pin alone.
- **Stage 1 · Candidates.** Start from every target that is configured. Remove the ones that:
  - **lack a needed capability**, such as tools, vision or a 1M context (e.g. Haiku 4.5's 200K window is too small);
  - **are out of quota or unhealthy**, meaning rate-limited or down, according to provider health (§9.5);
  - **are forbidden by policy**, e.g. local models for security reviews.
- **Stage 2 · Signals.** These are cheap and extracted locally:
  - *Text:* intent words, stack traces, file references, and phrases like "think hard" or "quick".
  - *Workspace:* repo size, languages, whether a verifier exists.
  - *Thread:* earlier classes and outcomes, the current target, **how much context is already cached**.
  - *Mode:* Ask / Plan / Build.
  - *Attachments:* how many images are attached; any image drops the targets without vision in stage 1.
  - *Routing memory:* how similar tasks in this project went before (§8.8).
- **Stage 3 · Classify.** The classifier is pluggable:
  - `rules`: free, deterministic, with golden tests. This is the default.
  - `decision`: the decision layer (§9.8). One request asks a pick-one question for the task class and a score question for difficulty. The probabilities that come back are **calibrated**, so the confidence threshold below means what it says. It runs on local Laya, or on Jev if you've turned it on.
  - `api`: Haiku or another cheap metered model, with structured output. This is the fallback when the decision layer isn't confident enough.
  - `learned`: a Laya model fine-tuned in `lab/` on our own outcomes (§8.8), served through the decision layer.

  If confidence is below a threshold, the router uses the budget mode's safe default instead of guessing.
- **Stage 4 · Policy and cost.** The policy sets a **quality bar** for each class, meaning which targets and efforts are acceptable. Among the candidates that meet it, the router picks the lowest effective cost.
- **Stage 5 · Switch-cost gate.** Suppose the thread already has a warm session and the policy picks a different target. The router switches only when either:
  1. the policy needs a *more capable* target, or
  2. the expected savings are greater than the switch cost (re-reading the cached context, plus the handoff).

  Otherwise it stays put and saves another way: lower effort, or cheaper subagents.
- **Stage 6 · Emit.** Save the decision, show its reason, and apply it.

Stages 1–5 are pure and fast, so the composer shows a **live routing preview while you type**.

### 8.5 Task taxonomy (v1)

| Class | Examples | Balanced route (Claude-only setup) |
|---|---|---|
| `ask.search` | "Where is the auth middleware?" | Haiku · low |
| `ask.explain` | "What does this reducer do?" | Sonnet · low |
| `chore.git` | Commit message, PR description | Haiku · low (local model if one is configured) |
| `docs.write` | README, changelog | Sonnet · low |
| `code.edit.mechanical` | Renames, moves, simple CRUD | Sonnet · low (+ Haiku explorers) |
| `code.edit.local` | Bug fix or small feature in 1–3 files | Sonnet · medium |
| `test.write` | Adding tests | Sonnet · medium |
| `code.feature` | Multi-file feature | Plan: Opus · high → Execute: Sonnet · medium |
| `code.refactor.large` | Cross-cutting refactor | Plan: Opus · high → Execute: Sonnet · high |
| `debug.investigate` | Unknown root cause | Opus · high |
| `review` | Code or security review | Opus · medium |
| `design.architecture` | Designs, trade-offs | Opus · high (Fable in Max mode) |
| `chat.general` | Gateway chit-chat, quick questions | Cheapest acceptable (local or Haiku) |
| `aux.*` | Titles, commit messages, handoffs, compression, vision, background review, judging whether a command is safe, classification | Set per aux task (§9.7); `aux.review`: Haiku · low |

**Budget modes:**
- **Thrifty** moves routes one step down and makes local models acceptable more often.
- **Balanced** uses the table as shown.
- **Max** moves routes one step up, and makes Fable eligible for design and debugging work.

### 8.6 Catalog and policy as data

**Catalog.** A bundled data file, refreshed from provider model APIs. It records, per model:
- which harness can run it,
- which provider serves it,
- its context window,
- prices (input, output, cache read, cache write), each with the day it took effect: a price change, or an alias moving to another model, adds one and keeps the old, so the savings estimate prices each task at the price of the day it started; routing uses the latest,
- capabilities (tools, vision, thinking, effort levels),
- its access mode.

Current Claude entries:

| Tier | Model | Via Claude Code (subscription) | Via Anthropic API ($/MTok in · out) | Context | Default effort |
|---|---|---|---|---|---|
| S | Claude Haiku 4.5 | `haiku` | 1 · 5 | 200K | n/a |
| M | Claude Sonnet 5.5 | `sonnet` | 2 · 10 | 1M | high |
| L | Claude Opus 5.5 | `opus` | 4 · 20 | 1M | **medium** |
| XL | Claude Fable 5.1 | `fable` | 10 · 50 | 1M | high |

Defaults differ between models, so **the router always sets effort explicitly**. Levels differ too: Haiku 4.5 takes none, so its harness ignores the effort, and the others take `low` to `max` (read from Claude Code 2.1.272's model table). The router never routes to a level a model doesn't take: it moves to the nearest one the model does, with a note in the trace, and a policy that asks for one fails to load, naming the key.

**Policy.** Policies are layered, and each layer overrides the one before:
1. built-in defaults
2. profile policy
3. project policy (`.verdandi/routing.yaml`)
4. thread pin

```yaml
# <repo>/.verdandi/routing.yaml
mode: balanced                       # thrifty | balanced | max
classifier: rules                    # rules | decision | api | learned
minConfidence: 0.6
memory: { minTasks: 5, minShare: 0.5 }   # routing memory (§8.8) acts once 5 tasks of a class ran on a route and half were moved or failed

targets:                             # named targets used below
  cc-haiku:   { harness: claude-code, provider: claude-subscription, model: haiku }
  cc-sonnet:  { harness: claude-code, provider: claude-subscription, model: sonnet }
  cc-opus:    { harness: claude-code, provider: claude-subscription, model: opus }
  api-sonnet: { harness: native, provider: anthropic-api, model: claude-sonnet-5-5 }
  local-code: { harness: native, provider: ollama, model: qwen3-coder }

routes:
  chore.git:          { prefer: [local-code, cc-haiku], effort: low }
  debug.investigate:  { prefer: [cc-opus], effort: high, effortBand: [medium, max], thrifty: { prefer: [cc-sonnet], effort: high } }
  code.feature:
    prefer: [cc-sonnet, api-sonnet]  # executing
    effort: medium
    plan: { prefer: [cc-opus], effort: high, max: { effort: xhigh } }   # tasks started in plan mode
    tokens: 800000                   # rough task size, for cost estimates and the switch-cost gate
    subagents:
      explorer: { prefer: [cc-haiku], effort: low }
      reviewer: { prefer: [cc-opus], effort: medium }

quota:
  subscription: { spillTo: [api-sonnet, local-code], spillWhenRemainingBelow: 0.15 }

escalation:
  verifiers: ["bun test", "bun run typecheck"]
  ladder: [effort, model, ask]
  maxAutoEscalations: 1
  repeatedErrors: 3                   # the same tool error this many times in a task escalates it; 0 never

restrictions:
  - match: "packages/billing/**"
    forbid: [local]                   # never route billing code to local models
    minTier: L

fallback: { prefer: [cc-sonnet], effort: medium, max: { prefer: [cc-opus] }, maxCost: 5 }   # safe default below minConfidence; maxCost/maxTurns apply to classes that set none (§8.9)
```

A class's route is its Balanced route. `thrifty` and `max` change only the keys they set for those modes, and `plan` does the same for tasks started in plan mode. Layers merge key by key, except `restrictions`, which add up, so a project can't lift a profile's restriction. Unknown keys are errors that name the file and the key. `subagents` routes a class's subagent profiles, `explorer` and `reviewer`, each to the cheapest available target it prefers on the main route's harness, at its own effort or the task's. A harness session keeps the subagents it started with, so a new policy reaches a thread at its next fresh session (ADR 0014). `escalation.verifiers` run after a turn whose agent changed files, `escalation.repeatedErrors` says how many times the same tool error comes back in a task before that escalates it, and `escalation.ladder` and `maxAutoEscalations` set what a routed task tries when a trigger fires (§8.7); `effortBand` and `quota` are rejected until the features behind them land (§8.7, §8.9).

### 8.7 Escalation and de-escalation while a task runs

**Escalation triggers**, strongest signal first:
1. A verifier (tests, typecheck, build) fails after the agent says it's done.
2. The same error repeats.
3. You reject a diff, revert, or push back.
4. The agent calls `report_blocked`.

Research shows that turn count alone is barely better than chance at predicting failure, so it is used **only as a budget guard**.

**The escalation ladder:**
1. raise effort to the next level the model takes,
2. then move to a stronger model on the same harness,
3. then ask you.

By default, at most one step happens per task without asking you. A step changes the running task's route; the task stays one task, so routing memory counts the escalation against the route it started on (ADR 0018). Only routed tasks escalate: a pinned route is yours. A step always passes the switch-cost gate (§8.4 stage 5), since it asks for a more capable target. The escalation's reason names the trigger, and the task's outcome records each one that fired.

Built so far:
- **Triggers 1, 2 and 4** fire at a turn's end: a verifier on the project's `escalation.verifiers` fails (they run when the turn changed files by any means, read from its start checkpoint against the folder once its agent is done; a folder outside git has no checkpoints, so there its agent's file-tool calls say); the same tool error (paths, numbers and ids stripped) comes back `escalation.repeatedErrors` times across the task's turns since it last escalated, a cheap local count with no model call; or the agent calls `report_blocked`. A turn end fires at most one, the strongest. Verdandi sends the next turn itself, handing the agent the failed verifier's output, the repeated error or its own blocked report, as data. Past the limit the step is `ask`, shown on the turn.
- **Trigger 3, pushback:** a follow-up the decision layer reads as correcting the agent (§9.8, above its question's confidence minimum) escalates the task one step before that follow-up runs, so the correction runs on the stronger route; it wins over de-escalation. Past the limit, or when a reached spend cap stops the stronger route, the follow-up just runs: you are already steering. Rejecting a diff or a plan doesn't escalate yet. A revert ends its task, so it counts only in routing memory, as a task that didn't succeed, and the thread's next task is routed as usual.

The route chip shows an escalated task's reason and undoes the escalation in one click: back to the route it escalated from, from the next turn. That is you picking a route, so it pins the thread and counts as the task's override (`verdandi chat` prints the flags that do the same).

**De-escalation** moves a routed task down without starting a new one, at two points:
- **Plan approval.** The build moves to the class's own route (§8.2 lever 3, ADR 0013).
- **After the verifiers pass.** When a turn's verifiers all passed, the decision layer classifies the next turn of the task. If it is mechanical work (`chore.git`, `code.edit.mechanical`, `docs.write`: a commit, a rename, a changelog), the router routes it as that class on the task's harness. The task moves only to a *less capable* model, never up and never by effort alone, and only through the switch-cost gate (§8.4 stage 5). The gate weighs what the chore saves against re-reading the cached context on the new model. On Claude Code that blocks most moves: the policy's chore is small (`tokens`), and the session's cached context soon outgrows it. The router's trace then says it stays and why. An allowed move is recorded as `task.deescalated` and shown between the turns as a route change by the router, with its reason. The task stays one task on the same session, so routing memory counts it on the route it started on.

Pinned threads, and tasks pinned with `@name`, never de-escalate.

**Untrusted input floors the route.** Smaller models are easier to hijack, so a warm session that has read untrusted input (§17) never moves below the policy's `untrusted` floor (built in: `minTier: M`, `forbid: [local]`) while it has tools that write files or run commands. That holds for de-escalation, a plan's build route, and a new task that keeps the session on its harness; a new session on another harness starts clean, and a pin still wins. The floor adds up across policy layers like `restrictions`, so a cloned repository's `routing.yaml` can raise it but not lower it. The reason names the source and turn (`…, but this session read untrusted input (WebFetch, turn 3), so it stays on sonnet.`), and `task.started` records it for replay.

**Auto effort within a task.** The model is chosen per task, because switching it breaks the cache. Effort is cheaper to move, so on harnesses that can change it mid-session without a cache miss, the router also sets effort **per turn**, inside the band the task's route allows:
- **Down** for turns that are clearly light: a confirmation, "yes, go on", a rename the agent already planned, a commit after verifiers pass.
- **Up** for turns that are clearly heavy: a new stack trace, "think hard", a failing verifier, a design question in the middle of an edit.
- **Otherwise** it stays at the route's effort.

The band is one step either side of the route's effort by default, and the policy can widen, narrow or disable it per class (`effortBand` in `routing.yaml`). The signals are the same cheap local ones as Stage 2, so this adds no model call to the turn. Each change is persisted with a one-line reason and shown on the turn, like any routing decision, and a pinned effort turns auto effort off for that thread.

Per harness:
- **Claude Code:** not supported. An effort change mid-session re-writes the whole conversation to the cache (ADR 0002), so effort is set per task, and a mid-task change passes the switch-cost gate.
- **Native:** supported; effort is a per-request parameter, subject to the same cache check per provider.
- **Other harnesses:** only if `inSessionEffortSwitch` is true and the cache survives; otherwise effort stays fixed for the task.

Raising effort one step through auto effort does not count as the escalation ladder's first step; escalation is about the task failing, auto effort is about the turn's size.

### 8.8 Learning loop for routing

Every task produces a `TaskOutcome`:

```ts
interface TaskOutcome {
  taskId: TaskId;
  status: "completed" | "abandoned" | "reverted" | "escalated" | "failed";
  implicitSatisfaction: number;   // moved on / committed (+) vs. correction follow-ups (−)
  userOverride?: { from: RouteTarget & { effort: Effort }; to: RouteTarget & { effort: Effort } };
  verifierRuns: { command: string; passed: boolean }[];
  escalations: number;
  triggers: { trigger: "verifier" | "blocked"; step: "effort" | "model" | "ask" }[];
  usage: UsageBreakdown;          // tokens, cache read/write, cost, quota units, by model
  wallMs: number;
  rating?: 1 | -1;
}
```

Outcomes are recorded from M1 on, before the router exists, so the always-default baseline is measured on real work (`packages/contracts/src/task.ts`). The status is the task's last turn's, except that a task whose last verifier run failed is `failed`; satisfaction counts only the corrections Verdandi sees (steers, interrupts, rejected or edited plans, a route override, and follow-ups the decision layer judges to be correcting the agent); `verifierRuns` lists the project's verifiers as they ran; `escalations` counts the task's escalation steps, and `triggers` lists each escalation trigger that fired and the step it took; `rating` is the user's latest thumbs up or down on the task (`task.rate`), and quota units stay empty. `verdandi costs` shows cost per completed task by route.

These outcomes are used at three levels:
1. **Routing memory per project** (M2), e.g. "debug tasks on Sonnet escalated 7 times out of 10, so start on Opus". A task the user rated down counts as one that didn't succeed.
2. **Offline replay:** re-run the router over saved tasks to see how a policy change would have routed them (`verdandi routing replay`). Each `task.started` keeps the router's inputs, so a replay routes a task exactly as it was routed, and prices its recorded tokens on the new target as an estimate.
3. **A learned router** (M6). Recorded outcomes become fine-tuning data for a Laya decision model in `lab/`. The fine-tuned model is exported to ONNX and runs in a decision worker process through `onnxruntime-node` (ADR 0009); the composer's live routing preview asks verdandid. The learned router is adopted only if it beats `rules` on the eval set.

### 8.9 Budgets

- **Metered:** real dollars. Daily and monthly caps per profile, and per project, in the profile's `spend-caps.yaml` (`daily`, `monthly`, and the same under `projects` keyed by folder). They count metered usage since the local day or month began, including subscription turns on extra usage, and never subscription usage. While one is reached, a turn that would spend metered dollars (a metered target, or a subscription running on extra usage) is rejected with a message naming the cap, the spend and how to raise it, and the router leaves those targets out of new tasks, saying why. Subscription and local turns go on. Raising a cap adds its configured amount for the rest of the period in one click (or `verdandi chat --raise-cap`), recorded as the user's override. The web composer and `verdandi chat` show how close the thread's project and profile are to their caps.
- **Subscription:** quota tracking from Claude Code's rate-limit events and usage request (ADR 0005), quota-based pricing, and moving work to other targets when quota runs low (§8.3). When the plan window is used up and the account's extra usage is on, Claude Code keeps working on paid credits without an error; Verdandi prices those turns as metered and shows the switch.
- **Per task:** `maxTurns` and `maxCost` per class in the routing policy, with `fallback`'s as the default (Claude Code: `maxBudgetUsd` and `maxTurns`). A task a guard stops ends its turn with status `limit`, kept on its outcome, and the thread's next turn starts a new task.
- **The spend dashboard** shows real spend, quota use, and savings vs. always-Opus. The savings figure is labelled as an estimate.

### 8.10 Evaluation

- **Eval set:** 30–100 real tasks, each with a verifier, in a YAML file of `{ id, repo, commit, prompt, verify, setup?, mode? }`. `verdandi batch <file>` runs each task on each route in a throwaway `git clone --shared` of its repository at the pinned commit, which keeps only its detached `HEAD` (no other refs, no remote, no reflog) so the agent can't read later history, with `verify` as its project verifier (so routed runs escalate) in place of any the repository's policy names, which a batch never trusts (§17), handed to the run in-process and never written into the copy, where the agent could read it, then grades it by running `verify` on the final tree. A run has its own Verdandi home under the profile's `batch/`, so its threads and routing memory stay apart from yours; the profile's spend caps apply, and `--dry-run` prints a rough cost estimate first.
- **Baselines** (ADR 0017 records M2's measurement against (a) and (b)):
  - (a) always Opus at default effort,
  - (b) always Sonnet at `high`,
  - (c) the strongest model at lower effort,
  - (d) a random router spending the same amount.
- **Metrics:** success rate, cost per completed task, time, override and escalation rates, and the cost–quality curve with its APGR.
- **Race mode:** run the same task on two routes in parallel worktrees. This improves quality directly, and every race also produces a labelled preference pair (§14.6).

---

## 9. Harnesses and model providers

### 9.1 Concepts

- **Harness:** runs the agent loop, meaning it plans, calls tools and edits files.
  - *External* harnesses bring their own loop and authentication: Claude Code, and later Codex, OpenCode and ACP agents.
  - The *native* harness is Verdandi's own loop.
- **Model provider:** where inference happens. The native harness and auxiliary tasks call providers directly. External harnesses reach their models themselves.
- **Access mode:** `subscription`, `metered` or `local` (§8.3).

Claude is reachable in **two** ways:
1. **Claude Code harness:** your subscription, through your installed CLI.
2. **Native harness:** Anthropic API credits.

The router can choose between them. For example, it can move work to API credits when subscription quota runs low.

### 9.2 Harness contract

```ts
interface HarnessAdapter {
  readonly id: HarnessId;
  readonly capabilities: {
    inSessionModelSwitch: boolean;
    inSessionEffortSwitch: boolean;
    planMode: boolean;
    subagentRouting: boolean;
    rollback: boolean;
    mcpClient: boolean;             // can reach Verdandi tools over MCP
    costReporting: "usd" | "tokens" | "none";
  };
  targets(): Promise<RouteTarget[]>;          // what this harness can run
  startSession(input: StartSessionInput): Promise<SessionHandle>;
  sendTurn(s: SessionHandle, turn: TurnInput): Promise<void>;
  steer(s: SessionHandle, message: string): Promise<void>;   // guidance while the agent is working
  applyRoute(s: SessionHandle, d: RouteDecision): Promise<ApplyResult>;
  interrupt(s: SessionHandle): Promise<void>;
  respond(s: SessionHandle, requestId: string, r: ApprovalResponse | UserInputResponse): Promise<void>;
  rollback?(s: SessionHandle, toTurn: number): Promise<void>;
  stop(s: SessionHandle): Promise<void>;
  events(s: SessionHandle): AsyncIterable<HarnessEvent>;     // normalized
}
```

`ApplyResult` reports whether the route was applied in the running session, by restarting and resuming, or as a new session with a handoff. That lets the switch-cost gate price the switch correctly.

### 9.3 Claude Code harness

- **Transport:** the Claude Agent SDK for TypeScript, in streaming-input mode, with `pathToClaudeCodeExecutable` pointing at **your installed `claude`**. Your authentication, settings, plugins, MCP servers, CLAUDE.md files and skills all apply unchanged, with one exception: claude.ai connectors are switched off (`disableClaudeAiConnectors`), because they attach nondeterministically and would change the tool list between turns (ADR 0001). Raw stream-JSON is kept as a fallback.
- **Routing controls:**
  - model via `setModel()`;
  - Ask / Plan / Build via `setPermissionMode()`, between turns: Ask and Plan run in Claude Code's read-only plan mode, Build in the user's own default mode. `ExitPlanMode` becomes a plan approval request;
  - effort per task through the `effort` option; a mid-task change through `applyFlagSettings({ effortLevel })` (ADR 0002);
  - subagents via `agents`, each with its own `model`.
- **Approvals:** `canUseTool` becomes an approval event. `AskUserQuestion` becomes a user-input request.
- **Sessions:** resume, fork, and resuming at a given message. Transcripts stay where Claude Code keeps them; Verdandi stores pointers (the session id, and the file its `UserPromptSubmit` hook reports) and a normalized copy for trajectories. Subagents' messages are forwarded whole (`forwardSubagentText`) and recorded as items tagged with the tool call that started the subagent. A turn ends when Claude Code goes idle, not at its first result, so a background subagent's steps, and Claude Code's answer to them, stay in the turn that started it (ADR 0011).
- **Verdandi tools reach Claude Code over MCP**, through an MCP server running inside verdandid (§9.6). This gives Claude Code sessions Verdandi's memory, session search, scheduling and escalation.
- **Hooks:** only `UserPromptSubmit`, to learn the session's transcript path. Nothing else depends on Claude Code's hooks: verifiers run from the reactor once the agent finishes, the same for every harness (§8.7), and a turn ends when Claude Code goes idle (ADR 0011).
- **Telemetry:** usage per message, and `modelUsage` from the result, go into the usage ledger.

### 9.4 Native harness (Verdandi's own agent loop)

- **The loop:**
  1. Call the model.
  2. Run the requested tools. Tools that are safe to run together run in parallel; interactive ones run one at a time. Results go back in the original order.
  3. Repeat until done, the iteration budget runs out, or you interrupt.
- **Steering:** while the agent is working, you can send guidance. It's delivered after the next tool result, which is a safe point.
- **Rules it never breaks:**
  - the system prompt and tool list stay byte-for-byte identical for the whole session;
  - user and assistant turns strictly alternate;
  - thinking blocks go back unchanged to the model that produced them.
- **Prompt assembly** is fixed for each session:
  - persona (`persona.md`),
  - harness instructions,
  - context files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, in priority order, each scanned for prompt injection),
  - the skills index,
  - the memory snapshot.

  Anything that changes between turns goes into user turns.
- **Tools:** the full Verdandi tool set (§9.6), plus MCP servers you configure. When there are many MCP tools, **tool search** replaces their full schemas with a small search tool, so they don't fill the context.
- **Subagents:** `delegate_task` starts child sessions with fresh context and gets back a summary. **Each child is routed as its own task**, e.g. a frontier model plans and cheap models do the work. Concurrency and nesting depth are limited.
- **Context management:** see §16.
- **Mixture-of-agents (optional, M6):** several reference models give advice, and one aggregator acts on it. It's offered as a route type for hard design questions.

### 9.5 Model provider layer

- **API formats**, built on the official SDKs:
  1. **Anthropic Messages** (`@anthropic-ai/sdk`, ADR 0022): built, the native harness's first provider;
  2. **OpenAI Responses and Chat Completions** (`openai`). This also covers every OpenAI-compatible endpoint: OpenRouter, Ollama, vLLM, LM Studio, DeepSeek, xAI, Groq, Together and others.
  3. **Google Gemini** (`@google/genai`).

  Bedrock, Vertex and Foundry come later, through the same SDKs' platform clients.
- **Internal message format:** normalized content blocks (text, image, tool use, tool result, thinking). Blocks specific to one provider are carried along unchanged, so they can be sent back exactly.
- **Why our own thin layer instead of a generic multi-provider SDK:** cost control depends on provider-specific features, such as cache breakpoints, effort, passing thinking blocks back, cache diagnostics and task budgets. Generic abstractions tend to flatten these away. ADR 0022 confirms it for the first provider: the native harness calls the Anthropic SDK directly, and the internal layer arrives with the second provider.
- **Credentials:** environment variables, the OS keychain, or a `keyCommand` (e.g. a password-manager CLI). Multiple keys per provider rotate when one hits a rate limit. Built so far: the Anthropic key, from `VERDANDI_ANTHROPIC_API_KEY` or the keychain (`verdandi key set anthropic`), never from `ANTHROPIC_API_KEY`, which Claude Code would pick up (ADR 0022). Verdandi's own keys never reach a process it starts.
- **Resilience:** a fallback chain for rate limits, server errors and auth errors, with backoff until the limit resets. Per-provider health feeds router Stage 1.

### 9.6 Verdandi tools: implemented once, available everywhere

| Tool | Native harness | Claude Code and others (via MCP) |
|---|---|---|
| `memory_save`, `memory_search` | ✔ | ✔ |
| `session_search` | ✔ | ✔ |
| `skills_list`, `skill_view`, `skill_manage` | ✔ | ✔ (Claude Code also loads skills natively) |
| `cronjob` (create, list, pause jobs; a job delivers to its own thread's binding, §15) | ✔ | ✔ |
| `report_blocked` | ✔ | ✔ |
| `todo`, `clarify` | ✔ | — (Claude Code has its own) |
| `delegate_task` | ✔ | — (Claude Code has Task subagents) |
| `terminal`, file read/write/patch, search | ✔ (through execution backends) | — (Claude Code has its own) |
| `web_search`, `web_fetch` | ✔ (provider server tools, or Verdandi's own) | — |
| `vision` (describe an image through an auxiliary model) | ✔ | — |
| `execute_code` (a sandboxed script that calls tools through RPC) | ✔ (M6) | — |
| `browser` | ✔ (M6, Playwright) | — |

### 9.7 Auxiliary tasks

Some jobs are small, but a model still has to do them. They fall into two kinds:

- **Judgments** have a fixed set of possible answers. Examples: routing classification, whether a command is safe, whether a task is worth reviewing. These go to the **decision layer** (§9.8), not to an LLM.
- **Generation** means writing text. Examples: titles, commit messages, handoff summaries, vision descriptions, and the background review itself. These are **routed tasks** (`aux.*` classes) with their own policy entries, so they automatically use the cheapest acceptable target: usually a local model, then Haiku.

### 9.8 Decision layer (System 1)

Verdandi makes a lot of small judgments. What type of task is this? Is this command destructive? Is anything here worth remembering? Sending each one to an LLM is slow and costs tokens. Sending it to a rule is free but brittle. The decision layer sits in between.

It uses **decision models**. A decision model takes some context (the *state*) plus typed questions, and returns typed answers with calibrated probabilities in one forward pass. It never writes text, so there's nothing to parse and nothing to make up. There are three question types:
- **choice:** pick one option from a list;
- **score:** place the state on a scale;
- **noul:** yes or no, answered as a probability.

**Interface.** A `Decide` service takes `(state, questions)` and returns answers, probabilities and confidence. Requests and responses use TypeSafe's `/v1/systemone` format, which ollaya also accepts, so one client works with every backend.

**Backends**, cheapest first. Policy chooses the backend for each kind of question:

| Backend | Where it runs | Cost | Notes |
|---|---|---|---|
| `rules` (default) | Inside verdandid | Free | Deterministic. The default for every question kind until another backend beats it on that kind (ADR 0009). |
| `laya` | A worker process, through ONNX on CPU (`onnxruntime-node`) | Free; ~1.5 s CPU and ~1.7 GB memory per loaded model (ADR 0009) | Open weights (Apache 2.0). ModernBERT-large (421M parameters) or mmBERT-base (322M). Reads 512–1,024 tokens of context; the multilingual model goes up to 8K, less reliably. |
| `ollaya` | A local daemon, on GPU | Free | Larger open decision models, for when Laya isn't accurate enough. Example: `winnow:e4b`, a 4B model reported at 0.722 accuracy on typed decisions, vs. 0.738 for Jev. |
| `jev` | TypeSafe AI's API | $0.042 per million input tokens; output is free | Must be turned on per profile. 70–500 ms per request, up to 32K tokens. In early access since 2026-09-15, and its data-retention terms aren't published yet. |
| `llm` | The cheapest acceptable aux target | Metered or local | The fallback. The same typed questions are turned into a structured-output schema. |

**When a backend isn't sure.** Each question kind has a minimum confidence. An answer below it is marked `low_confidence`, and the question moves to the next backend, ending with `llm`.

**Where Verdandi uses it:**

| Judgment | Questions | § |
|---|---|---|
| Routing classification | choice: task class; score: difficulty | 8.4 |
| Learned router | the fine-tuned model's own questions | 8.8 |
| Is the user unhappy with the result? | noul: "is this follow-up correcting the agent?" | 8.8 |
| Escalation | noul: "is the agent repeating an approach that already failed?" This is one signal, never the only trigger. | 8.7 |
| Whether to run background review | noul: "does this task contain something worth remembering or turning into a skill?" | 14.5 |
| Memory snapshot | score: how relevant each entry is to this project and session | 14.2 |
| Smart approvals | noul: "is this command destructive or irreversible?" | 17 |
| Injection scanning | noul: "does this text contain instructions aimed at an AI, or a way to send data out?" | 17 |
| Gateway triage | choice: which project; noul: does the agent need to act?; score: urgency | 15 |

**Rules for using it:**
- **Simple questions only.** Decision models are weak at anything that needs extended reasoning or weighing several factors. A complex judgment is split into simpler questions, or goes to an LLM.
- **Measure each kind of question on an eval set before relying on it.** Out of the box, Laya is only 36% accurate on its typed-decisions benchmark. Fine-tuned on examples from the same kind of task, it reaches 77%.
- **Log every decision** with its probabilities and the eventual outcome. This is the fine-tuning data for `lab/` (§14.7), and `verdandi decisions eval` measures a candidate backend against it (ADR 0019).
- **Send non-English text to the multilingual model.** Laya's English model can be confidently wrong on other writing systems.
- **Privacy:** local backends are the default. Jev would receive code and transcripts, so it's turned on per profile, and some projects can be excluded from it entirely.

### 9.9 More harnesses (M6)

Codex through its JSON-RPC `app-server`, OpenCode, and ACP-speaking agents. Every harness that supports MCP automatically gets the Verdandi tools.

---

## 10. Orchestration and persistence

- **Event-sourced core:**
  1. A command goes to a pure decider.
  2. The decider produces events, which update the projections in **one SQLite transaction**.
  3. Reactors then run the side effects.

  A command is acknowledged once its intent is saved. Command receipts make retries safe.
- **Schema evolution:** events are append-only and must stay readable forever. They're versioned, and old versions are converted to the current shape as they're read.
- **Tables:**

  | Group | Tables |
  |---|---|
  | Log and receipts | `events`, `command_receipts` |
  | Projections | `projects`, `threads`, `tasks`, `turns`, `items`, `requests` (approvals and questions) |
  | Routing | `route_decisions`, `task_outcomes`, `routing_memory` |
  | Usage and providers | `usage_ledger`, `quota`, `provider_health` |
  | Learning | `memories` (+ FTS5), `session_index` (FTS5, including a trigram index for Chinese, Japanese and Korean text and for substring search), `skills`, `skill_runs`, `trajectories` |
  | Automation | `schedules`, `schedule_runs`, `channels`, `channel_bindings` |

- **Location:** one database per profile, at `~/.verdandi/profiles/<name>/verdandi.db`, in WAL mode, with numbered migrations. verdandid is its only writer and keeps the WAL under `journal_size_limit` once a checkpoint has run; `verdandi doctor` shows both files' sizes and warns when the WAL has grown far past it, which means something else is holding the database open.

---

## 11. Surfaces

| Surface | Purpose | Milestone |
|---|---|---|
| **Terminal chat** (`verdandi`, also `verdandi chat`) | The default surface: chat, steer, approve, plans, diffs, revert, on the current folder when it's a project and in the workspace otherwise (§13) | M1 |
| **CLI commands** (`verdandi <command>`) | `start` (always-on verdandid), `web`, `doctor`, `run "<task>"` (headless), `batch` (eval and trajectory runs), and the rest | M1 → M6 |
| **Web UI** (`verdandi web`) | An optional workspace GUI: threads side by side, diffs, terminal, dashboards. Its own small server, run only when wanted; `--host` opens it to the local network or tailnet | M1 |
| **Desktop app** (Electron, `apps/desktop` in this repo) | A thin host for the same UI: it runs the `verdandi` binary as the always-on verdandid, or connects to one on another machine, with tray, notifications and auto-update | M5 |
| **Messaging gateway** | Start, steer and approve tasks from chat apps (§15) | M5 |
| **OpenAI-compatible API** | `model: "verdandi/auto"`, so any tool can use Verdandi as a routed model | M6 |
| **ACP server** | Use the native agent from editors that support ACP | M6 |
| **MCP server** | Expose memory, skills and sessions to other MCP clients | M3 (for Claude Code), then public in M6 |

**Who runs verdandid.** One per profile. Bare `verdandi` and `verdandi run` connect to the one running, or else start one in their own process that stops when they end; meanwhile other clients can connect to it (`verdandi web`) and lose it when the chat quits. Whatever has to outlive a chat needs an always-on verdandid, `verdandi start` or the desktop app: other devices, and in M5 the scheduler and gateway, which only an always-on verdandid starts, so a bot doesn't go offline when a terminal closes.

**The agent serves no web page (ADR 0026).** The agent is the `verdandi` binary, verdandid and the CLI (`apps/agent`): the brain, the terminal chat and the gateway. It listens only on `127.0.0.1`, an API for local clients behind the profile's token, and refuses every browser page. Chatting in the terminal or from a messaging app needs nothing else.

**One UI, thin hosts.** The whole UI is one package, `packages/ui`, which imports only `contracts` and is given an endpoint to talk to. Each host only mounts it and connects it, so a UI change is made once:
- **`apps/web`** is `verdandi web`: a small server that serves the page and relays its RPC and attachments to the agent. The page gets a token of the web server's own, swapped for the agent's on the way through. `--host` opens it to the local network or tailnet through the LAN gate.
- **`apps/desktop`** (M5) bundles `packages/ui` in its window and never depends on `apps/web`. Electron's main process runs the agent binary it ships and holds the token. What only a desktop app can do (tray, OS notifications, open at login, auto-update) reaches the UI through one small preload bridge that it feature-detects, and is absent in the browser.

They share `packages/contracts`, which is why they stay in one repo, as Hermes keeps its agent and desktop app.

**A remote agent (M5).** The desktop app, and later the terminal chat, can talk to an agent on another machine, e.g. one on a VM reached over Tailscale. The agent then opens an API-only listener on a private or tailnet address, never a page, which needs first: per-device pairing and revocable tokens (#215), a protocol version check when a client connects, since the desktop app and a remote agent update separately, and a connection picker in the desktop app (this computer, or a remote agent). The UI marks what lives on the agent's machine: paths, terminals and worktrees are the VM's, and the OS folder dialog is offered only when the agent is on the machine showing the UI. Until then, a browser on another device uses `verdandi web --host`.

**Protocol:** a WebSocket on `127.0.0.1`, with a per-profile token. Typed RPC contracts shared by server and clients:
- `command.dispatch`
- `project.subscribe`, `thread.subscribe` (a snapshot, then a stream of events)
- `diff.*`, `terminal.*`
- `routing.simulate`, `routing.explain`
- `usage.query`

---

## 12. User experience

- **Terminal chat** (the default surface): a terminal UI on OpenTUI (ADR 0027) on the thread for the current folder, or the workspace's. The agent's text streams into a transcript, with a line for each route decision, verifier run, escalation and request; a line under it says what a typed line will do (answer the request, steer the running turn, or send); the composer stays usable while the agent works. Requests are answered there (y/n, a plan edited in `$EDITOR`), and slash commands switch modes and show diffs, revert, rate and attach. `--plain`, or a pipe, gets the same chat as plain lines. Multiline editing, completion, and tool calls and diffs in panes come next.
- **Web UI layout:**
  - rail: opens the projects, search and spend pages, one click from anywhere (profiles join it in M5);
  - sidebar: always lists threads by recency, each with its project, live status and cost;
  - search page: session search (§14.3);
  - projects page: open any folder, or start a thread in a project you've worked in; New thread also offers the workspace;
  - center: the conversation;
  - right panel, switchable: diff, terminal, routing trace, or memory and skills.
- **Composer:**
  - a live **routing preview chip** ("Sonnet · medium via Claude Code — local bug fix, tests present");
  - Ask / Plan / Build toggle;
  - budget-mode switch;
  - `@target` pins;
  - attachments;
  - **steer** (send while the agent is working).
- **Route chip on each task:** shows the reason, the trace and the alternatives, with a one-click override.
- **Plan cards:** approve, edit or reject a plan. Approving shows the route change.
- **Dashboards:**
  - spend and quota;
  - cost per task class;
  - how usage is split across targets;
  - escalation and override rates;
  - estimated savings.
- **Memory and Skills panels:** view, edit and delete memories. Review proposed skills and memories. Skill usage and staleness.
- **Automations panel:** schedules, run history, and gateway channels with their bindings.
- **Performance rules:** no constant animations, small WebSocket messages, virtualized lists.

---

## 13. Workspaces and execution

- **The workspace:** the profile's own folder, `<home>/workspace`, which verdandid creates as a git repo when it starts, so checkpoints, diffs and revert work there. A thread that isn't about one project runs there. `verdandi` and `verdandi run` work on the current folder when it's a project (inside a git repo, or a folder the CLI already has a thread for) and in the workspace otherwise; `--here` and `--workspace` pick one. Gateway conversations and scheduled jobs that name no project run there too (§15).
- **Folders the agent may work in:** the workspace doesn't fence the agent in. `folders` in the home's `workspace.yaml` (e.g. `- ~/Downloads`), read when verdandid starts (a broken file stops it, naming the file and key), are given to every harness session besides its own folder, fixed for the session's life (§5, the cache rule). Claude Code gets them as `additionalDirectories`, so it works there as it does in the thread's folder: it reads freely and edits under the same permission mode. Anywhere else it asks first. The native harness's file tools, once built, follow the same rule. Files outside the thread's folder have no checkpoint, so a revert doesn't restore them. To take a folder back, remove it from the file and restart verdandid; `verdandi start` lists them.
- **Worktrees (per thread, optional):** `git worktree add` on a new branch `verdandi/<thread>` from `HEAD`, under the profile's `worktrees/<repo>/<branch>`. The project's setup command (`setup` in `<repo>/.verdandi/worktree.yaml`, e.g. `bun install`) runs once in each new worktree, once you trust it (§17; until then the thread's next turn asks first), and the thread shows its result. Removing a worktree, or archiving its thread, keeps the branch and refuses while it has uncommitted changes unless you confirm; it can be recreated on its branch. A thread's folder never changes after its first turn, because the harness keeps its session there. Once its thread has been archived longer than the cleanup policy keeps it (`gc.yaml`, 30 days by default), a worktree git kept is removed, never one with uncommitted changes (ADR 0021).
- **Checkpoints:** at the start and end of each turn, the tree is saved to hidden refs `refs/verdandi/checkpoints/<thread>/<turn>/start` and `…/end`, using a temporary index so your branch, staging area and stash are never touched (ADR 0015). A turn's diff is its end against its start, so your own edits between turns never show in it. Checkpoints older than the cleanup policy's `keepDays` are removed daily, except the last `keepTurns` turns' of threads that aren't archived; `verdandi gc --dry-run` and `verdandi doctor` show what goes next.
- **Revert:** to the end of any earlier turn, the conversation only, or the conversation and the files (restored from that turn's end checkpoint, after the current files are checkpointed, so the revert can be undone until the next turn). Reverted turns stay in the log, folded away, and their task's outcome becomes `reverted`. The next turn forks the harness session at that point (Claude Code: ADR 0004).
- **Terminal:** PTYs run in a separate **PTY host** process that verdandid supervises, the same design VS Code uses. That way a crash in native terminal code can't take down the server. The host uses ConPTY on Windows. The UI renders terminals with xterm.js, and a terminal survives UI reloads.
- **Execution backends** decide where the native harness runs commands, set per project:
  - `local` (the default),
  - `docker` (a per-project container),
  - `ssh` (a remote host),
  - cloud sandboxes as plugins (M6).

  Claude Code runs locally at first. Running it inside a container or on a remote host comes later.
- **Windows is first-class.** ConPTY, paths, and worktree paths with spaces are all covered by tests.

---

## 14. Learning: memory, skills and trajectories

### 14.1 Three kinds of learning

| Kind | What it is | Where it runs |
|---|---|---|
| **1. Memory and skills** | Memory, session search, writing and improving skills, background review | Inside verdandid, all the time (TypeScript) |
| **2. Router learning** | Routing memory, then a learned classifier | Statistics in verdandid; training in `lab/` |
| **3. Model training** | Fine-tuning or RL on trajectories | `lab/`, offline, often on a GPU machine |

### 14.2 Memory

- **Built-in stores:** `user` (preferences, conventions) and `project` (architecture facts, gotchas, commands). Each entry records its source (thread and turn) and a last-confirmed date.
- **Fixed-size snapshot:** a capped snapshot leads the first message of each new harness session, so it stays in the session's history (ADR 0016). The caps are per scope (2,000 characters for project memory and 1,500 for user memory), and the stores themselves are capped the same. It doesn't change for the rest of the session, which protects the cache. Anything written during the session shows up in the next session's snapshot. Entries are chosen by recency today; relevance, using a score from the decision layer (§9.8), comes first once that exists.
- **Lookups:** `memory_search` results are added to the current user turn, never to the system prompt.
- **Memory is capped on purpose.** When the cap is reached, a save fails and asks the agent to **consolidate**: merge, rewrite or drop older entries.
- **Periodic nudges:** every *N* turns the agent is prompted to consider saving memory.
- **Background review** (§14.5) proposes memories after tasks.
- **Scanning:** every entry is scanned before it's saved, for secrets, prompt injection and data exfiltration; a hit is refused with the reason. The agent's saves ask you first, unless `approveSaves: false` in the home's `memory.yaml` turns that off (ADR 0025). Everything can be seen, added, edited and deleted in the Memory panel.
- **External memory providers (plugins, M6):** a `MemoryProvider` interface with hooks for:
  - adding a block to the system prompt,
  - prefetching,
  - syncing each turn,
  - session end,
  - before compression,
  - when memory is written,
  - when work is delegated.

  This makes room for user modelling (e.g. Honcho) and vector memories (e.g. mem0). One external provider can be active, always *in addition to* the built-in stores. It runs out of process like any plugin with code (§18), and its system-prompt block follows the cache rule: a provider enabled mid-session adds it from the thread's next harness session, never the running one.
- **Relation to CLAUDE.md:** Verdandi never silently edits CLAUDE.md or AGENTS.md. It proposes changes as diffs for you to approve.

### 14.3 Session search

Every turn from every harness goes into an FTS5 trigram index (ADR 0006): the user's messages and steers and the main agent's replies, not tool output, so past solutions can be recalled across harnesses and projects. A query is matched as one phrase, case- and accent-insensitively, anywhere in a word; under 3 characters it matches nothing. Results are newest first, each a little of its message either side of the match, archived threads included and marked; no LLM call is needed. The web's search page (`#view=search`, opened from the rail) searches as you type and jumps to the turn; `verdandi search <query>` prints the same.

### 14.4 Skills

- **Format:** the Agent Skills `SKILL.md` format (the agentskills.io standard, also used by Claude Code). A skill folder can include `scripts/`, `references/` and `templates/`.
- **Locations:**
  - `~/.verdandi/profiles/<p>/skills/` (yours);
  - `<repo>/.claude/skills/` (project; Claude Code loads these natively);
  - read-only extra folders (e.g. `~/.agents/skills`).
- **Progressive disclosure:** a compact skills index sits in the prompt. `skill_view(name)` loads the whole skill, and `skill_view(name, path)` loads a file inside it.
- **Lifecycle:**
  1. **Propose.** The agent calls `skill_manage` (create, patch, edit, delete, write file), background review proposes skills from finished tasks (§14.5), and `/learn` builds a skill from docs or URLs. Nothing prompts a proposal on a count of turns or tool calls: a counter fires whatever the task was, and skills end up made from fragments. Any automatic trigger for a skill proposal depends on how the task went: its verifiers passed, or the user rated it up.
  2. **Review.** Nothing is added without your approval by default. A linter gives advice.
  3. **Use.** Claude Code picks skills up natively: the project's, and the profile's through a local plugin, as `verdandi:<name>` (ADR 0020). The native harness uses the skills index plus `skill_view`.
  4. **Improve.** When a task fails, a *patch* is proposed only for a skill the task actually used (the use step 5 records), never for one it didn't load; small patches are preferred over full rewrites.
  5. **Curate.** A skill Verdandi created moves from *active* to *stale* after 14 days unused, and to *archived* after 30; skills you wrote, extra folders' and projects' are never touched. A use is the harness loading it (Claude Code: its `Skill` tool call), and makes a stale skill active again. A daily sweep records each move as an event. Archived skills leave the folder the harness loads for `<home>/skills-archive/` and are never deleted; the Skills panel and `verdandi skills` show them, and restoring one (an event too) brings it back with a fresh 14 days. Merging near-duplicate skills is opt-in.
- **Routing link: learn with Opus, repeat with Haiku.** A skill's frontmatter can carry a routing hint, e.g. `verdandi: { route: { prefer: [cc-haiku], effort: low } }`. The hint is checked against outcome tracking like any other route.
- **Skills hub (M6):** a skill is instructions an agent follows plus scripts it may run, so installing one lets a stranger's code and instructions in. It goes through the same gate as the agent's own proposals.
  - **Sources** are a short list in config, such as a curated index or git repos, never an open marketplace, and adding one is something you do explicitly. A shared folder is a source only if it can be pinned by content digest.
  - **Pinning:** each install is pinned to a full commit SHA; a tag or branch is resolved to its SHA at install time and recorded. An update moves the SHA only when you ask.
  - **Review:** installs and updates take the `skill.proposed` path: the path guards, the secret and injection scan, and a diff of every file, scripts included, that you approve. Scanners' verdicts are advice shown on the diff; a clean scan never skips your approval. Where the request lives when a CLI install has no thread is still to decide.
  - **Your edits win:** each installed file's content digest is recorded. If a file changed locally, an update keeps your edit and shows the upstream change as a diff you can take or leave; it never overwrites silently.
  - **Seeing and leaving:** each install records its source and SHA in an event, and the Skills panel and `verdandi skills list` show them. Uninstalling is the way out. The curator moves only skills Verdandi created, so it leaves installed skills alone unless that is changed.
  - Installed skills live in the profile's skills folder, so Claude Code loads them through the profile's plugin (ADR 0020) and the native harness through its skills index.

### 14.5 Background review

Memory and skills grow without the agent having to remember `memory_save` mid-task. Off by default until it's measured: `enabled: true` in the home's `review.yaml` turns it on (read when verdandid starts; a broken file stops it, naming the file and key).

- **When:** after a turn of a task finishes successfully and Verdandi doesn't escalate it, the decision layer reads a short **digest** of the task's turns since its last review, not the transcript: what the user asked and steered, the tools the main agent used and which failed, the verifiers, and the agent's last reply. It answers one typed question (§9.8): "does this task contain something worth remembering or turning into a skill?" The answer is logged like every decision (`decision.recorded`, with the digest as its state). Most tasks answer no, and stop there at no model cost.
- **The review:** a yes starts a **review thread**: a thread in the same project, hidden from thread lists and search, whose one turn is a routed task of its own class, `aux.review` (the built-in policy: Haiku at low effort, with a cost limit). Its cost is that class's in the spend dashboard, apart from the task it reviewed. Spend caps apply like any task's. It never spends metered dollars unless `review.yaml` sets `allowMetered: true`, and it skips a harness whose subscription window is nearly or fully used up. It runs in ask mode with no Verdandi tools, and anything it asks is denied, since nobody is watching (ADR 0023).
- **What it proposes:** its reply is JSON, read as untrusted data: memories to save, routing notes, and skills to create or patch. Each is scanned like a memory save or skill proposal and becomes a pending request on the reviewed thread, which the user allows or declines in the web UI or `verdandi chat`. A memory is saved when allowed (`memory.proposed`); a skill change goes through the skill proposal flow (§14.4). Routing notes are kept as project memory until the router reads notes (§8.8).

With the native harness, the review can be a *fork* of the session that keeps the same tool list, so it reuses the session's prompt cache.

### 14.6 Trajectories and training data

- **Recorded from the first milestone (M1):** every task is saved as a normalized **trajectory**, in any harness. A trajectory contains:
  - the messages, tool calls and tool results;
  - the route that was used;
  - the outcome and verifier results;
  - usage.
- **Export** (`packages/trajectories`):
  - **message JSONL** (OpenAI-style, with tool calls), for fine-tuning;
  - **preference pairs** from race mode and overrides (the route that won vs. the one that lost), for DPO-style training;
  - **routing datasets** (signals → outcome per target), for training the router;
  - **decision datasets** (state, questions, answers, eventual outcome), for fine-tuning decision models;
  - **Parquet**, for analysis.

  Secrets are masked on export, and you can exclude projects.
- **Batch runner:** `verdandi batch tasks.yaml --route a --route b` runs task lists headless on each route, each task in a throwaway `git clone --shared` of its repository (§8.10). It's used for evals, router training data, and generating trajectories on purpose.
- **RL environments (M6+):** the native harness can be wrapped as an environment for RL frameworks from `lab/`.

### 14.7 The lab (Python, offline)

- Lives in `lab/`: a Python project managed with uv, using ruff, ty and pytest.
- **Jobs:**
  - build datasets from exports;
  - train the router: fine-tune Laya on routing outcomes and export it to ONNX;
  - fine-tune decision models for other judgments, from logged decisions and their outcomes;
  - analyse evals;
  - optionally fine-tune *local* generative models.
- **Talks to the app only through files.** Exports go into the lab. Trained artifacts come back out: ONNX classifiers, or models served through Ollama.
- **Never loaded by verdandid,** so the running app stays pure TypeScript.

### 14.8 Terms caution

Anthropic's terms restrict using Claude's outputs to build or train models that compete with Anthropic.
- **Probably fine:** training a *router* on your own routing decisions and outcomes.
- **Probably off-limits:** fine-tuning a local coding model on Claude trajectories, which is distillation. Check the current terms for your plan before doing this.

Trajectories from open or local models don't have this restriction. The exporter records the provider of every turn, so datasets can be filtered by where their data came from.

---

## 15. Always-on: scheduler, gateway, profiles

- **Scheduler:**
  - **When:** schedules can be a duration ("in 2h"), plain language ("every weekday at 7"), a cron expression, or a one-off time.
  - **What each job can have:**
    - skills to load,
    - a route override,
    - a script to run first,
    - `contextFrom` to chain in earlier job outputs,
    - where its output goes: a channel, a thread or a notification, set in the job's config. A job the agent creates with `cronjob` delivers to its own thread's binding; pointing it anywhere else is your edit.
  - **Where:** in the job's project, or in the workspace when it names none (§13).
  - **Who runs them:** only an always-on verdandid (§11).
  - **Unattended runs:**
    - run in worktrees when their project is a git repo other than the workspace,
    - use a restricted permission profile,
    - have a hard budget,
    - are stopped by a watchdog after a period with no activity,
    - **propose** memories for review instead of saving them.
- **Messaging gateway:**
  - One gateway process inside verdandid, with a `PlatformAdapter` for each platform.
  - **Platforms:** Telegram, Discord and Slack first. Then WhatsApp, Signal, Matrix and email as plugins.
  - Each chat is **bound to a thread**, and the thread's replies go to that chat. Approvals appear as buttons. A new conversation starts as a thread in the workspace (§13); triage can move it to a project.
  - **The model never names a destination.** No tool lets the agent send a message to a channel of its choosing: gateway messages are untrusted data, and an injected instruction plus such a tool would be a way to send your code or memory out.
  - **Triage:** the decision layer sorts incoming messages by project, by whether the agent needs to act, and by urgency (§9.8).
  - Only users on each channel's allowlist can use it.
  - Connections are outbound only, so no ports need opening.
  - Webhooks for inbound triggers, e.g. CI failed → start a fix task.
- **Profiles:** completely separate homes (`work`, `personal`), each with its own database, credentials, memory, skills and channels. Switch in the UI, or with `--profile` on the CLI.
- **Remote access:** `verdandi web --host` on a tailnet address, and in M5 the desktop app to a remote agent (§11). Never exposed publicly.

---

## 16. Context management (native harness)

Claude Code manages its own context. The native harness has a pluggable `ContextEngine`, whose default is a compressor:

1. **Trigger:** compression starts at a set fraction of the context window (about 50% by default, later for windows under 512K), and again as a safety measure at about 85%.
2. **Save memory first** (a background review flush), so nothing worth keeping is lost.
3. **Prune without an LLM call:** oversized tool results are written to disk, with a pointer left in their place. If this frees enough room, compression stops here.
4. **Otherwise, summarize the middle.** Keep a head and a tail within a token budget, never splitting a tool call from its result. Summarize what's between them with the auxiliary compression target, using the handoff sections (§8.2). The summary is updated on each later compression.

**Compression is the only allowed cache break.**

**No keep-or-drop step.** Having a decision model choose, for each old tool call, whether to keep it word for word (the `fast-jev-compaction` approach) is out, and so is a plugin that does it for Claude Code. Hermes tested exactly this with Jev on real transcripts: lower recall at twice the tokens, no better than plain recency at a matched budget, and more cache breaks with each compaction (Appendix A). What would bring it back is a recall exam on Verdandi's own long transcripts, graded by an LLM judge as [Hermes's](https://github.com/NousResearch/hermes-agent/blob/009afb3/evals/compaction/results/SCORECARD-2026-08-15.md) is, in which keep-or-drop beats prune-plus-summary at the same token budget.

---

## 17. Security and privacy

ADR 0025 is the trust model. Everything runs as you, the OS user, and nothing inside the agent process contains a hostile model; only the OS can, and Verdandi has no sandbox before M6. So Verdandi's layers come in two strengths:

- **Boundaries**, where a bypass is a vulnerability: your OS account (the Verdandi home and project folders are trusted local state), the loopback socket and its token, the web server's page token and `Origin` check, the LAN gate, validation at the RPC boundary (project paths, attachments, skill paths), and the asks Verdandi itself enforces (trusted project commands, Verdandi tools that ask, skill and memory proposals), which nothing may skip.
- **Heuristics**, which lower risk and can be bypassed by design: the injection and secret scans, redaction, "marked as data" fences, what an approval or plan mode limits (they're consent, not containment), and spend caps (a budget, not a security control).

The ADR also lists what isn't a vulnerability, who the principals are once the gateway exists (the agent never is one), and the defaults below, with the code that holds each. `SECURITY.md` says how to report one.

- **Network:**
  - verdandid listens on `127.0.0.1` only, serves no web page, and requires the profile's token for each connection. It refuses every WebSocket from a browser page (ADR 0026).
  - `verdandi web` serves the UI and relays to verdandid. The page holds only the web server's token, made per run, never the agent's; a WebSocket from a page other than the web server's own is refused before its token is read.
  - `verdandi web --host` opts in to the local network or tailnet through a gate in front of the web server. The gate refuses every request from outside private, tailnet and loopback ranges, and every WebSocket from a page it didn't serve. A public `--host` address is refused.
  - On the local network the page's token travels over plain HTTP. Remote access beyond a network you trust is opt-in, through Tailscale.
- **No default outbound calls.** verdandid calls only your harness and the providers you configured, with no telemetry. Fonts are bundled and remote images aren't loaded. Anything more is named in config and off until turned on.
- **Claude Code credentials are never touched.** The harness drives your own logged-in CLI.
  - Anthropic's Agent SDK docs say third-party developers may not offer claude.ai login or rate limits in their products without approval.
  - For personal use, this is you using your own CLI.
  - **If Verdandi is ever distributed**, check this policy again. The native harness with API keys would be the supported path.
- **Provider API keys** (native harness) come from the OS keychain or Verdandi's own environment variable (`.env` included), and later a `keyCommand`, never from a config file. verdandid keeps them in memory and out of every process it starts, harnesses included. They're masked in trajectories and exports.
- **Permissions:**

  | Mode | Behaviour |
  |---|---|
  | **Ask** (default) | Ask before actions that aren't pre-approved |
  | **Auto-edits** | File edits happen without asking |
  | **Auto** | A classifier decides what's allowed |
  | **Full access** | Everything allowed. Must be chosen explicitly. |

  Each harness maps these modes to its own settings. Scheduled and gateway tasks have their own restricted profiles. An approval is consent to one step, not a limit on what that step can do.
- **Smart approvals (native harness):** the decision layer rates a command's risk (§9.8), so safe commands don't need an approval prompt. A command is auto-approved only when the model is very confident it's safe. Hard rules still catch destructive patterns, and nothing destructive or irreversible is ever auto-approved.
- **Consent first for self-improvement.** Skill changes, background review's proposals and the agent's memory saves each ask first; `approveSaves: false` in `memory.yaml` lets memory saves through unasked. Background model work runs on a digest, as a routed task with a cost cap, never on the full context.
- **Prompt-injection defence** (heuristics, ADR 0025):
  - memory saves and skill changes are scanned before they're recorded, with pattern rules plus a decision-layer check (§9.8), and a hit is refused. Context files, gateway messages, and skills Claude Code loads by itself are to be scanned too;
  - tool outputs are marked as untrusted data;
  - untrusted text that Verdandi hands the agent itself goes through the same scan: what an escalation passes on (a verifier's output, the agent's blocked reason, a repeated tool error), and Verdandi tools' results built from stored text, such as search hits. A hit isn't withheld, since the agent needs the text to go on. It's handed over under a warning, recorded, and shown on the turn;
  - gateway messages from senders not on the allowlist are ignored;
  - **turn taint:** content scanning can't catch every poisoned fact, so untrusted input is also tracked by where it came from. Once a turn calls a network tool (Claude Code's `WebFetch` and `WebSearch`, the native harness's `web_fetch` and `web_search`) or gets text flagged as an injection, the rest of the turn is tainted, and its session holds untrusted input from then on. The list is closed and kept in one place (`apps/agent/src/routing/untrusted.ts`); a shell command that fetches can't be told apart reliably, and the user's own MCP servers are trusted like the shell. A `memory_save` in a tainted turn becomes a proposal the user approves, whatever `approveSaves` says, and the session's taint floors its route (§8.7).
- **A project's own commands run only once you trust them.** Its verifiers (`escalation.verifiers` in `.verdandi/routing.yaml`) and worktree setup (`.verdandi/worktree.yaml`) are shell commands a cloned repo's author, or an agent allowed only to edit files, can write. The first time verdandid would run a list, it asks on the turn (a worktree's setup waits for the thread's next turn), showing the exact commands; allowing it records trust in that project for that exact list, by hash, and a changed list asks again, so a turn that rewrites them can't run its new commands unasked. Denying skips them: the turn says so, and the task records no verifier run. Unattended runs only run trusted lists: `verdandi run` stops at the request (exit code 5), and a batch never trusts a repository's own commands, using each task's `verify` instead. The projects page and `verdandi chat`'s `/trusted` and `/untrust` list and revoke them. Like other approvals, this is consent, not containment.
- **Plugins never run inside verdandid.** In process, a plugin could read the database, the profile token and every key verdandid holds, and a malicious one would be out of reach of any defence. So:
  - content-only bundles (skills, MCP server config, commands) come first; they carry no code verdandid loads;
  - a plugin with code runs in its own process, as an MCP server or a Bun subprocess speaking a typed contract (§18), started without verdandid's secrets in its environment. That keeps it out of verdandid's memory, but it is not a sandbox: it still runs as you;
  - installs are explicit and pinned, to an exact version with an integrity hash or to a full commit SHA;
  - you consent to the capabilities its manifest declares (tools, prompt sections, hooks, network hosts, commands it runs), and the consent is stored with a hash of that list. An update that declares more asks again, and nothing is granted when nobody is at the keyboard (scheduled, gateway and headless runs);
  - enabling, disabling and uninstalling are recorded as events, and the plugin list shows each plugin's granted capabilities.
- **Supply chain:**
  - every dependency pinned to an exact version;
  - a minimum release age for new package versions (Bun's install setting), so versions published only hours ago can't be installed;
  - OSV scanning;
  - lockfile-diff review in CI (`bun.lock` is a text file, so its diffs can be reviewed);
  - Python in `lab/` pinned through `uv.lock`.

---

## 18. Extensibility

- **Plugin kinds:**
  - harness,
  - model provider,
  - gateway platform,
  - memory provider,
  - tool,
  - execution backend,
  - skill source,
  - context engine.
- **Bundles first:** a content-only bundle holds skills, MCP server config and commands, and no code verdandid loads. Whether bundles take Claude Code's plugin layout, which verdandid already hands Claude Code for the profile's skills (ADR 0020), is open.
- **Code runs out of process** (§17). Nothing from a third party is imported into verdandid. Each kind crosses the boundary like this:

  | Kind | Runs as |
  |---|---|
  | Tool | An MCP server |
  | Harness | A Bun subprocess speaking the harness contract (§9.2) |
  | Model provider | A Bun subprocess that takes normalized requests and streams normalized blocks back (§9.5) |
  | Gateway platform | A Bun subprocess speaking `PlatformAdapter` (§15) |
  | Memory provider | A Bun subprocess answering the `MemoryProvider` hooks (§14.2) |
  | Execution backend | A Bun subprocess that runs commands where it points (§13) |
  | Skill source | A bundle, or a Bun subprocess that fetches files; either way installs go through the skill proposal flow (§14.4) |
  | Context engine | A Bun subprocess that takes the transcript and returns the compressed entry (§16), called only when compression triggers |

  Every contract is a schema in `packages/contracts`. No kind needs to run in process.
- **Packaging:** an npm package pinned with its integrity hash, or a git repository or local folder pinned to a commit, with a `verdandi-plugin.json` manifest that declares its capabilities (§17). Started only when explicitly installed and enabled.
- **The cache rule is part of the contract.** A plugin enabled mid-session gets its hooks at once; its tools and prompt sections arrive only with the thread's next harness session. Disabling one stops its hooks and refuses its tool calls at once, and its tools leave the list at the next session.
- **First-party plugins** live in `plugins/` in the repo, as proof that the interfaces work.
- **Footprint Ladder** (principle 10): a new capability starts as a skill or plugin, and only moves into the core when it has to.

---

## 19. Tech stack

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript, strict mode, modern ES modules only | The Agent SDK is TypeScript, types are shared between server and UI, and the leading coding agents are TypeScript. Learning at run time (memory, skills, routing memory) needs no Python; training does, and lives in `lab/`, talking to the app through files (§14.7) |
| Runtime | **Bun** | Ships as one installable binary (`bun build --compile`) with the web UI inside for `verdandi web`, the way Claude Code installs. SQLite, test runner, bundler, package manager, shell and OS-keychain access are built in, which means fewer dependencies and a smaller supply-chain surface. Fast CLI startup. Anthropic maintains Bun, and Claude Code itself ships on it. |
| Type checking | TypeScript 7 (native compiler) | Stable since 7.0; much faster type checks |
| Monorepo | Bun workspaces (isolated installs, version catalogs) + Turborepo | Isolated installs enforce package boundaries; Turborepo caches builds |
| Server core | **Effect 4** on `@effect/platform-bun` (Schema, RPC over WebSocket, SQL, Stream). Confirm in M0 whether 4 is stable enough, else use 3.x. | Cancellation, cleanup and streaming are Verdandi's hardest problems, and Effect is designed for them. Effect Schema converts old stored events to the current shape. |
| Router | Plain pure TypeScript | Easy to reason about; runs in the browser for the live preview |
| Model SDKs | `@anthropic-ai/sdk`, `openai`, `@google/genai` | Official SDKs, with full access to cost features |
| Agent SDK | `@anthropic-ai/claude-agent-sdk`, exact version pinned | Claude Code harness |
| Database | SQLite in WAL mode via `bun:sqlite` + Effect SQL | Built in and fast, with no native addon; FTS5 for search |
| Terminal | A PTY host process using Bun's built-in PTY (ConPTY on Windows; ADR 0007), plus xterm.js in the UI | A separate process keeps native terminal crashes away from the server. VS Code uses the same design. |
| Terminal UI | **OpenTUI** through `@opentui/react` (ADR 0027) | Built for Bun, React like the web UI, and redraws only what changed. Its renderer is native (Zig, through `bun:ffi`): the one exception to "no native addon", loaded only when the terminal UI opens |
| Git | The `git` command line, through a typed wrapper | Worktrees and low-level checkpoint commands |
| Credentials | OS keychain through `Bun.secrets`, plus `keyCommand` | No plain-text keys, and no native addon |
| Decision models | `rules` by default; Laya (ONNX through `onnxruntime-node`) in a worker process where it beats rules (ADR 0009); ollaya for larger local models; the Jev API if turned on | §9.8 |
| Web UI | React 19 + TanStack Virtual, bundled by Bun from an HTML import and served by verdandid. A router, a state library or the React Compiler are added when a view needs them. | Virtualized long threads, no separate bundler or dev server |
| UI kit | Tailwind 4 (through `bun-plugin-tailwind`), Base UI used directly for accessible widgets, Streamdown, Shiki, `@pierre/diffs`, Tiptap | Each is built for its job. Base UI is unstyled, so Tailwind styles everything and there is no component layer to copy in (ADR 0012) |
| Desktop | **Electron** + electron-builder, with auto-update. It runs the compiled verdandid binary as a separate process, or connects to a remote one, and renders `packages/ui` in its window (§11). | Same Chromium on every OS. VS Code, Cursor, T3 Code and Hermes all ship on it. The server runs independently of the window, which the scheduler and gateway need anyway. |
| Gateway | Official or leading SDK for each platform, as plugins | — |
| Local models | Ollama (and any OpenAI-compatible local server) | Free auxiliary and classifier work, and a local agent option |
| Tests | `bun test` (with Effect's test services, e.g. TestClock), Playwright, golden tests for the router, install and update end-to-end tests on all three OSes | Covers everything from the router's rules to the installer |
| Lint and format | Biome | One fast tool for both |
| Release | `bun build --compile` (one `verdandi` binary per platform, via an install script and npm), with `verdandi web`'s page bundled in through its HTML import, electron-builder (desktop), Changesets | — |
| CI | GitHub Actions on Windows, macOS and Ubuntu, plus supply-chain jobs | — |
| **lab/** | Python 3.13+, uv, ruff, ty, pytest; PyTorch, TRL and scikit-learn as needed; ONNX export | ML tooling lives here, outside the app |

---

## 20. Repository layout

```
verdandi/
├─ apps/
│  ├─ agent/                     # the agent: verdandid + `verdandi` CLI, one binary
│  │  └─ src/                    # one folder per feature: its logic, tests and CLI command
│  │     ├─ bin.ts · main.ts      # CLI entry · service wiring (Layer composition)
│  │     ├─ event-store/          # engine · decider · projector · reactor · sqlite + migrations
│  │     ├─ routing/ · memory/ · spend/ · tasks/ · search/ · batch/
│  │     ├─ worktrees/ · checkpoints/ · diffs/ · terminals/ · attachments/ · verifiers/
│  │     ├─ projects/ · home/ · git/
│  │     ├─ harnesses/            # registry, capability detection
│  │     ├─ scheduler/
│  │     ├─ gateway/              # gateway core; platforms come from plugins
│  │     ├─ surfaces/             # openai-compatible API, ACP server, MCP server
│  │     ├─ rpc/                  # WebSocket API (loopback only, no web page)
│  │     ├─ cli/                  # `verdandi chat` (its session, and the --plain line chat), `run`, `web`, `doctor`
│  │     └─ tui/                  # the terminal UI on OpenTUI: draws the chat session
│  ├─ web/                       # `verdandi web`: serves packages/ui's page, relays to the
│  │                             #   agent with its own page token, LAN gate for --host
│  └─ desktop/                   # Electron host for packages/ui: main, preload bridge,
│                                #   agent process or remote connection, tray, updater
├─ packages/
│  ├─ ui/                        # the whole UI (React), shared by web and desktop; src/ has
│  │                             #   one folder per feature: threads, composer, routing, spend,
│  │                             #   diffs, terminals, memory, worktrees, skills, …; ui/ is shared
│  ├─ contracts/                 # schemas: ids, commands, events, harness events,
│  │                             #   routing, catalog, rpc, trajectories
│  ├─ router/                    # PURE routing engine; src/catalog.json + src/policy.json
│  │                             #   are the model catalog and built-in policy (data)
│  ├─ harness-claude-code/       # Agent SDK adapter
│  ├─ harness-native/            # Verdandi agent loop, prompt assembly, context engine
│  ├─ models/                    # provider adapters, catalog, credentials, fallbacks
│  ├─ tools/                     # Verdandi tools (native + MCP exposure)
│  ├─ memory/                    # memory stores, snapshot, scanners, session index,
│  │                             #   MemoryProvider interface
│  ├─ skills/                    # skill store, skill_manage, curator, hub client
│  ├─ decisions/                 # decision layer: Decide service + backends
│  │                             #   (rules, laya, ollaya, jev, llm)
│  ├─ trajectories/              # trajectory builder, redaction, exporters, batch runner core
│  ├─ exec/                      # execution backends: local, docker, ssh
│  └─ testkit/                   # FAKE harness + fake provider, fixtures, helpers
├─ plugins/                      # first-party: platform-telegram, platform-discord,
│                                #   platform-slack, memory-*, exec-*
├─ evals/                        # eval task sets + harness configs
├─ lab/                          # Python (uv): datasets/, router/, finetune/, notebooks/
├─ scripts/
├─ docs/
│  ├─ DESIGN.md
│  ├─ decisions/                 # ADRs
│  └─ internals/
├─ AGENTS.md · CLAUDE.md (→ @AGENTS.md)
└─ package.json · bunfig.toml · bun.lock · turbo.json · biome.json · tsconfig.base.json
```

**Dependency rules:**
- `contracts` depends on nothing.
- `router` depends only on `contracts`, and never imports I/O code.
- Harness, model, decisions, memory, skills, tools and trajectories packages depend on `contracts` and `shared` helpers.
- `apps/agent` depends on everything.
- `ui` depends only on `contracts`. `web` and `desktop` depend on `ui` and never on `agent` or each other; `agent` imports `web` only in its `verdandi web` command, on demand (ADR 0026).
- `lab/` never imports TypeScript code. It reads exported files only.

Bun's isolated installs enforce these rules at the package level: an import fails if the package isn't declared as a dependency.

**Packages are created when their milestone starts,** not all up front.

---

## 21. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 · Spike** (1–2 weeks) | Agent SDK under Bun on Windows; effort and model switching; the `agents` option; hooks; the in-process MCP server; `bun:sqlite` with FTS5; Effect 4 RC on `@effect/platform-bun`; the PTY host; `laya-ts` under Bun | Every item in Appendix D answered and written up as ADRs |
| **M1 · Core loop** | verdandid + web UI on the Claude Code harness: threads, streaming, approvals, plan mode, diffs, resume, steer; event store; usage ledger; **trajectory recording**; fake harness for tests | You do a full day's work in Verdandi |
| **M2 · Router v1** | `rules` classifier, policy files, pins, switch-cost gate, decision records and explanations, plan→execute split, subagent routing, budget modes, routing memory, spend dashboard, batch runner (`verdandi batch`) to measure it (ADR 0017); **decision layer** on `rules`, with decisions logged so Laya can be measured against it on real data | At least 30% lower cost per completed task than always-Opus, with no drop in success rate |
| **M3 · Memory, skills, safe autonomy** | Worktrees, checkpoints and revert, terminal, verifiers and escalation; memory with fixed-size snapshots, scanners and panel; session search; skill lifecycle + curator; background review, skipped when the decision layer finds nothing worth saving; injection scanning; Verdandi tools over MCP to Claude Code | Skills are created and reused; escalation fixes more than half of first-attempt failures |
| **M4 · Native harness and providers** | Agent loop, prompt assembly, context engine, subagents; Anthropic API, OpenAI-compatible (OpenRouter, Ollama…) and Gemini providers; credentials, fallbacks, health; auxiliary tasks routed; routing across harnesses; quota-based pricing and moving work to other targets; Jev backend (off by default) | Chores run on local or cheap targets automatically; a thread can hand off between Claude Code and native |
| **M5 · Always-on** | Scheduler, gateway (Telegram, Discord, Slack), webhooks, profiles, desktop app, smart approvals, remote access | Nightly jobs run unattended within budget; tasks are approved from your phone |
| **M6 · Learn and reach** | `lab/` (datasets, router training), race mode, a router fine-tuned from Laya, fine-tuned decision models; execution backends (Docker, SSH, cloud); plugins + skills hub; external memory providers; more harnesses (Codex, OpenCode, ACP); OpenAI-compatible API, ACP and MCP servers; `execute_code`, `browser`, mixture-of-agents | The learned router beats `rules` on APGR (or is dropped); at least one plugin of each major kind works |

---

## 22. Risks

| Risk | Mitigation |
|---|---|
| **Scope:** the plan is Hermes-sized, and nothing ships | Strict milestone order. Each milestone is useful on its own. Footprint Ladder. |
| Subscription and third-party policy | Personal use of your own CLI. The native harness with API keys is the path for distribution. |
| Anthropic terms on training | Record provenance for every turn; the terms check in §14.8 |
| Harness and provider APIs change fast | Pinned versions, contract tests, capability detection, fallbacks |
| Cache effects cancel out the routing savings | Switch-cost gate. Prefer effort and subagents. Measure baseline (c) early. |
| Misrouting hurts trust | Conservative defaults, confidence threshold, one-click override, escalation, override rate as a KPI |
| The native harness is weaker than Claude Code at coding | Route coding to Claude Code by default. Native handles chores, chat, automation and non-Claude models. Measure before changing this. |
| Effect 4 RC isn't ready, or Bun lacks something we need (PTY, a native-addon package) | Settle in M0. Fall back to Effect 3. The PTY host runs on Bun's built-in PTY (ADR 0007); `bun-pty` behaved the same and is the fallback. Use WASM builds (e.g. `onnxruntime-web`) instead of native addons. |
| Decision models are new: Jev is weeks old, and Laya is weak out of the box | Local backends by default, each kind of question measured, LLM fallback below the confidence threshold, fine-tuning on our own data |
| A malicious plugin or dependency | Plugins: content-only bundles first, code only out of process and never imported into verdandid, installs pinned with an integrity hash or commit SHA, consent bound to a hash of the declared capabilities and asked again when they grow (§17, §18). Dependencies: exact pins, minimum release age, supply-chain CI, scanners. |
| Prompt injection through gateway messages, memory or skills | Allowlists, scanning, untrusted-data marking, approval gates |

---

## 23. Open questions (owner decisions)

1. **Distribution:** decided. Verdandi will be open-sourced later; when is still open. Until then it stays a personal tool, and before it's published Anthropic's terms for using a subscription in third-party tools are checked again (§17).
2. **Effect 4 RC vs. Effect 3 stable:** decided. Effect 4 RC, pinned, with one stream workaround (ADR 0008).
3. **Default permission posture:** Ask (recommended) or Auto-edits?
4. **Fable:** allow in Max mode only (recommended)?
5. **First gateway platform:** Telegram (recommended: simplest bot API, good inline buttons) or Discord?
6. **Local models:** which local coding and chat models to target first, and on what hardware?
7. **Moving to credits when quota runs low:** decided. Verdandi asks the first time, then remembers. Claude Code's own silent move to extra usage is never hidden: those turns are priced as metered and shown (ADR 0005).
8. **Terminal UI:** decided. The terminal chat (bare `verdandi`) is the default surface, a terminal UI on OpenTUI (ADR 0027).
9. **Jev:** keep it off until TypeSafe publishes data-retention terms (recommended), or turn it on now for selected projects?
10. **Gateway turns and `workspace.yaml`'s folders:** should a turn started by a gateway sender other than the owner get the folders the agent may work in (§13), or ask for any path outside the workspace (recommended)?

---

## Appendix A — Prior art

| Area | Project | What we take from it |
|---|---|---|
| Agent GUIs | T3 Code | Event-sourced orchestration; harness adapters with capability flags; per-turn git checkpoints; approval UX |
| Personal agents | [Hermes Agent](https://github.com/NousResearch/hermes-agent) (checked at `009afb3`) | Its full feature set; see Appendix B |
| | [OpenClaw](https://github.com/openclaw/openclaw) (checked at `d0f7dcc`) | Driving the user's installed Claude Code without reading its credentials, with skills passed in as a plugin (as ADR 0020 does); external harnesses over ACP; code-free bundle plugins first, and plugin consent bound to declared capabilities (§17, §18); replies always go back to the channel they came from (§15); a maturity scorecard |
| Routers | [RouteLLM](https://github.com/lm-sys/RouteLLM) | Threshold-calibrated strong/weak routing; APGR evaluation |
| | [Arch-Router](https://huggingface.co/katanemo/Arch-Router-1.5B) | Routing policies written in plain language; fast local router |
| | [claude-code-router](https://github.com/musistudio/claude-code-router) | Routing on request shape (background, thinking, long context) with no classifier |
| | [Cursor Router](https://cursor.com/blog/how-cursor-router-works), [Copilot Auto](https://docs.github.com/en/copilot/concepts/models/auto-model-selection) | Complexity scoring; switching only at cache boundaries; learning from implicit satisfaction |
| | [FrugalGPT](https://arxiv.org/abs/2305.05176) | Cascade with escalation when a scorer judges the answer too weak |
| | [Advisor strategy](https://claude.com/blog/the-advisor-strategy), `opusplan` | Planning with a big model and executing with a small one |
| Decision models | [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) (TypeSafe AI), [Laya](https://github.com/NandhaKishorM/laya), [ollaya](https://github.com/ollaya-dev/ollaya) | Typed judgments with calibrated probabilities instead of LLM calls; one request format for cloud and local backends |
| | [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) | Not taken: compaction by keeping or dropping tool calls. [Hermes's scorecard](https://github.com/NousResearch/hermes-agent/blob/009afb3/evals/compaction/results/SCORECARD-2026-09-19-jev.md) measured it with Jev at 75.5% recall on 115K tokens against its own 78.9% on 55K, no better than plain recency at a matched budget, with more cache breaks, though far faster and cheaper per compaction (§16) |
| Evaluation | [RouterBench](https://arxiv.org/abs/2403.12031) | Cost–quality curves; offline router scoring |

## Appendix B — Hermes capability map

Everything that makes Hermes Agent good, and where it lives in Verdandi. Hermes's side was checked at hermes-agent `009afb3`.

| Hermes capability | Verdandi equivalent | § | Milestone |
|---|---|---|---|
| Own agent loop: parallel tools, interrupts, `/steer`, iteration budgets | Native harness | 9.4 | M4 |
| About 30 provider families over five wire modes | Model provider layer: Anthropic, OpenAI-compatible, Gemini, and more as plugins | 9.5 | M4 → M6 |
| Fallback providers, credential pools, key commands | Resilience + credentials | 9.5 | M4 |
| Auxiliary models per task | Routed `aux.*` tasks | 9.7 | M4 |
| Claude through API credits, or a subscription: it adopts Claude Code's credentials by default (`auth.adopt_external_logins`), and an experimental plugin drives the Claude Code CLI | Both, without ever touching Claude Code's credentials: the Claude Code harness drives your logged-in CLI, and the native harness uses API credits | 9.1, 17 | M1 / M4 |
| Fixed-size memory files, frozen snapshot, consolidation, nudges | Memory | 14.2 | M3 |
| Scanning memory for injection and exfiltration | Scanners | 14.2, 17 | M3 |
| External memory providers (Honcho, mem0, …) | `MemoryProvider` plugins | 14.2 | M6 |
| Session store with FTS5 search (+ CJK) | Session index with a trigram index | 14.3 | M3 |
| Skills: SKILL.md, progressive disclosure, `skill_manage`, nudges, `/learn` | Skills, without the skill nudge: a proposal is triggered by how a task went, never by a count | 14.4 | M3 |
| Skill curator (active → stale → archived) | Curate step | 14.4 | M3 |
| Skills Hub | Skills hub | 14.4 | M6 |
| Background review on a forked, cache-sharing agent | Background review | 14.5 | M3 |
| Delegation: fresh-context children, "frontier planner, cheap workers" | `delegate_task`, with **each child routed** | 9.4 | M4 |
| `execute_code` (programmatic tool calling) | `execute_code` | 9.6 | M6 |
| Terminal backends: local, Docker, SSH, Modal, Daytona, … | Execution backends | 13 | M4 → M6 |
| Messaging gateway (about 30 adapters) + webhooks + API server | Gateway + webhooks + OpenAI-compatible API | 11, 15 | M5 → M6 |
| Cron: plain-language schedules, per-job skills and model, pre-run scripts, chaining, delivery, watchdog | Scheduler | 15 | M5 |
| Context compression: pruning, structured summary, save memory first | Context engine | 16 | M4 |
| Tool search for many MCP tools | Tool search | 9.4 | M4 |
| Rule that the prompt stays cached | Principle 3; native harness rules | 5, 9.4 | M1 |
| Context files (AGENTS.md, CLAUDE.md, …) + persona (SOUL.md) | Prompt assembly + `persona.md` | 9.4 | M4 |
| Smart approvals through an auxiliary model | Smart approvals | 17 | M5 |
| Profiles (isolated homes) | Profiles | 15 | M5 |
| Plugins + the Footprint Ladder | Extensibility | 18 | M6 |
| ACP adapter, MCP server | ACP and MCP surfaces | 11 | M6 |
| Mixture-of-agents | MoA route type | 9.4 | M6 |
| Batch runner, trajectory compression | Batch runner, trajectory exporters, `lab/` | 14.6, 14.7 | M1 (recording), M2 (batch runner) → M6 |
| Exact pins, supply-chain CI | Supply chain | 17 | M0 |
| Terminal UI | `verdandi`, the terminal UI on OpenTUI and default surface | 11, 12 | M1 |
| Opt-in checkpoints with `/rollback`, `hermes -w` worktrees | Checkpoints every turn, revert, worktrees per thread | 13 | M3 |
| Desktop app (chat, preview rail, terminal, file browser) and web dashboard | Web UI, desktop app | 12, 19 | M1 / M5 |
| **Not in Hermes** | Task routing across harnesses and access modes, decision layer, race mode, learned routing | 8, 9.8 | M1 → M6 |

## Appendix C — Glossary

- **Harness:** whatever runs the agent loop. Claude Code, the native harness, and so on.
- **Provider:** where inference runs (Anthropic API, OpenRouter, Ollama, …).
- **Access mode:** `subscription`, `metered` or `local`.
- **Target:** a harness, provider, model and access mode together.
- **Route:** a target plus effort, interaction mode and subagent profiles.
- **Task:** a run of turns under one route. The unit of routing.
- **Pin:** a route you set explicitly. It always wins.
- **Verifier:** a command whose exit code tells whether the work is correct.
- **Switch cost:** the cost of re-reading the cached context, plus a handoff, when the target changes.
- **Trajectory:** a recorded task (messages, tools, route, outcome), exportable for training.
- **Decision model:** a model that answers typed questions (choice, score, noul) with calibrated probabilities instead of writing text. Jev and Laya are examples.
- **Noul:** a yes/no question, answered as a probability.
- **APGR:** Average Performance Gap Recovered. How much of the quality gap between the weak and strong model the router recovers, averaged across cost levels.

## Appendix D — To verify in the M0 spike

- [x] How to set **effort** through the SDK (option, settings or env var). Can it change within a session, and what does that do to the cache? This decides whether per-turn auto effort (§8.7) ships for Claude Code. → ADR 0002: yes, but it re-writes the conversation to the cache, so no per-turn auto effort for Claude Code.
- [x] What `setModel()` does inside a session: does it keep the transcript, and what does the first turn after a switch cost? → ADR 0002: keeps it; a cold write of the new model's full prefix.
- [x] The `agents` option with a `model` per agent, and how subagent usage shows up in `modelUsage`. → ADR 0005.
- [x] `maxTurns`, and whether a dollar-budget option exists. → ADR 0005: `maxBudgetUsd`.
- [x] Rate-limit and quota signals for subscription users, which feed quota-based pricing. → ADR 0005.
- [x] How `canUseTool`, `AskUserQuestion` and `ExitPlanMode` behave in the approval flow. → ADR 0003.
- [x] Resuming at a given message and `forkSession`, as the basis for revert. → ADR 0004.
- [x] Hooks registered through the SDK alongside the user's own hooks. → ADR 0005.
- [x] Serving an MCP server in-process through the SDK, for Verdandi tools. → ADR 0005.
- [x] Sending a message to a running Claude Code session (steer). → ADR 0003: lands at the next tool boundary; `priority: "now"` aborts and restarts.
- [x] `bun:sqlite`: FTS5 and trigram tokenizer support on all three OSes. → ADR 0006: yes on all three, checked in CI.
- [x] Effect 4 RC on `@effect/platform-bun`: stability of RPC over WebSocket, SQL and Stream. → ADR 0008: works; stopping a stream early wedges the connection in rc.115, avoided by design until fixed.
- [x] The PTY host on Windows 11 (ConPTY): resizing, heavy output, Ctrl+C, killing process trees. → ADR 0007: Bun's built-in PTY, with fixes for Ctrl+C, tree kill and output batching.
- [x] `laya-ts` under Bun: `onnxruntime-node`, or `onnxruntime-web` (WASM) as a fallback; CPU latency of a routing request. → ADR 0009: `onnxruntime-node` works; p50 1.45 s, 1.7 GB. ADR 0019: no `laya-ts` package exists; `@receptron/laya` runs under Bun 1.4.2 at ~0.4 s per request on Apple silicon, not yet a dependency.
- [x] Laya's accuracy out of the box on our task taxonomy, compared with `rules`. → ADR 0009: 63% vs 81% (n = 52); `rules` is the default.
