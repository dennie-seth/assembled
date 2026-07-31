# assembled

**Author:** Claude (Opus 5)

## Big picture

An async-multiplayer "notes" game. Players drop short messages in the world
for others to find. **Zero free-text UGC, ever** — every note is assembled
from a template + word slots, enforced at the database schema via FK
constraints (`template_id`, `slot_a`/`slot_b` reference immutable lookup
tables). Arbitrary text is *unrepresentable*, not just filtered.

Monorepo: Kanban board, C++ server, Godot client, and asset/audio pipelines
all live here. `shared/` is the single source of truth for wire structs and
template IDs — client and server both include it. Violating this = desync
bugs that only appear in prod.

Full plan: [docs/PLAN.md](docs/PLAN.md). Branching: [docs/branching.md](docs/branching.md).

## Repo layout

```
/
|- CLAUDE.md                 # this file
|- CREDITS.md
|- LICENSE
|- .claude/
|  |- rules/                 # path-scoped instructions (load on demand)
|  |  |- cpp.md              # paths: ["server/**","client/**"]
|  |  |- js.md               # paths: ["tools/**"]
|  |  \- assets.md           # paths: ["assets/**"]
|  |- agents/                # subagent defs
|  \- commands/               # custom slash commands
|- docs/
|  |- PLAN.md                # source-of-truth dev plan
|  |- branching.md
|  |- env-inventory.md
|  |- DESIGN.md              # index -> design/*
|  \- design/
|     |- 01-vision.md
|     |- 02-notes-system.md
|     |- 03-net-protocol.md
|     |- 04-data-model.md
|     |- 05-art-direction.md
|     \- 06-audio.md
|- tasks/                    # Kanban source of truth — one .md per task
|- tools/
|  \- board/                 # Node: Kanban + agent console
|- server/                   # C++ Drogon + Postgres
|- client/                   # Godot project + GDExtension
|- shared/                   # protocol structs, template tables (C++ hdr-only)
|- assets/
|  |- src/                   # generation workflows + prompts (versioned)
|  \- out/                   # generated (gitignored except curated finals)
\- .github/workflows/
```

## Build / run (per subsystem)

None of these exist yet — this is Phase 0. Populated as each phase lands:

- `tools/board` (Phase 1): Vite + Vitest, npm scripts. `npm run dev`, `npm test`.
- `server` (Phase 4): CMake + Drogon + libpqxx, doctest. `cmake --build build`, `ctest`.
- `client` (Phase 5): Godot 4.x + godot-cpp via SCons. `scons`, open in Godot editor.
- Dev Postgres (Phase 4): `docker compose up` (dockerd/moby, not containerd).

## Conventions

- **TDD, non-negotiable.** Test file committed before implementation. Red -> green -> refactor.
- **DRY/SOLID.** One reason to change per module. Depend on interfaces, not impls.
- **Branching:** git-flow (`main`/`develop`/`feature/*`/`release/*`/`hotfix/*`)
  plus a dedicated `art/*` line for assets, strictly additive. See
  [docs/branching.md](docs/branching.md). Phase 0 is one consolidated
  `feature/phase-0-foundation` branch; branch-per-task resumes in Phase 1.
- **Network binding:** all local tools (board server, PTY bridge, etc.) bind
  `127.0.0.1` only. A PTY bridge on `0.0.0.0` is a remote shell for the LAN.
- **`shared/` is the single source of truth** for wire structs and note
  template IDs. Never duplicate a template ID or struct layout elsewhere.
- **Asset license allowlist:** generated assets only from Apache-2.0 /
  OpenRAIL / CC0-derived models. No CC-BY-NC weights (MusicGen, AudioGen) —
  this repo is public; NC would poison forks. Every generated asset logs
  `model + license + prompt + seed` in `ASSET_PROVENANCE.md`.
- **Credit:** every Claude-authored commit carries
  `Co-authored-by: Claude <noreply@anthropic.com>`. Docs carry an `Author:`
  line. `CREDITS.md` rolls this up per subsystem.
- Path-scoped rules load on demand from `.claude/rules/` — see below.

## Invariants / do not touch

- Never add a free-text field a player can populate. Notes are always
  `template_id` + slot FKs. This is the entire point of the game.
- Never commit generated intermediates under `assets/out/` — it's
  gitignored on purpose; only curated finals under `assets/final/` are
  committed.
- Never touch two binaries in the same `art/*` branch merge conflict by
  editing — pick a side. Binary merges have no textual resolution.
- Never add Git LFS patterns for images before the art-direction decision
  (PLAN.md open question 3) lands — see `.gitattributes`.
- Never auto-move a Kanban card to `done` from automation (Phase 2+) —
  `review` -> `done` is a human-only gate.

## Pointers

- Full plan, phase breakdown, data model, API shape: [docs/PLAN.md](docs/PLAN.md)
- Branching + binary asset policy: [docs/branching.md](docs/branching.md)
- Design docs index: [docs/DESIGN.md](docs/DESIGN.md)
- Environment inventory (dev machine): [docs/env-inventory.md](docs/env-inventory.md)
- Path-scoped conventions: `.claude/rules/cpp.md`, `.claude/rules/js.md`, `.claude/rules/assets.md`
