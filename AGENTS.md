# Verdandi

Verdandi is a local-first workspace and personal agent platform for coding agents. It drives *harnesses* (Claude Code first, then its own native agent loop, then others) and routes every task to the harness, provider, model and effort level that finishes it at the lowest effective cost. It also remembers, learns skills, runs on schedules and can be reached from chat apps.

The design lives in `docs/DESIGN.md`. Read the section that covers what you're changing before you change it.

**Status:** M1 (core loop) in progress, with much of M2 (routing) and M3 (worktrees, checkpoints, verifiers and escalation, memory, session search) built alongside it. "How it works" below lists what exists; what it doesn't name, such as skills, the native harness and the gateway, doesn't exist yet. Packages are created when their milestone starts (DESIGN.md §20–21), not before.

## What we never compromise on

1. **Size every task correctly.** We optimize cost per *completed* task, not per request. That applies to you too: don't read files you don't need, don't dump huge outputs into context, and pick the smallest check that proves your change.
2. **Don't break the cache.** Within an agent session, the system prompt and tool list never change. Anything that changes between turns goes into the next user turn. Compression is the only allowed cache break.
3. **Local-first and private.** Nothing leaves the machine except calls to providers the user configured.
4. **The user always wins.** Overrides take one click, are recorded, and are never argued with.
5. **Performance.** No continuously repainting animations, small WebSocket payloads, virtualized long lists. Our users drive agents all day, and they notice a dropped frame or a spinner that lies about progress.

## How we build

Fight scope creep. Look for the smallest model of the problem that makes the correct behaviour unsurprising. Measure twice, cut once, and don't build what isn't needed yet.

**Before writing code** (the ponytail ladder), stop at the first rung that holds:

1. Does this need to exist at all?
2. Does it already exist in this codebase?
3. Do the standard library or Bun do it?
4. Does a native platform feature cover it?
5. Does an installed dependency solve it?
6. Can it be one line?
7. Only then: the minimum code that works.

Read the task and trace the real flow *before* climbing the ladder. Fix bugs at the root cause: grep every caller and fix the shared function once. Never simplify away:
- validation at trust boundaries,
- error handling that prevents data loss,
- security,
- accessibility,
- anything explicitly requested.

Non-trivial logic leaves one runnable check behind. Mark deliberate corner-cutting with a `ponytail: <ceiling>, <upgrade path>` comment. The full rules are in the `ponytail` skill, and `ponytail-review` reviews a diff for over-engineering.

**Adding a capability** (the Footprint Ladder): try each step in order before moving to the next:
1. extend existing code;
2. a CLI command plus a skill;
3. a tool that is only enabled under certain conditions;
4. a plugin;
5. an MCP server;
6. a new core feature, as the last resort.

These are good defaults, not laws. The developer's preferences override anything here. If a rule fights the task in front of you, say so plainly and get a human sign-off before breaking it.

## Glossary

- **you:** the agent reading this file and changing Verdandi.
- **we / maintainers:** the people building Verdandi, i.e. the people you're talking to.
- **user:** a person using Verdandi to direct agents.
- **agent:** an AI agent running inside Verdandi. Depending on context, this can include you.
- **harness:** whatever runs the agent loop (Claude Code, the native harness, Codex, …).
- **provider:** where inference runs (Anthropic API, OpenRouter, Ollama, …).
- **access mode:** `subscription`, `metered` or `local`.
- **target:** a harness, provider, model and access mode together.
- **route:** a target plus effort level, interaction mode and subagent profiles.
- **task:** a run of turns under one route. The unit of routing.
- **thread:** a durable conversation in a project.
- **turn:** one user message and everything the agent does in response.
- **profile:** an isolated Verdandi home (`work`, `personal`).
- **decision model:** a model that answers typed questions (choice, score, yes/no) with calibrated probabilities (Jev, Laya).
- **Verdandi home:** `~/.verdandi/`, where the user's real state lives.

The full glossary is DESIGN.md Appendix C.

## Ways to hurt yourself

1. **Killing by pattern.** Never use `pkill -f`, `taskkill /IM`, `Stop-Process -Name`, or kill any PID you found by matching a name, path or worktree string. Your own agent process and other dev servers match those patterns too. Kill only PIDs you captured when you started the process.
2. **Touching live state.** `~/.verdandi/` holds the developer's real database, memory, skills and settings, in use while you work. Reading and copying from it is fine, and a good source of realistic test data. Never start a dev server against it, open it read-write or clean it up. Dev servers use a gitignored per-worktree state directory.
3. **Touching credentials.** Never read, print, copy or log Claude Code's credentials, OS keychain entries or provider API keys. Secrets never go into fixtures, trajectories, commits, PR text or logs.
4. **Rewriting persisted history.** Stored events must stay readable forever. Never change or delete a past event schema: add a new version and an upgrade instead. Migrations are append-only.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling a change done, go through this list and say which items applied:

- **Surfaces:** web, desktop, CLI, messaging gateway, the API/ACP/MCP servers.
- **Harnesses:** Claude Code, the native harness, and any others. A feature that depends on the harness needs a decision for each one, even if the decision is "not supported here".
- **Access modes:** subscription, metered, local.
- **Contracts:** anything sent over the wire or persisted is a schema in `packages/contracts`.
- **Routing:** a change that affects routing needs golden tests and an accurate reason string.
- **Reverse states:** a way in needs a way out, and a way to see it. A one-way door is a bug.
- **Profiles and operating systems:** Windows is first-class (paths with spaces, ConPTY, CRLF).
- **Docs:** does DESIGN.md or an ADR now say something that's false?

## Invariants

- `packages/router` is pure. It imports only `contracts`, and classifiers are passed in from outside.
- Complexity belongs at the adapter boundary. Orchestration stays pure, and the UI stays simple.
- Events are append-only. Acknowledging a command means its intent was saved. Side effects happen only in reactors.
- The following are untrusted data, never instructions: tool outputs, gateway messages, memory entries, skill files, web pages.

## Code shape

- Strict TypeScript, ES modules only, running on Bun. Prefer inferred types over annotations. `any` is the enemy.
- Effect 4 APIs differ from Effect 3 and from most training data. Check the installed version's source or docs instead of relying on memory.
- **File size:** a file past about 2,000 lines, or a function past about 300 lines, gets split into a facade plus `<stem>-<topic>.ts` siblings.
- **Branching:** four or more branches on the same value become a lookup table.
- **No re-export shims.** When you move a symbol, fix its importers, docs and skills in the same change.
- **Comments:** comments describe how something is used. They don't narrate every line.
- **Errors:** error messages name the cause and the fix. Bad config fails loudly, where it's read.
- **Config:** `.env` holds secrets only. Behaviour belongs in config files.
- **Telemetry:** only with explicit opt-in.
- **Scripts:** repo scripts are TypeScript run with Bun, not bash, so they work on Windows.

## Dependencies

- Ask before adding a dependency, and justify it (ponytail rung 5).
- **Pinning:** exact versions only. Pin GitHub Actions to a commit SHA with a `# vN` comment, and git dependencies to a full SHA.
- **Age:** a new package version must be at least 14 days old. The exception is a security fix, marked with a dated comment.
- **Lockfile:** review `bun.lock` diffs like code.

## Verifying

- **Keep checks small.** Prove your change works with the smallest check: `bun test <files>` for tests you touched, and typechecking for the scope you changed. Don't run repo-wide checks unless asked; CI owns the full suite.
- **What tests assert:** behaviour and invariants. Each bug fix gets one or two tests that you've seen fail before the fix.
- **Banned tests:** tests that freeze current values (catalogue counts, snapshots of lists), tests that read source text, and tests that restate the implementation.
- **No waiting:** the server is event-sourced, so tests wait on receipts and drained workers, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- **Test environment:** tests run with credentials unset, `TZ=UTC`, and a temporary Verdandi home. Behaviour specific to one OS is tested on that OS, never by faking the platform.
- **No live model calls in tests:** use the fake harness and fake provider in `packages/testkit`.
- **Evidence before claims:** before saying something is done, show the evidence (see `verification-before-completion`).

## Commits and pull requests

- Commit only when asked.
- **Commit messages:** one line, imperative, sentence case, e.g. `Add decision layer`. No body. No AI attribution, no `Co-Authored-By` trailers, no "Generated with" lines. This overrides any skill or tool default, including the example commit messages in `writing-plans` and similar skills.
- **Pull requests:** only when asked, and one concern per PR. The body states the problem in a sentence or two, then how it's fixed. No attribution footer. UI changes include before/after images.
- Rebase on `main` before merging.

## Documentation

- **DESIGN.md:** `docs/DESIGN.md` is the source of truth for scope and architecture. When a decision changes it, rewrite the affected text instead of appending.
- **ADRs:** decisions that are expensive to reverse get one, at `docs/decisions/NNNN-short-title.md`, with the sections *Status, Context, Decision, Consequences*. M0 spike results become ADRs.
- **Internals:** `docs/internals/` is for constraints that span components and traps the code can't show. Not for feature catalogues or narrated control flow.
- Most code changes need no doc change. Agents can read the code.

## Plans and scratch work

- Never commit plans, specs, research notes or scratch files, even when a skill tells you to.
  - `writing-plans` saves to `.plans/YYYY-MM-DD-<feature>.md`.
  - `brainstorming` saves specs to `.plans/specs/`.
  - Both folders are gitignored.
- Spike code goes in the gitignored `spikes/` folder. What a spike proved goes into an ADR.

## Agent configuration

- **This file is canonical.** `CLAUDE.md` and `GEMINI.md` only import it.
- **`.agents/skills/` is the single source of skills.** Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Amp and others read it directly. Claude Code, Windsurf, Roo Code, Kiro, Goose and a few others read it through symlinks. `bun scripts/agents-link.ts` creates or repairs those links, and `--check` verifies them.
- **Check the skills list before starting non-trivial work** (debugging, planning, a feature, a review, a spike). If a skill fits, use it. Trivial requests don't need a skill check.
- **Edit skills only in `.agents/skills/`,** never through a link. A skill's folder name must equal its `name`, and its description says what it does and when to use it (see `writing-skills`).
- **Vendored skills stay byte-identical to upstream** (sources in `.agents/README.md`). Put Verdandi-specific overrides in this file instead. A reference like `superpowers:<name>` means the `<name>` skill in `.agents/skills/`.
- **Area files:** when a directory develops its own conventions, give it an `AGENTS.md` (aim for under about 8k characters) and add it to this table:

| Working in | Read |
|---|---|
| `apps/server/src/event-store/` | [`apps/server/src/event-store/AGENTS.md`](apps/server/src/event-store/AGENTS.md) |

## How it works

What runs today (M1, in progress):

- **Commands and events:** clients send typed RPC (`packages/contracts/src/rpc.ts`) over a WebSocket on `127.0.0.1`, authenticated with the token in the profile's `server.json`. `verdandi start --host <ip>` (e.g. `bun run dev --host 0.0.0.0 --port 4780`) also opens it to the local network: a gate (`src/rpc/lan-gate.ts`) listens there, refuses any request not from a private or loopback address, and relays the rest, WebSockets included, to verdandid, which stays on `127.0.0.1`; a public `--host` address is refused. `CommandDispatch` hands a command to the engine, a pure *decider* turns it into *events*, and *projectors* update the read models in the same SQLite transaction. The receipt returns once that transaction commits.
- **Side effects:** after a commit, *reactors* run the side effects. Today they run a harness turn on `turn.started` and report what the harness does back as `harness.report` commands, pass the turn the user's `turn.steered` messages, pass `approval.resolved` answers back to the harness, stop a turn the user interrupted, run a turn's verifiers before it completes, and record each completed turn's trajectory and its task's outcome.
- **Approvals:** a harness that needs the user raises `approval.requested` or `user-input.requested`. It shows in `ThreadView.pendingRequests` until a client answers with `approval.respond`. A turn that ends first, including one cut off by a restart, denies its open requests and records why.
- **Steering:** `turn.steer` on the running turn records a `user.steer` item and reaches the agent at its next step (Claude Code: the next tool boundary, ADR 0003). The turn stays open until the agent has answered it.
- **Modes:** `turn.send` carries an interaction mode, `ask`, `plan` or `build`. It is recorded on the turn, and the harness applies it before the turn's prompt, so the cache survives (Claude Code: `setPermissionMode`; ask and plan both run in its read-only plan mode, build in the user's own default mode). A plan the agent proposes is a `plan.requested`: a `plan` item plus a pending request. Allowing it lets the turn go on building; denying it with `feedback` keeps the agent planning with that feedback (ADR 0003). Allowing it with `plan`, the user's edit (the web card's Edit, `e` in `verdandi chat` through `$VISUAL`/`$EDITOR`), makes the agent build from the edit (Claude Code: `ExitPlanMode`'s `updatedInput.plan`, ADR 0003; fake: echoes it); an empty edit is refused and an unchanged one is a plain approval. The `plan` item keeps both (`edited`), shown as a diff, and an edit counts as a correction, like a rejected plan.
- **Attachments:** `turn.send` can carry images and files. verdandid checks them at the RPC boundary (at most 10 per turn, 5 MB each and 10 MB together, and an image's bytes must match its type: PNG, JPEG, GIF or WebP; anything else, SVG included, is a file) and stores them content-addressed in the profile's `attachments` folder, before the engine accepts the turn. From then on the command, `turn.started` v2 and the feeds carry references (`AttachmentRef`), never bytes. Their contents are untrusted data. The reactor hands the harness each one's path (Claude Code: images as image blocks in the turn's message, files as paths in its text, marked as data, with the folder in `additionalDirectories`; fake: echoes them). An attached image is a routing signal: only catalog targets with `vision` stay candidates. The web composer takes paste, drop and an Attach picker, and a turn shows its thumbnails, fetched from `GET /attachments/<id>` with the token in an `Authorization` header. `verdandi chat` has `/attach <path>` and `/detach`. When verdandid starts and once a day, a background sweep (`AttachmentSweepLive`) deletes the files in `attachments` that no stored turn references and that are over an hour old, such as a rejected turn's; sending the same bytes again makes a file new, so the sweep never races a turn's commit, and a file it can't delete is logged and tried next time. `verdandi doctor` shows the folder's size and how many files no turn references.
- **Verifiers:** a project's `escalation.verifiers` in `.verdandi/routing.yaml` (e.g. `[bun test, bun run typecheck]`) run when a turn's agent finishes successfully after its file tools changed files in the project, whatever the harness. The reactor runs them in order in the project folder through the platform shell (`/bin/sh -c`, or `cmd /d /s /c`), with no input and a 10-minute limit each, until one fails, before it reports the turn finished, so the thread stays busy and an interrupt kills them and what they started. Each run is a `verifier.ran` event (command, pass, exit code, time, the tail of its output, which is untrusted data), shown as a `verifier` item of the turn in the web UI and `verdandi chat`. A task whose last verifier run failed has outcome status `failed`, and its `verifierRuns` list them.
- **Escalation:** when a verifier fails on a routed task, the reactor asks with `task.escalate`, and the decider takes the next step of the policy's `escalation.ladder` (default `effort`, `model`, `ask`; `packages/router`'s `escalate`), at most `maxAutoEscalations` (default 1) per task. A step commits `task.escalated` (the route before and after, and a reason) and a `turn.started` Verdandi sends, which hands the agent the verifier's output, fenced and marked as data. The task goes on at the new route on the same harness and session (ADR 0018). Past the limit, or with a spend cap reached when the next step would spend metered dollars, the step is `ask`, which moves nothing. Pinned threads and tasks pinned with `@name` never escalate, and nothing escalates once another turn has started. The failed turn shows an `escalation` item, the web UI labels the follow-up turn as Verdandi's, and `verdandi chat` prints a line. The outcome counts `escalations`, and routing memory counts an escalated task against the route it started on.
- **Interrupting:** `turn.interrupt` ends the running turn as `interrupted` at once, denying its open requests. The reactor then interrupts the turn's fiber, and the thread's next turn waits for the harness to wind down and continues the same session (Claude Code: resumed by id in a fresh process).
- **Feeds:** `ThreadSubscribe` streams a snapshot of the thread, then its events and unstored text deltas. `ProjectsSubscribe` streams every project, a small summary of each thread (title from its first turn, busy, last activity, route, and its cost with metered and subscription dollars kept apart), and each harness's latest subscription window, then a thread's summary again whenever it is created, archived or unarchived, or a turn starts or ends, and a window again whenever the harness reports it changed; the web sidebar and `verdandi chat --list` show both. Clients end a feed with `Unsubscribe` (ADR 0008).
- **Archiving:** `thread.archive` records `thread.archived`, which hides a thread without deleting anything; `thread.unarchive` brings it back. A thread with a running turn can't be archived, and an archived thread's `turn.send` is rejected (`ThreadArchived`) naming Unarchive. `ProjectsSubscribe` leaves archived threads out of its snapshot unless asked (`archived: true`), and a thread's summary says whether it's archived. The web sidebar's Show archived threads toggle and each thread's Archive/Unarchive, and `verdandi chat --list --archived`, `--archive <thread>` and `--unarchive <thread>`, do this. Task outcomes and costs still count archived threads.
- **Worktrees:** `thread.create` with `worktree: true` (the web's Open folder toggle and a project's Worktree button, `verdandi chat --worktree`) records `thread.worktree.requested`; the reactor runs `git worktree add` on a new branch `verdandi/<thread>` from `HEAD` under the profile's `worktrees/<repo>/<branch>`, reports it back (`worktree.report`), then runs the project's setup command from `.verdandi/worktree.yaml` (`setup: bun install`) there and records its result. Worktree work is queued on the thread like turns, so a turn sent meanwhile waits for it. The thread's harness, checkpoints, verifiers and diffs run in the project's folder inside the worktree (`threadFolder`); the project stays the original folder. A thread's folder never changes after its first turn, since its harness session lives there. `thread.worktree.remove` (Remove worktree, `--remove-worktree [--force]`) and archiving remove it with `git worktree remove`, which keeps the branch and refuses while it has uncommitted changes unless forced; `thread.worktree.add` (Recreate worktree, `--thread <id> --worktree`) adds it again on its kept branch. A turn in a thread whose worktree is gone is rejected (`WorktreeUnavailable`) naming the way back. `ThreadView.worktree` shows its state, branch and setup result.
- **Session search:** the projector adds each user message, steer and main-agent reply to `session_index`, an FTS5 trigram table (ADR 0006; migration 18 fills it from the event log). `SessionSearch { query, projectId? }` (`src/search/search.ts`) quotes the query as one phrase, returns nothing under 3 characters, and gives at most 50 hits newest first, each with its thread, turn, project, whether it's archived, and a little text either side of the match as marked parts. The web sidebar's search box jumps to the turn (`#thread=<id>&turn=<id>`); `verdandi search <query> [--project <path>]` prints them.
- **Memory:** user and project facts in `memories`, written only through events (`memory.saved`, `memory.edited`, `memory.deleted`), each with the thread (and turn) it came from and when it was last confirmed; saving a fact the store has confirms it. The decider scans every save and edit (`src/memory/memory.ts`: secrets, instructions aimed at an agent, ways to send data out) and refuses one past the store's cap (`memoryCaps`: user 1,500, project 2,000 characters), asking to consolidate with `replaces`. A turn that starts a new harness session records `memory.snapshot.taken`, each store's entries most relevant to the turn's text (trigram overlap) then newest, within its cap, and the harness puts that snapshot at the head of the turn's message, so it stays fixed for the session (ADR 0016). Every `nudgeEvery`th turn of a thread (the home's `memory.yaml`, default 10, 0 for never) gives the harness a `nudge` to consider `memory_save`, which it puts after the turn's message. Tools: `memory_save` (asks first when `memory.yaml` sets `approveSaves: true`) and `memory_search`. The web's Memory tab views, adds, edits and deletes entries (`MemoryList`). Verdandi never edits CLAUDE.md or AGENTS.md.
- **Checkpoints:** the reactor saves the thread folder's tree when each turn starts and ends (after the harness stops) to `refs/verdandi/checkpoints/<thread>/<turn>/start|end`, through a temporary index, so the user's branch, index and stash are never touched; untracked files are in, ignored ones out. A folder outside git has none, and a failed checkpoint is logged, never the turn's (ADR 0015).
- **Reverting:** `thread.revert { toTurnId, files }` (Revert to here on a turn in the web UI, `/revert [n] [files]` in `verdandi chat`) records `thread.reverted`: the later turns are marked reverted (kept in the log, folded away in the web UI), the running task ends and its outcome becomes `reverted`, and the thread's next turn passes the harness a `fork` (Claude Code: `resumeSessionAt` at the transcript `parentUuid` of the dropped turn's prompt, `forkSession`, `resumeDropsTurn`; a refused or impossible fork resumes plainly with a `notice` item saying why, ADR 0004). With `files`, the reactor checkpoints the files to `refs/verdandi/reverts/<thread>/<seq>` and restores the project folder from the turn's end checkpoint through a temporary index (`thread.files.restored`). `thread.revert.undo` (Undo, `/undo-revert`) undoes the latest revert, files included, until the next turn starts. Refused while a turn runs, and for turns from before the current harness session.
- **Diffs:** `DiffGet` with a `turnId` returns what that turn changed, its end checkpoint against its start, so the user's edits between turns never show; without one, the working tree against the thread's first checkpoint (`HEAD` for threads from before checkpoints). `verdandi chat` shows it with `/diff` (last turn) and `/diff all`, and the web UI in its right panel, fetched only when opened or refreshed.
- **Terminals:** `TerminalOpen` starts the user's shell (`$SHELL -l`, PowerShell on Windows) in a PTY, in the thread's folder (its worktree's, once it has one), on the PTY host: a child process (`src/terminals/pty-host.ts`) verdandid starts with the first terminal and talks to over Bun IPC, on Bun's built-in PTY (ADR 0007). `TerminalWrite`, `TerminalResize`, `TerminalList` and `TerminalClose` work on the thread's terminals; `TerminalSubscribe` replays the last ~256 KiB of output, then streams it coalesced per ~16 ms frame, so a terminal survives a page reload. Terminals are process state, never events. Closing one hangs up the shell and kills its tree by the PID captured at spawn, and answers once it's gone; stopping verdandid closes them all. If the host dies, its terminals end `lost` and the next terminal starts a new host. The web UI's right panel has a Terminal tab (xterm.js): keys, Tab and Escape included, go to the shell, and F6 moves focus out.
- **Web UI:** verdandid serves `apps/web` at `/`: Bun bundles it from its HTML import, compiling its Tailwind stylesheet through the plugin set in `bunfig.toml`. Run from source (`bun run dev`) it rebuilds on every change to `apps/web` and reloads open pages; with `NODE_ENV=production` it builds one minified bundle on the first request and serves it until restarted. Styling is Tailwind utilities on the elements, with the colour tokens in `styles.css`; widgets that need keyboard and ARIA behaviour come from Base UI (ADR 0012). `verdandi open` opens it with the token in the URL fragment, so the token never reaches server logs or a `Referer`; the page keeps it in session storage. The page talks to verdandid over the same RPC as the CLI, and imports only `@verdandi/contracts`. Beside a narrow rail (Projects, Threads, Search, Spend), its sidebar lists threads by recency, Today, Yesterday and on (`groupByRecency` in `src/state.ts`), and folds away (kept in local storage). The projects page (`#view=projects`, or no thread open) opens any folder by path and starts a thread in a known project. The look is Norse, after the references the developer chose: warm stone and bone neutrals (keep surfaces neutral, never tinted grey), Crimson Pro for headings and figures, Elder Futhark runes as icons (`src/runes.tsx`, each picked for its meaning; runes hate groups have taken up stay out), red-ochre runic inscriptions and knotwork, and `src/art.tsx`'s Burger engraving of the norns and game-icons.net raven and longship, credited on the projects page as their licences ask. Agent replies and plans render as Markdown built into React elements (`src/markdown.tsx`), never HTML, and remote images aren't loaded.
- **Project paths:** `thread.create`'s path is checked at the RPC boundary: it must be an existing folder, and is stored as its real path (`~` expanded, symlinks and trailing slashes resolved), so one folder is always one project. It needn't be a git repo; only diffs need git.
- **Quota:** Claude Code's `rate_limit_event` becomes a `quota` report when the window changes (status, window, use, reset time, whether extra usage is paying), recorded as `harness.quota.reported` and kept per harness in the `quota` table (ADR 0005).
- **Spend caps:** metered spend caps in USD, daily and monthly, for the profile and per project folder, live in the home's `spend-caps.yaml`, read on each `turn.send` (a broken file rejects the turn naming the file and key). Spend is metered usage since the local day or month began, turns on a subscription's extra usage included, never subscription usage. While a cap over the thread is reached, a turn that would spend metered dollars (on a metered target, or on a harness whose latest quota window runs on extra usage and hasn't reset) is rejected (`SpendCapReached`) naming the cap, the spend and how to raise it; subscription and local turns go on. The router leaves those targets out of a new unpinned task, an approved plan's build and an escalation step, and its reason names the cap. `spend.cap.raise` (the web's Raise button, `verdandi chat --raise-cap`) adds the configured amount for the rest of the period, recorded as `spend.cap.raised` in `spend_cap_raises`. `SpendCapsGet` shows each cap's limit and spend: the web composer shows it above the route chip, `verdandi chat` in its banner.
- **Task limits:** a class's route (or `fallback`, for classes that set none) in the routing policy can set `maxCost` and `maxTurns`; the router copies them into the decision's `limits`, pinned tasks included. The reactor passes them to the harness with what the task has spent so far (Claude Code: `maxBudgetUsd` and `maxTurns`, in a process opened for the task, since both are set at spawn). A turn a guard stops ends with status `limit`, which ends the task; its outcome keeps status `limit`.
- **Tasks:** a thread's first turn starts a task (`task.started`, named after that turn), and so does the first turn after a route change or unpin. On each turn end and route change the reactor rebuilds the thread's `TaskOutcome`s from its events into `task_outcomes`: status from the task's last turn, usage by model, running time, and a route change as the user's override. `TaskCostsList` (and `verdandi costs`) sums them into cost per completed task by route, failed tasks' cost included. Trajectories carry their task's id. `task.rate` (the thumbs under a task's last turn in the web UI, `/rate up|down|clear` in `verdandi chat`) records `task.rated`: the outcome keeps the latest `rating`, `null` clears it, and routing memory counts a task rated down as one that didn't succeed.
- **Spend dashboard:** `UsageQuery` computes the dashboard's totals server-side for one project or all, over the last `days` local days or all time: spend per day with metered and subscription dollars kept apart, the quota windows, cost per completed task by task class, usage by model and access mode, override and escalation counts, and savings against always-Opus (the period's tasks' recorded tokens at the catalog's Opus list price), which is always labelled an estimate. The web UI shows it at `#view=spend` (Spend dashboard in the sidebar), with static charts that load only when opened, when a filter changes, or on Refresh. `verdandi costs [--days <n>] [--project <path>]` prints the same totals.
- **Harnesses:** Claude Code runs through the Agent SDK behind the `HarnessAdapter` contract; `HarnessesList` reports which harnesses this verdandid runs (`fake` only under `--dev-fake-harness`).
- **Verdandi tools:** `packages/tools` defines each tool once (`defineTool`: parameters, argument checks, and what it does over verdandid's services; failures come back to the agent as error results). The reactor builds the list once and passes the same `tools` on every turn; a harness takes them when it starts a session and keeps them for its life (cache rule). Claude Code serves them as one in-process MCP server, `verdandi`, from `createSdkMcpServer` in `mcpServers` (ADR 0005), with tools that don't `ask` in `allowedTools`; its calls show as `mcp__verdandi__<name>` `tool.call` items. The fake harness calls one with `tool <name> <json>`. Today: `session_search` (this project's past sessions, or all with `allProjects`, leaving out the calling turn) and `report_blocked` (`task.block` → `task.blocked`, a `blocked` item on the turn, for the escalation ladder). Tool results are untrusted data.
- **Routing:** a thread created without a route is unpinned: when `turn.send` starts a task, the engine loads the project's policy (built-in, plus `.verdandi/routing.yaml` read on each new task) and the decider asks `packages/router` for a `RouteDecision` over the targets whose harness is running. `task.started` carries the decision and its route, which the thread runs on from that turn, applied before its prompt; the projector keeps each in `route_decisions`. A route the user picks (`thread.create` with a route, `thread.route.set` from `verdandi chat` flags or the web route chip) pins the thread: its tasks skip the router, and a pick during a routed task is recorded as the override on that task's outcome. `thread.route.unpin` (`verdandi chat --auto`, the chip's Let the router pick) hands it back from the next task. A message that starts with `@name` (a model the catalog has on a running harness, e.g. `@opus`; `ModelsList` names them, and the web composer offers them as you type) starts a task of its own pinned to it, even mid-task, without pinning or unpinning the thread: the name is stripped from the turn's text and kept in `task.started`'s `inputs.at`, and the decision is a stage-0 pin (`source: "pin"`, reason `Pinned with @opus.`) at the thread's effort if it's on that model, else the policy's for the task's class. Such a task never escalates or moves its build at plan approval. An unknown name, or nothing after it, rejects the turn (`InvalidPin`) naming the valid ones. `thread.budget.set` (`verdandi chat --budget`, the composer's Budget switch) sets the thread's budget mode in place of the policy's `mode`, or clears it with `null`; on an unpinned thread it ends the task, so the next turn starts one routed under it. Routing memory (DESIGN §8.8 level 1): for an unpinned task the engine also loads how the project's earlier tasks went per class and route, from `task_outcomes`, and once `memory.minTasks` of the policy's route clear `memory.minShare` of user overrides, or of tasks that didn't succeed, the router starts there instead, with `source: "memory"` and a reason that says so; `RoutingExplain` shows the memory it consulted. `routing.memory.clear` (the web chip's Clear routing memory, `/forget-routing` in `verdandi chat`) records `routing.memory.cleared`, after which only later tasks count. A broken policy rejects an unpinned task's `turn.send` naming the file and key. A routed task started in plan mode gets its build route with the plan: `plan.requested` carries `execute`, the router's pick for the task's class without its plan override, through the switch-cost gate on the same harness. Approving it commits `task.rerouted` before the approval, and the reactor calls the harness's `reroute` so the rest of the turn runs there (Claude Code: `setModel` inside the turn, ADR 0013). A class's `subagents` in the policy route its `explorer` and `reviewer` subagents; the route carries them, and a harness session keeps the ones it started with (Claude Code: the `agents` option at spawn, ADR 0014). `RoutingExplain` returns a task's decision and trace, and `RoutingSimulate` what the router would pick for a draft, which the web composer shows while you type. Each route change is kept in `ThreadView.routeChanges` and shown between the turns it came between.
- **Batch:** `verdandi batch <evalset.yaml>` (`src/batch/batch.ts`; the eval set's schema is `EvalSet` in contracts) runs each task on each `--route` (`auto`, or `harness/model/effort`; default `auto` and DESIGN §8.10's baselines (a) and (b)) one at a time. Each task runs in a throwaway `git clone --shared` of its repository at its pinned commit, left with only its detached `HEAD` (no other refs, remote or reflog) so the agent can't read later history, with the task's `verify` as its project verifier unless the repository's policy names its own, handed to the run in-process and never written into the copy, where the agent could read it. Then it's graded by running `verify` on the final tree. The run is in-process, on its own home `<home>/batch/<timestamp>/` with its own database (browse it with `verdandi start --home` on that folder), and the profile's spend caps apply to it. Requests are denied unless `--approve`, a task stops after `--timeout` minutes, and a reached cap stops the run. It prints a rough cost estimate first (`--dry-run` stops there), a line per task, and success rate and cost per passed task by route, and writes `report.json` (`BatchReport`).
- **Headless runs:** `verdandi run "<task>"` (`src/cli/run.ts`) sends one turn with nobody at the keyboard: on a new thread in `--project` (default: the current folder) or on `--thread`, in `--mode`, with `--route` pinning the thread (`harness/model/effort`) or handing it to the router (`auto`). It follows the thread feed until that turn completes, streaming the agent's text to stdout, or with `--json` printing one object at the end (thread, turn, task, status, route, cost with metered and subscription dollars apart, reply, error). It never approves anything: the agent's first request interrupts the turn and fails the run, naming the request and `verdandi chat --thread <id>`, unless `--deny-requests` denies each. Ctrl+C interrupts the turn. The exit code says how it ended: 0 completed, 1 it couldn't run, 2 bad flags, 3 failed (an error, or the turn's last verifier failed), 4 a task limit, 5 a request, 130 interrupted. It ends with its own turn, so an escalation's follow-up turn runs unwatched.
- **Replay:** `task.started` v2 keeps what the router read besides the turn's text and mode (`inputs`: the thread's route, pin, budget mode, warm session and its cached tokens, the running harnesses, routing memory, and a reached spend cap); v1 reads as v2 without them. `verdandi routing replay [--policy <file>] [--project <path>]` opens the database read-only, classifies each saved task again with the decision layer, routes it with its recorded inputs under the proposed policy (or each project's current one), and lists the tasks that would route differently and to what, with an estimated cost change: each task's recorded tokens at both targets' catalog list prices. Tasks from before `inputs` replay on stated assumptions. A broken policy file fails naming the file and the key.
- **Decision layer:** on each `turn.send` the engine asks `Decide` (`packages/decisions`, on its `rules` backend: ADR 0009) typed questions about the turn's text: a new task's class and difficulty, and for a later turn whether it corrects the agent. The router classifies with those answers, an answer below its question's minimum confidence is marked `lowConfidence` and the caller takes its safe default (the router: the budget mode's fallback), and a correction lowers the corrected task's `implicitSatisfaction`. Each answer is recorded as `decision.recorded`, right before the turn it is about, and kept in `decisions` for the lab.
- **Router:** `packages/router` turns a task (text, mode, pin, warm session, running harnesses, provider health and quota) into a `RouteDecision` with a one-sentence reason and a trace: stages 0–5 of DESIGN §8.4 with routing memory in stage 4, the `rules` classifier, and the catalog and built-in policy as JSON with project layers on top. The fake harness's models (`@verdandi/testkit`'s `fakeCatalog`) join the catalog when it runs.

Not built yet: escalation triggers beyond verifiers, de-escalation and auto effort within a task, decision backends beyond `rules`, a cleanup policy for old worktrees and checkpoints, decision-layer relevance for memory, skills and everything later in DESIGN.md §21. For how those will fit in, see DESIGN.md §6–§10.

## Where code lives

- **Now:**
  - `apps/server`: verdandid and the `verdandi` CLI (`start`, `open`, `chat`, `run`, `doctor`, `costs`, `routing`, `batch`); `src/batch` runs eval sets. `src` has a folder per feature (`routing`, `memory`, `spend`, `tasks`, `search`, `worktrees`, `checkpoints`, `diffs`, `terminals`, `attachments`, `verifiers`, `batch`, `projects`, `home`), each holding its logic, tests and CLI command (`*-cli.ts`). `src/event-store` holds the decider, projector, engine, reactor, SQLite and migrations; `src/rpc` the WebSocket API; `src/cli` `verdandi chat`, `run`, `open` and `doctor`;
  - `apps/web`: the web UI (React). `src/state.ts` folds feed messages into what the page shows, `src/client.ts` is the RPC connection, `src/ui` holds shared widgets, and each feature (`threads`, `composer`, `routing`, `spend`, `diffs`, `memory`, `terminals`, `worktrees`) has its own folder;
  - `packages/contracts`: every schema sent over the wire or persisted (commands, events, RPC, harness contract, routes);
  - `packages/harness-claude-code`: the Claude Code adapter and event normalization. `src/smoke.ts` is a manual live check, never run in tests;
  - `packages/trajectories`: builds a turn's trajectory and each task's outcome from events, and redacts secrets; the reactor saves them to `trajectories` and `task_outcomes` (DESIGN §8.8, §14.6);
  - `packages/router`: the pure routing engine; `src/catalog.json` and `src/policy.json` are its data;
  - `packages/decisions`: the decision layer's `Decide` service and its `rules` backend (DESIGN §9.8);
  - `packages/tools`: Verdandi's own tools, defined once for every harness (DESIGN §9.6);
  - `packages/testkit`: the fake harness and temporary Verdandi homes for tests;
  - `docs/`: design and decisions;
  - `.agents/`: agent configuration and skills;
  - `scripts/`: repo tooling.
- **Planned (DESIGN.md §20):**
  - `apps/desktop`;
  - more `packages/harness-*`, `packages/models`, `packages/memory`, `packages/skills`;
  - `plugins/`;
  - `lab/` (Python, offline).
