# 0037 · Hub skills install pinned to a commit, through the proposal flow

## Status

Accepted (issue #218, 2026-10-04).

## Context

DESIGN §14.4 planned a skills hub without saying what pinning means, what happens to the user's edits on update, how a skill is checked, or where an install's approval waits. A skill is instructions an agent follows plus scripts it may run. ClawHub had about 20% malicious skills by mid-February 2026, several passed two scanners, and a scanner that reads natural language can't be relied on. Rivals keep local edits by comparing content hashes (OpenClaw's install digests, Hermes skipping locally edited skills).

Verdandi already has a gate for skill changes: `skill_manage` proposals go through `skill-files.ts`'s path guards, a secret and injection scan, and a `skill.proposed` request whose diff the user allows. That request belongs to a turn, and a CLI install has none.

## Decision

1. **Sources are git repos named in config.** `sources` in the home's `skills.yaml` maps names to git URLs or absolute folders, read on each install. No curated index or shared folders yet.
2. **verdandid fetches, never a client.** The `SkillInstall` RPC makes a bare clone in a temp folder (git through `childEnv()`, nothing checked out, so no hook, filter or submodule of the repo runs; no credential prompt, terminal or Git Credential Manager; killed after 5 minutes), resolves the ref to a full commit SHA, and reads the skill's folder from git's objects: text files only, no links or submodules, no two names that differ only in case, names every OS can write (`pathProblem`), at most 100 files and 1 MiB, each under `skillFileCap`. The clone is deleted at once. A cached mirror can come if repos get big.
3. **One request with every file.** `skill.install.proposed` holds each file as a `SkillChange` (`write_file`, before and after), the pin, the upstream digests, the kept files and the scans' advice. The decider checks each change with `changeProblem`; the engine asks the injection question about each new file. Allowing it records `skill.install.resolved`, and the reactor writes every file or none (`applyChanges`, which re-runs the path guards, checks each file is still its `before`, and puts back what it wrote if a later write fails), then records `skill.installed` with the pin and digests, or the error. A proposal made against another state of the skill (`from` isn't the SHA installed now, as after an uninstall or another update) writes nothing.
4. **Scans advise, the user decides.** Unlike an agent's proposal, which a scan hit refuses, a hub install's verdicts are shown on the diff and never refuse it: the user asked for this skill from a source they named, and no scan makes approval unnecessary. A clean scan says so, and says it proves nothing.
5. **The request waits on one well-known thread.** Every install and update waits on the profile's Skills hub thread (`hubThread`, id `skills-hub`) in the workspace, created by the first install. Its requests have no turn: `requests.turn_id` became nullable (migration 32), and their answer is `skill.install.resolved`, not `approval.resolved` (whose v1 requires a turn), so no turn's end denies them. One thread rather than one per install, because an install has no conversation of its own: per-install threads would fill the thread list with empty, untitled threads, while one thread lists every request still waiting and is easy to find (`verdandi chat --thread skills-hub`). A newer proposal for the same skill denies the one waiting, so there's one request per skill.
6. **Edits win by digest.** An update replaces only files whose SHA-256 still matches the recorded one. A file the user changed or deleted is kept, and its upstream change goes in `kept` as a diff. Taking it is a new proposal from the same ref with `take`, from the user's file to upstream's; the proposal keeps the files taken so far (`taken`), so taking another adds to them. Files the user added aren't tracked and aren't touched.
7. **No curation, uninstall to leave.** Installed skills get no row in `skills`, so the curator never marks them stale or archives them, as with skills the user wrote. `skill.uninstall` records `skill.uninstall.requested` on the profile's stream; the reactor moves the folder to `<home>/skills-archive/` (as `<name>-<n>` when an older copy is there) and records `skill.uninstalled`, with an error and the skill still installed when it couldn't move it.
8. **History for free.** Each file written is a `skill_changes` row (`<request>:<path>`), so the Skills panel's history shows it and can revert it. A reverted file then differs from its digest, so the next update keeps it like any other edit.

## Consequences

- The ask (boundary 5 of ADR 0025) now covers hub installs and updates, and the RPC boundary (boundary 4) covers what a hub install reads. The scans on a hub install are a heuristic that advises; they never were a boundary.
- verdandid makes outbound git calls, but only to sources the user named in `skills.yaml`, and only when the user asks for an install or update.
- A pending install outlives verdandid restarts and any turn, until answered or replaced.
- An executable bit isn't kept: skills' scripts are run through an interpreter (`bash scripts/x.sh`). Binary files, links and submodules can't be installed.
- `skills.yaml` gained a key; a broken `sources` fails the install naming the file and key, and fails verdandid's start like `extraFolders`.
