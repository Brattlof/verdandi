# 0023 · Background review runs as a hidden routed task

## Status

Accepted (issue #131, 2026-10-02).

## Context

DESIGN §14.5 reviews finished tasks for memories and skills on a cheap target, after the decision layer says a task is worth it. The review's cost must count under its own task class, spend caps and quota must apply, and it must never spend metered dollars unless allowed. All of Verdandi's cost plumbing (the usage ledger, spend caps, the spend dashboard's cost per class, quota reports) hangs off tasks and turns in threads. Proposals need the user's approval, but the existing pending requests (#129's `skill.proposed`, the agent's approvals) belong to a running turn and are denied when it ends, while a review finishes after its task's turn.

## Decision

1. **Trigger.** After a turn of a task finishes with status success and Verdandi doesn't escalate it, the reactor builds a digest of the task's turns since the thread's last review decision and sends `task.review`. The engine asks `reviewQuestion` (`task.review-worth`) about the digest; the decider records `decision.recorded` v2, whose new `state` keeps the digest (v1 always read the turn's text, so `verdandi decisions eval` replays the right state), and on a yes, `review.requested`.
2. **The review is a routed task in a hidden review thread.** The reactor creates a thread in the reviewed project with `review.start` (`thread.created` + `review.started`, which marks it), then sends its one turn in ask mode. The decider routes it in a fixed class, `aux.review` (the built-in policy: `cc-haiku` at low effort, `maxCost` 0.25), without asking the decision layer, so its cost lands under that class in the dashboard. Review threads stay out of thread lists and session search.
3. **Guards.** The turn goes through `turn.send` like any other, so spend caps apply. The decider refuses it (`ReviewSkipped`) when its target would spend metered dollars and `review.yaml` doesn't set `allowMetered: true` (recorded on `review.started`), or when the harness's subscription window is nearly or fully used up with no extra usage paying. It gets no Verdandi tools (nothing it does takes effect unapproved), no checkpoints, verifiers, escalation or memory nudge, and any request it raises is recorded and denied at once.
4. **Proposals are pending requests on the reviewed thread, tied to its finished turn.** The reactor parses the reply's JSON as untrusted data (at most 5 of each kind) and sends each item as `review.propose`, which the decider scans like a memory save or skill proposal. A memory becomes `memory.proposed` (a new request kind; allowing it records `memory.saved` in the same commit, or is refused while the store is full). A skill create or patch reuses `skill.proposed` and its settle path. A routing note becomes a project memory proposal, since nothing reads routing notes yet. Requests of an ended turn aren't denied by later turns, so they wait for the user.
5. **Off by default.** `review.yaml` in the home (`enabled`, `allowMetered`), read when verdandid starts like `memory.yaml`; a broken file stops it, naming the file and key.

## Consequences

- No parallel ledger: a review is a task, so its spend, quota, routing decision, outcome and trajectory are recorded like any task's. `verdandi costs` and the dashboard count review tasks, under `aux.review`.
- On Claude Code the review is a fresh session with Claude Code's own system prompt and the project's settings, in the project folder, read-only. That costs more than a bare model call; the native harness (M4) can make it a fork of the task's session that shares its cache (DESIGN §14.5).
- Every yes leaves a hidden thread behind, one per review. Nothing lists them; a client that knows the id can still open one to see what the review saw and said.
- A review requested just before verdandid stops never starts, and its turns aren't asked about again.
- The trigger runs after each successful turn of a task, not once at its end, since a task has no end event: a long task can be reviewed more than once, each time over the turns since the last.
