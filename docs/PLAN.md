# Development Plan

> **Author:** Claude (Opus 5) · **Reviewed:** @DennieSeth · **Status:** v4
> Machine-readable plan. Terse by design. Phases are strictly ordered; tasks inside a phase may parallelize unless `depends_on` says otherwise.

---

## 0. Ground Rules

**Non-negotiable**

| Rule | Meaning |
|---|---|
| TDD | Test file committed **before** impl. Red -> green -> refactor. |
| DRY/SOLID | One reason to change per module. Depend on interfaces, not impls. |
| No UGC | Zero free-text from players, ever. Enforced at schema level. |
| Local-first | Nothing requires a cloud service to develop or run. |
| Credit | Claude-authored commits carry `Co-authored-by: Claude <noreply@anthropic.com>`. Docs carry `Author:` line. `CREDITS.md` rolls up per subsystem. |

**Definition of Done** (every task)
1. Tests written first, passing.
2. `docs/` updated if behaviour or interface changed.
3. CI green (once Phase 3 lands).
4. No TODO without a task ID: `// TODO(T-0042): ...`

**Licensing**
- Code: MIT (permissive, matches deps).
- Generated assets: only Apache-2.0 / OpenRAIL / CC0-derived models. **No CC-BY-NC weights** (MusicGen, AudioGen) — repo is public, NC would poison forks.
- `ASSET_PROVENANCE.md`: every generated asset logs `model + license + prompt + seed`. Written by the asset agent, non-optional.

---

## 1. Repo Layout

```
/
|- CLAUDE.md                 # lean; big picture + commands + conventions
|- CREDITS.md
|- LICENSE
|- .claude/
|  |- rules/                 # path-scoped instructions (load on demand)
|  |  |- cpp.md              # paths: ["server/**","client/**"]
|  |  |- js.md               # paths: ["tools/**"]
|  |  \- assets.md           # paths: ["assets/**"]
|  |- agents/                # subagent defs
|  \- commands/              # custom slash commands
|- docs/
|  |- PLAN.md                # this file
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
|  \- out/                   # generated (gitignored except curated)
\- .github/workflows/
```

**Rationale:** `shared/` exists so note template IDs and wire structs have exactly one definition. Client and server both include it. Violating this = desync bugs that only appear in prod.

---

## 2. Branching Model

git-flow, plus a dedicated `art/*` line. Monorepo (decided: 2026-07-31).

```
main        tagged releases only          CI: full build + upload artifacts
develop     integration                   CI: build + test every push
feature/*   one per task                  feature/T-0042-taskstore-parser
art/*       asset work                    art/tileset-forest, art/ui-icons
release/*   version stabilisation
hotfix/*    cut from main
```

**Card status <-> git state** (enforced by the Agent Runner, Phase 2):

| Card | Git |
|---|---|
| `ready` | no branch |
| `in-progress` | branch cut from `develop`, agent runs in its own worktree |
| `review` | PR open -> `develop` |
| `done` | merged, branch deleted |

Worktrees are what make parallel agents safe — two agents never share a checkout.

### Binary asset policy

**Rules, in priority order:**
1. `assets/out/` is gitignored. Generation is reproducible from `assets/src/` (workflow JSON + prompt + seed + model hash), so intermediates are never committed.
2. Only **curated finals** enter git, under `assets/final/`.
3. `art/*` branches are **strictly additive** — new files only. Two branches must never touch the same binary. Binary merge conflicts have no resolution short of picking a side.
4. One `art/*` branch = one coherent asset set (a tileset, an icon pack), merged whole.

**Git LFS: decide with art direction (open question 3).**
- Pixel art -> sprites are single-digit KB. **Plain git is fine**; LFS is pure overhead.
- Painted/high-res 2D -> MB per asset. **LFS required.**
- Audio -> MB regardless. **LFS from day one** for `assets/final/audio/**`.

Setting up LFS *after* binaries land requires a history rewrite. Configure `.gitattributes` in T-0001 with audio covered, and add image patterns once art direction is settled.

Note GitHub's free LFS allowance (1 GB storage / 1 GB monthly bandwidth per account) applies to public repos too. If the project outgrows it, the fallback is to ship large assets as release attachments rather than repo contents.

---

## 3. Phase Overview

| # | Phase | Deliverable | Blocks |
|---|---|---|---|
| 0 | Foundation | repo, docs, conventions, CLAUDE.md | all |
| 1 | Board | Kanban web UI, file-backed tasks | 2 |
| 2 | Agent Runner | Kanban card -> `claude -p` -> streamed output | 3+ |
| 3 | CI/CD | GH Actions, Windows build spike | 4,5 |
| 4 | Server | Drogon + PG + notes API | 5 |
| 5 | Client | Godot + GDExtension + net | 6 |
| 6 | Art Pipeline | ComfyUI agent, style lock | — |
| 7 | Audio Pipeline | ACE-Step / Stable Audio agent | — |
| 8 | Vertical Slice | playable loop end-to-end | — |

Phases 6/7 are independent of 4/5 and can run in parallel once Phase 2 exists.

---

## Phase 0 — Foundation

**Goal:** a repo an agent can navigate without guessing.

| Task | Description |
|---|---|
| T-0001 | `git init`, MIT LICENSE, `.gitignore` (Godot + C++ + Node + `assets/out/`) |
| T-0001a | `git flow init` (`main`/`develop`, standard prefixes); document `art/*` as an extra line |
| T-0001b | `.gitattributes`: LF normalisation, `*.gd`/`*.tscn` text, LFS for `assets/final/audio/**`. **Images: plain git, no LFS** — pixel art is single-digit KB (art direction resolved) |
| T-0002 | `CLAUDE.md` — <200 lines. Big picture, build cmds, conventions, do-not-touch list |
| T-0003 | `.claude/rules/*.md` with `paths:` frontmatter (cpp / js / assets) |
| T-0004 | `docs/design/` skeleton + `DESIGN.md` index |
| T-0005 | `CREDITS.md` + commit-trailer convention documented |
| T-0006 | `.editorconfig`, `.clang-format` (LLVM base, 4-space, 100 col) |

**DoD:** fresh `claude` session in repo root can answer "how do I build the server?" from files alone.

---

## Phase 1 — Board (Kanban + Chat)

**Goal:** localhost page: Kanban left, agent console right. Tasks live in git.

### Architecture

```
Browser (vanilla ESM + Vite)
   |  HTTP  /api/tasks           REST
   |  WS    /ws/board            task change events
   |  WS    /ws/pty              terminal I/O
   v
Node process (127.0.0.1 only)
   |- TaskStore      <- interface; FsTaskStore impl over tasks/*.md
   |- TaskWatcher    <- chokidar -> WsHub broadcast
   |- PtyBridge      <- node-pty
   \- HttpApi / WsHub
```

**Bind `127.0.0.1` explicitly.** A PTY bridge on `0.0.0.0` is a remote shell for the LAN.

### Task file schema

```yaml
---
id: T-0007
title: Implement TaskStore parser
status: backlog        # backlog|ready|in-progress|review|done|blocked
priority: P1           # P0..P3
phase: 1
agent: infra           # infra|server|client|assets|audio|null
depends_on: [T-0002]
created: 2026-07-31
---
## Context
...
## Acceptance
- [ ] ...
```

**One file per task.** A single `board.json` guarantees merge conflicts.

### Tasks

| Task | Description | Tests first |
|---|---|---|
| T-0010 | Scaffold `tools/board`, Vite + Vitest, npm scripts | smoke |
| T-0011 | Task md parser/serializer (frontmatter <-> object) | round-trip, malformed frontmatter, missing fields, unicode |
| T-0012 | `TaskStore` iface + `FsTaskStore` (list/get/create/update/move) | CRUD, ID collision, atomic write |
| T-0013 | ID allocator `T-NNNN`, gap-tolerant, no reuse | concurrent alloc, gaps |
| T-0014 | REST API (`GET/POST/PATCH /api/tasks`) | status codes, validation reject |
| T-0015 | `TaskWatcher` + WS broadcast | external edit -> event |
| T-0016 | Board UI: columns, cards, drag->status | — (manual) |
| T-0017 | Card detail: body render, deps, edit | — |
| T-0018 | `PtyBridge` + xterm.js panel, resize handling | spawn/write/kill, cleanup on disconnect |
| T-0019 | Dep validation: block move to `in-progress` if deps open | cycle detect, unmet dep |

**Exit criteria:** create task in UI -> file appears in `tasks/` -> `git diff` shows it -> edit file in editor -> UI updates live. Terminal runs `claude` interactively.

**Explicitly NOT in Phase 1:** auth, multi-user, remote access, task assignment automation.

---

## Phase 2 — Agent Runner

**Goal:** card -> agent execution -> streamed result -> card moves.

| Task | Description | Tests first |
|---|---|---|
| T-0020 | `AgentRunner` iface; `ClaudeCliRunner` spawns `claude -p --bare --output-format stream-json` | arg construction, env isolation |
| T-0021 | NDJSON stream parser -> typed events | partial lines, split UTF-8, malformed JSON, huge lines |
| T-0022 | Stream events -> WS -> card log pane | — |
| T-0023 | Prompt builder: task md + `.claude/rules` refs -> prompt | template correctness, injection of task body |
| T-0024 | Lifecycle: `ready`->`in-progress`->`review`; failure -> `blocked` + reason | state machine transitions, illegal transitions |
| T-0025 | Kill/cancel running agent, clean PTY + child procs | orphan check |
| T-0026 | Run log persisted `tasks/.runs/T-NNNN-<ts>.jsonl` | — |
| T-0027 | `--allowedTools` allowlist per `agent:` field | denied tool rejected |

**Design constraint:** agent never auto-moves a card to `done`. `review` is terminal for automation; a human moves `review`->`done`. Non-negotiable — it's the only quality gate that isn't self-graded.

**Exit criteria:** drag card to `ready`, click Run, watch live output, land in `review` with a diff to inspect.

---

## Phase 3 — CI/CD

**Goal:** every push builds and tests both targets.

| Task | Description |
|---|---|
| T-0030 | **SPIKE:** verify `windows-latest` free runner can (a) build godot-cpp via SCons/MSVC, (b) `godot --headless --export-release`. Timebox 4h. Document result in `docs/ci-notes.md`. |
| T-0031 | `ci-board.yml` — node, vitest, lint |
| T-0032 | `ci-server.yml` — ubuntu, cmake, doctest, PG service container |
| T-0033 | `ci-client.yml` — **windows + linux**, godot-cpp build + headless export (gated on T-0030) |
| T-0034 | Cache: godot-cpp objs, export templates, vcpkg/conan |
| T-0035 | Artifact upload: client zip, server binary |
| T-0036 | Local `pre-push` hook mirroring CI (fast subset) |

**T-0030 note:** Godot 4 `--headless` uses the dummy rasterizer; 2D import + export packaging are CPU-only. Expectation is no GPU needed. If the spike disproves this, fallback = self-hosted runner on the dev box (Windows service, not WSL — it needs the GPU and the Godot editor).

**Runner strategy:** GH hosted for everything (public repo = free/unlimited). Self-hosted only for GPU asset generation (Phase 6), never for building.

---

## Phase 4 — Server

**Goal:** notes API, no game client needed to test it.

### Data model (`docs/design/04-data-model.md`)

> **Sketch only.** The full schema — identity, sessions, items, escrow, unlocks, vocabulary — is in `docs/HANDOFF.md` §5 and lands as `docs/design/04-data-model.md` (T-0090).

```sql
-- immutable template tables, seeded from shared/ headers
note_templates(id SMALLINT PK, slots SMALLINT);   -- e.g. "Try {0} ahead"
note_words(id SMALLINT PK, category SMALLINT);

-- world is DISCRETE: anchor tags, never coordinates (open question 2, resolved)
archetype(id SMALLINT PK);
anchor_tag(archetype_id SMALLINT, tag SMALLINT, PRIMARY KEY(archetype_id, tag));

notes(
  id           BIGSERIAL PK,
  archetype_id SMALLINT  NOT NULL,
  anchor_tag   SMALLINT  NOT NULL,
  facing       SMALLINT,                -- optional
  item_ref     SMALLINT,                -- optional
  is_broadcast BOOLEAN   NOT NULL DEFAULT false,  -- petitions have no anchor
  template_id  SMALLINT  NOT NULL REFERENCES note_templates,
  slot_a       SMALLINT  REFERENCES note_words,
  slot_b       SMALLINT  REFERENCES note_words,
  author       UUID      NOT NULL,      -- phrase-derived identity token
  score        INT       NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON notes (archetype_id, anchor_tag, score DESC);
-- no GiST index. no geometry. lookup is equality.

ratings(note_id BIGINT, voter UUID, val SMALLINT, PRIMARY KEY(note_id, voter));
```

FK constraints on `template_id`/`slot_*` are the UGC guarantee — arbitrary text is *unrepresentable*.

### API (`docs/design/03-net-protocol.md`)

```
POST   /v1/notes            {archetype,tag,template_id,slots[]}  -> 201 {id}
GET    /v1/notes?archetype&tag&limit                             -> 200 [{...}]
POST   /v1/notes/{id}/rate  {val:+/-1}                           -> 204
```

### Tasks

| Task | Description | Tests first |
|---|---|---|
| T-0040 | CMake skeleton, Drogon + libpqxx/DbClient, doctest wired | build smoke |
| T-0041 | `docker compose` PG for dev (Rancher: dockerd runtime) | — |
| T-0042 | Migrations (plain SQL + version table; no ORM) | up/down idempotent |
| T-0043 | `shared/note_templates.hpp` + SQL seed generator; also seeds **archetype + anchor-tag tables** | C++/SQL parity test |
| T-0044 | `NoteRepo` iface + PG impl | CRUD, FK reject, **tag equality lookup** (no radius) |
| T-0045 | `POST /v1/notes` handler + validation | bad template_id -> 400, slot arity mismatch -> 400 |
| T-0046 | `GET /v1/notes` tag equality + ranking | ordering, limit clamp, empty tag |
| T-0047 | Rating, one vote per player | double-vote idempotent |
| T-0049 | Rate limiting per token | burst rejected |
| T-0050 | Structured logging + `/healthz` | — |

**Exit criteria:** full API exercised by `curl` and an integration test suite against a throwaway PG container.

---

## Phase 5 — Client

| Task | Description | Tests first |
|---|---|---|
| T-0060 | Godot 4.x project + godot-cpp submodule, SCons build | extension loads |
| T-0061 | GDExtension skeleton, one registered class round-trips to GDScript | binding test (gdUnit4) |
| T-0062 | libcurl vendored, async multi-handle pumped from `_process` | no main-thread block |
| T-0063 | `NoteClient` GDExtension node: post/fetch/rate/roll | mock server, timeout, 4xx/5xx paths |
| T-0064 | Note rendering from `shared/` template table + localized strings | all templates render, missing loc key |
| T-0065 | Note composer UI (dropdown selection only) | — |
| T-0066 | **Seed-phrase identity**: server generates phrase -> derives token -> discards phrase; client persists phrase to file | derivation determinism, phrase absent from DB, persistence |
| T-0067 | Offline/degraded mode — game **runnable** with server down, **not completable** | server-unreachable path |

**T-0067 revised.** The game must run, explore, and progress partway with no server — but the ending is genuinely unreachable offline (`01-vision.md` §5). Design intent, not an engineering fallback.

---

## Phase 6 — Art Pipeline

| Task | Description |
|---|---|
| T-0070 | ComfyUI install + `--listen` on dev box; document GPU/VRAM baseline |
| T-0071 | `AssetAgent`: workflow JSON template -> `POST /prompt` -> poll `/history` -> fetch `/view` |
| T-0072 | Style lock: curate 30–50 refs, train SDXL style LoRA, commit training config |
| T-0073 | Descent chain: box downscale -> palette quantize (Oklab, **dithering off**) -> cleanup. BiRefNet cutout for props. Quantizer blocked on V-5 |
| T-0074 | Sprite-sheet packer -> Godot `.tres` atlas. **CI build step, not committed** — deterministic layout; assert output stays PIL mode `P` |
| T-0075 | `ASSET_PROVENANCE.md` auto-writer (model/license/prompt/seed) |
| T-0076 | Kanban `agent: assets` cards drive generation end-to-end |

**Guardrail:** the asset agent must **refuse** to run a workflow whose checkpoint isn't on the approved-license list. Encode as a hook, not a convention.

---

## Phase 7 — Audio Pipeline

| Task | Description |
|---|---|
| T-0080 | ACE-Step 1.5 local install, VRAM baseline |
| T-0081 | Stable Audio Open for **SFX textures only** (vocalizations, room events, drones); register with Stability if revenue model changes |
| T-0082 | `AudioAgent` mirroring `AssetAgent` iface (same base class — DRY) |
| T-0083 | Trim/DC-offset -> **loop-fold** -> loudness normalize (EBU R128) -> encode -> **validate the encoded file** + Godot import presets |
| T-0084 | Provenance logging shared with T-0075 |

---

## Phase 8 — Vertical Slice

One zone, playable loop, notes visible, one tear, one item-granting puzzle, music + SFX, CI-built client artifact downloadable from a GH release.

---

## Environment Notes (dev machine)

**WSL / Rancher Desktop**
- Dev distro: separate Ubuntu. **Not** `rancher-desktop` (appliance; wiped on factory reset).
- Enable that distro under Rancher -> **WSL Integration** for socket access.
- Runtime: prefer **dockerd (moby)** over containerd -> `docker compose` works verbatim.
- Repo location: **inside the WSL ext4 filesystem** (`~/dev/...`), not `/mnt/c/`. The 9P bridge costs ~9-40x on I/O and degrades agent file search.
- Consequence: Windows-side Godot editor and WSL-side server work on *different checkouts*. Options: (a) two clones synced via git, (b) client on Windows / server in WSL as separate repos. **Decide before Phase 4** — see open questions.
- One Postgres per host on `5432` (mirrored networking shares the host namespace).

**Claude Code**
- Native Windows install (no WSL needed for the client side).
- Install Git for Windows so the Bash tool is available.
- Verify: `claude doctor`.

---

## Open Questions (need @owner)

**Resolved**
- ~~Monorepo vs split~~ -> monorepo, two clones (Windows + WSL), git as sync. *2026-07-31*
- ~~Branching model~~ -> git-flow + `art/*`. *2026-07-31*
- ~~GDD timing~~ -> after Phases 0-2 land; local Claude then drafts the backlog, @DennieSeth promotes cards to TODO. *2026-07-31*

- ~~**Game genre/loop**~~ -> `docs/design/01-vision.md`, v6 locked. *2026-08-01*
- ~~**Zone coordinate space**~~ -> **discrete, permanently**. Notes and items bind to `(archetype_id, anchor_tag)`. No geometry, no GiST, no radius query. *2026-08-01*
- ~~**Art direction**~~ -> pixel art, abandoned Soviet constructivism/brutalism. Images take **plain git, no LFS**. *2026-08-01*
- ~~**Target resolution / aspect**~~ -> **384×216**, 16:9, integer-scaled, **16px tiles**, rooms authored 24×14. *2026-08-01 / 08-02*

**Open**

None at plan level. Remaining decisions are design-side and tracked in `docs/GDD-OPEN.md`; the only one blocking active work is **V-5** (palette hex set), which gates the quantizer in T-0073 and nothing else.

**Pending application:** `docs/HANDOFF.md` §3–§5 deltas are reflected in this file, but the corresponding `tasks/*.md` cards and the new tasks T-0090–T-0103 still need creating.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-07-31 | Initial plan | Claude (Opus 5) |
| 2026-07-31 | v2: monorepo confirmed, git-flow + `art/*` branching, binary/LFS policy, card<->git mapping, open questions triaged | Claude (Opus 5), rev. @DennieSeth |
| 2026-08-01 | v3: secret drops cut (A-III) — `secret_drops`/`drop_grants` tables, `/v1/roll`, T-0048 removed; Phase 8 slice swaps secret drop for tear + puzzle reward | Claude, rev. @DennieSeth |
| 2026-08-02 | v4: HANDOFF §3 deltas applied — anchor-tag schema replaces coordinates, radius queries removed, seed-phrase identity, Linux CI, LFS resolved, Phase 6/7 pipeline tasks updated; all four open questions closed | Claude, rev. pending |
