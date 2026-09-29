# .agents

The canonical agent configuration for this repo. Instructions live in the root `AGENTS.md`, and skills live in `skills/`. Agents that don't read `.agents/skills/` directly reach it through symlinks, maintained by `bun scripts/agents-link.ts`.

## Skill sources

Vendored skills are byte-identical copies of upstream at the commit shown, with each upstream's license in the skill folder. To update one, re-copy the folder at a newer commit and update this table. Goldiloop-specific overrides go in `AGENTS.md`, never into vendored files.

| Skills | Upstream | Commit | License |
|---|---|---|---|
| `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) `skills/` | `e3ba2aa` | MIT |
| `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `writing-plans`, `writing-skills` | [obra/superpowers](https://github.com/obra/superpowers) `skills/` | `8ca22db` | MIT |
| `grill-me` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/productivity/grill-me` | `d81f3a1` | MIT |
| `spike` | Adapted, not vendored: Hermes Agent's `spike` ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) `b8a8be1`), which came from [gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done) | — | MIT |

### Deliberately left out

- **`using-superpowers`:** it tells the agent to invoke skills before *any* response, which costs tokens on every turn. Two vendored skills link to its `references/` folder; read those files [upstream](https://github.com/obra/superpowers/tree/8ca22db/skills/using-superpowers/references) if needed.
- **`diagnosing-superpowers`, `ponytail-gain`, `ponytail-help`:** these are about the plugins themselves, not about this repo.
- **Hermes's own versions** of the superpowers skills and of `grill-me`: we vendor the originals instead, because the Hermes copies call Hermes-only tools.
- **Hermes's user-facing skill library** (email, media, finance and so on): it isn't for developing Goldiloop. The candidates for Goldiloop's own bundled skills are covered in DESIGN.md §14.4.
