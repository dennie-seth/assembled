# Agent Runner

**Author:** Claude (Sonnet 5)
**Status:** design agreed — implementation is Phase 2 (see `docs/PLAN.md`)

## Architecture

```
Kanban card (tasks/T-NNNN.md, status: ready)
   |  human clicks Run, or card enters `ready` with an `agent:` field set
   v
AgentRunner
   |- creates a git worktree for the card:  worktrees/T-NNNN  (branch feature/T-NNNN off develop)
   |- resolves the card's `agent:` field -> .claude/agents/<agent>.md
   |- spawns:  claude -p --output-format stream-json --allowedTools <from agent def>
   |             (cwd = worktrees/T-NNNN)
   v
NDJSON stream (stdout)
   |- parsed into typed events
   |- forwarded over WS to the card's log pane (live)
   |- persisted verbatim to tasks/.runs/T-NNNN-<ts>.jsonl
   v
Card lifecycle (below)
```

One worktree per running agent. Two agents never share a checkout — this is
what makes parallel cards safe (see `docs/branching.md`).

## Lifecycle

```
ready --[run]--> in-progress --[implementer done]--> VALIDATION --[PASS]--> review --[human]--> done
                     ^                                    |
                     |------------------[FAIL + reasons]--+

(run never starts, or crashes before producing a verdict) --> blocked + reason
```

| State | Who acts | Entry condition | Exit |
|---|---|---|---|
| `ready` | — | human queues the card | Run triggers `in-progress` |
| `in-progress` | implementer agent (`infra`/`server`/`client`/`assets`/`audio`) | Run started | implementer signals done -> `VALIDATION` |
| `VALIDATION` | `reviewer` agent | implementer finished | PASS -> `review`; FAIL -> `in-progress` (with reasons attached to the card) |
| `review` | human only | reviewer PASS | human merges and moves to `done`, or bounces back to `in-progress` with notes |
| `done` | human only | human approval | terminal |
| `blocked` | — | runner failed to launch/complete a run (crash, tool denial, timeout) | human investigates, requeues to `ready` |

**Non-negotiable:** an agent never moves a card to `done` and never merges a
PR. `review` is the terminal state automation can reach — a human is the only
actor that can advance `review` -> `done`. This is the one quality gate that
isn't self-graded. See `CLAUDE.md` invariants and `docs/PLAN.md` §Phase 2.

If the runner itself fails — the CLI process won't spawn, the stream dies
mid-run, the worktree can't be created — the card goes to `blocked` with the
failure reason attached. `blocked` is not a lifecycle state an agent chooses;
it's what happens when the lifecycle can't run at all.

## Implementer workflow (ordering)

Every implementer agent (`infra`, `server`, `client`, `assets`, `audio`)
follows the same order, enforced by the `tdd` skill:

1. **Think through the design** — restate the task's acceptance criteria,
   identify the interfaces/modules touched, check `shared/` for anything that
   must stay the single source of truth.
2. **Write the failing test cases** — committed before implementation. Red
   first; a test that passes before the implementation exists proves nothing.
3. **Implement to green** — smallest change that satisfies the tests.
4. **Self-verify** — run the `verify` skill for the subsystem (tests + lint +
   build) before handing off.
5. **Hand to the reviewer** — card moves `in-progress` -> `VALIDATION`; the
   implementer does not grade its own work.

## Agents

| Agent | Path scope | Tools | Model | Role |
|---|---|---|---|---|
| `infra` | `tools/**`, `.github/**`, `.claude/**`, `docs/**` | Read, Write, Edit, Grep, Glob, Bash (node/npm/vitest, git) | `sonnet` | Board tooling, CI config, docs, agent/rule/skill authoring |
| `server` | `server/**`, `shared/**` | Read, Write, Edit, Grep, Glob, Bash (cmake, doctest/ctest, clang-format, docker compose for a throwaway PG, git) | `sonnet` | Drogon/Postgres backend |
| `client` | `client/**`, `shared/**` | Read, Write, Edit, Grep, Glob, Bash (scons, godot --headless, gdUnit4, git) | `sonnet` | Godot + GDExtension |
| `assets` | `assets/**` | Read, Write, Edit, Bash (AssetAgent/ComfyUI HTTP), Grep, Glob | `sonnet` | Generated 2D art; license-allowlist hook gates every run; needs GPU; active only after art direction lands (PLAN.md open question 3) |
| `audio` | `assets/src/**`, `assets/final/audio/**` | Read, Write, Edit, Bash (AssetAgent/ComfyUI HTTP, ACE-Step / Stable Audio), Grep, Glob | `sonnet` | Generated music/SFX; shares the `AssetAgent` interface with `assets` (DRY) |
| `planner` | `tasks/**` (read/write), `docs/**` (read-only) | Read, Write, Edit, Grep, Glob — no Bash, no source paths | `opus` | Audits/extends the backlog against the design docs. Never touches `status`, never deletes a card, never marks anything `done`. |
| `reviewer` | path-aware — loads rules for whatever paths a card actually touched | Read, Grep, Glob, Bash (subsystem tests/lint/build only) | `opus` | The `VALIDATION` gate. Read-only on source: no Write/Edit of production code. |

Full definitions: `.claude/agents/*.md`.

### Model selection

Each agent definition's frontmatter may set an optional `model:` field,
e.g.:

```yaml
---
name: reviewer
tools: Read, Grep, Glob, ...
model: opus
---
```

`ConfigLoader.loadAgentDef` passes it through as `agentDef.model`, and
`RunOrchestrator` forwards it to `AgentRunner#start` for that phase, so
`ClaudeCliRunner.buildInvocation` appends `--model <value>` to the spawned
`claude -p ...` invocation. Omit the field to inherit whatever the `claude`
CLI defaults to (no `--model` flag emitted).

Accepted values: a Claude Code model alias (`sonnet`, `opus`, `haiku`,
`fable`) or a full model string (e.g. `claude-sonnet-5`,
`claude-opus-4-1-20250805`, or a Bedrock-style
`us.anthropic.claude-3-5-sonnet-...:0` id). `buildInvocation` does light
validation — non-empty after trimming, no embedded whitespace, doesn't start
with `-` — but deliberately does not hardcode an exhaustive allowlist, since
new model names ship independently of this repo.

Current defaults (easily changed per agent — just edit the frontmatter):
`reviewer` runs on `opus` since it's the quality gate every card passes
through before a human sees it; the five implementer agents (`infra`,
`server`, `client`, `assets`, `audio`) run on `sonnet`.

## Rules

Path-scoped instructions, loaded on demand by whichever agent's tool calls
touch that path. See `.claude/rules/*.md`.

| Rule file | Paths | Covers |
|---|---|---|
| `conduct.md` | all paths (global) | TDD test-first, no free-text UGC, commit trailer, git-flow, never-auto-done, asset provenance |
| `cpp.md` | `server/**`, `client/**` | clang-format, RAII, CMake, doctest, SOLID/DRY, getters/setters, Doxygen |
| `js.md` | `tools/**` | ESM, Vite/Vitest, `127.0.0.1` binding, task-store-is-one-file-per-task |
| `godot.md` | `client/**` (`*.gd`, `*.tscn`, `*.tres`) | GDScript conventions, gdUnit4, scene/node idioms, `shared/` template tables |
| `assets.md` | `assets/**` | License allowlist hook, provenance, LFS, `art/*` branch policy |
| `sql.md` | `server/**` (migrations) | Plain SQL + version table, up/down idempotent, FK-as-UGC-guarantee |
| `planner.md` | `tasks/**` | Card-authoring quality, grounding in design docs, ID/dependency hygiene, never-touch-status / never-delete / never-done guardrails |

## Skills

Reusable procedures agents invoke by name. See `.claude/skills/*/SKILL.md`.

| Skill | Used by | Purpose |
|---|---|---|
| `tdd` | all implementers | The design -> failing tests -> green -> refactor loop; Definition of Done |
| `verify` | all implementers, `reviewer` | Run the changed subsystem's test + lint + build, report green/red |
| `open-review-pr` | all implementers | Commit (with trailer), push `feature/T-NNNN`, open PR to `develop`, move card to `review` — never `done` |
| `review` | `reviewer` | Run `verify`, audit diff against path rules + `conduct.md`, emit PASS/FAIL with notes, set card state |
| `new-migration` | `server` | Scaffold a plain-SQL migration + version bump |
| `new-gdextension-class` | `client` | Scaffold a registered C++ class + GDScript binding + gdUnit4 test |
| `asset-provenance` | `assets`, `audio` | Append to `ASSET_PROVENANCE.md`; refuse if checkpoint license isn't allowlisted |

## Guardrails

- **Worktree per agent.** No two running agents share a checkout. Cleaned up
  when the card leaves `in-progress`/`VALIDATION` (merge or abandon).
- **`--allowedTools` from the agent definition only.** Everything else is
  denied. Never `--dangerously-skip-permissions`.
- **Run stream persisted.** Every NDJSON stream is written verbatim to
  `tasks/.runs/T-NNNN-<ts>.jsonl` — the audit trail for what a run actually
  did, independent of the summarized log pane.
- **Reviewer is read-only on source.** It can run tests/lint/build and read
  files, but it cannot Write or Edit production code. A PASS/FAIL verdict
  from an agent that could also silently patch the code to pass would not be
  a real gate.
- **`review` -> `done` is human-only,** with no exception path. See Lifecycle
  above.
