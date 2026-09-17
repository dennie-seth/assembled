# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-09-17

Usage-aware launching and a two-tier character pipeline: 187 pull requests (#200-#391) since
v0.6.0. The WIP token gate lands end to end in advisory mode -- verified 5-hour and weekly usage
telemetry with an idempotent usage ledger, Fibonacci complexity scoring, a coverage-calibrated
cost estimator, and admission with reservation leases at the one launch boundary both the Run
button and the auto-launch poller share. Enforcement ships implemented, tested and **off**. The
board runner gains an auto-pull and auto-launch loop, a human direction-approval gate and a long
run of lifecycle hardening. On the game side, the Signal Tower is authored as seven rooms, with
per-token rate limiting, a vocabulary endpoint, structured logging, the note composer and the
first-run sequence. The asset pipeline moves to 1024 master sheets plus script-composited motion,
guarded by a pixel-recomputed motion gate with committed negative controls. Security: gitleaks
scanning in CI and tighter agent permission scoping.

### Features

#### WIP token gate (usage-aware admission)

- Verified usage telemetry for the 5-hour and weekly windows and an idempotent usage ledger;
  status-only readings are never treated as measured capacity (T-0367, #381).
- `complexity_points` Fibonacci field with planning surfacing, independent of execution cost
  (T-0368, #382).
- Cost estimator with coverage-target calibration, censored interrupted runs and an advisory
  decision logger that records predicted vs actual (T-0369, #383).
- Admission at the shared launch boundary: per-window capacity formula, atomic check-and-reserve
  with reservation leases and crash/startup reconciliation, separate external-burn and
  uncertainty reserves, overrun response, and durable outcome recording. Advisory by default;
  `WIP_GATE_ENFORCEMENT_ENABLED` is off (T-0370, #387).

#### Board and agent runner

- In-process auto-launch poller that starts at most one `ready` card per tick when the board is
  idle and usage is below threshold, defaulting to a 5-hour cadence; the run-start path is
  shared with `POST /api/tasks/:id/run` via `cardLaunch.js` (#275, #276). Periodic auto-pull and
  restart for an idle board (#212).
- Human direction approval is a real, enforced gate (#288) that propagates to
  `ASSET_PROVENANCE.md` (T-0286, #313); the approval ledger regenerates on every branch push and
  PR open, and staleness fails instead of warning (T-0313, #348).
- `GET /api/health` liveness probe (#290); human actions are recorded as a configured operator
  (#292); artifact attachment is enforced by the reviewer gate (#225).
- Runner guards: abort on an unchanged failure hash instead of retrying (T-0224, #245);
  capability and acceptance preflight before spawning the implementer (T-0225, #246); catch
  agent-impossible acceptance criteria before the run (T-0300, #334); per-agent phase budgets
  (#253), a 240-minute assets budget with resumable LoRA training (#256) and per-agent inactivity
  budgets (T-0309, #343).
- Board loop controls: a `NEEDS_HUMAN_DECISION` verdict halts the run (T-0341, #359);
  pre-registered finding-with-evidence counts as a PASS for artifact cards (T-0342, #363);
  validation history is archived out of card bodies and fed back as a digest (T-0345, #362);
  per-card attempt budgets (T-0343, #366); experiment rounds are capped at 2 before a human
  re-scope (T-0344, #370); generation cards must produce fresh artifacts, not merely existing
  ones (T-0354, #369).
- Host-action escalation path for issues an agent can diagnose but not fix (T-0323, #354);
  ComfyUI launch configuration enumerated and version-controlled (T-0322, #356), with the
  withdrawn determinism entry removed from the preflight registry (T-0346, #358).
- Scoped agent web search and fetch for open-source references (T-0276, #302), with 429 header
  surfacing (T-0283, #305), per-image provenance in batch summaries (T-0282, #306) and
  policy-compliant fetching under rate limits (T-0284, #312).
- Decisive visual evidence is committed to a tracked path (T-0314, #352); machine-readable gate
  reports (T-0349, #361); Playwright browser test harness for UI cards (T-0295, #330); drag
  auto-scroll for board columns (T-0288, #317).
- Documentation: run-lifecycle architecture review (#321), escalation workflow updated for the
  structured quota-stop detector (T-0378, #388), kohya `--resume` behaviour (T-0311, #346),
  DL-21 override record (T-0253, #280), DL-25 character decision (#287), DL-30 authorship rule
  (T-0335, #357), release artifact and Steam disclosure text (T-0208, #252).

#### Game client and server

- Side-on rebuild of the one-room blockout (T-0192, #200) and the seven-room Signal Tower chain
  (T-0194, #204); authored Signal Tower room geometry rendered as one scrollable scene, with the
  room-bottom boundary closed by collision (T-0328, #372).
- Run lifecycle in the client -- start, traverse, end, restart (T-0196, #206); collapse clock
  wired to chroma intensity (T-0197, #208); bleed-alpha ramp (T-0122, #377); blockout and
  full-run traversal measurements (T-0193, #203; T-0195, #207).
- Note vocabulary N-3 in EN and RU (T-0205, #226); note composer UI with dropdown selection
  (T-0065, #376); first-run sequence with an unsaved-session warning (T-0120, #378).
- Server: per-identity-token rate limiting for note routes (T-0049, #373); authenticated
  `GET /v1/vocabulary` returning the caller's unlocked word ids (T-0364, #379); structured
  logging and a bounded `/healthz` (T-0050, #374); cross-universe delivery proof (T-0206, #227)
  and proof-of-play with bleed slowdown (T-0207, #251).

#### Asset pipeline

- Two-tier character pipeline: 1024 master sheets with separated limb parts (T-0336, #365;
  regenerated in limb-separating poses, T-0351, #368), side-profile keyframe and green-costume
  reference (T-0272, #299; T-0315, #349; T-0317, #351), profile identity LoRA (T-0274, #345),
  chunked resumable multi-frame generation (T-0266, #297) and agent-sourced references (T-0273,
  #319; T-0281, #303).
- Character generation research that led there: spikes and iterations (T-0198, #202; T-0199,
  #205; T-0200, #209; T-0212, #220; T-0213, #228; T-0214, #229; T-0218, #242), the bake-off
  (T-0227, #249; T-0228, #254; T-0237, #258; T-0229, #259; T-0230, #260; T-0231, #261) and round
  2 (T-0248, #278; T-0249, #279; T-0250, #281; T-0251, #282; T-0252, #284; T-0255, #285); enemy
  redesign concept art (T-0275, #304).
- Motion gate: CHR-1 Arm-C benchmark enforcement (T-0258, #293); motion-aware frame-delta cap
  (T-0271, #300); pose-fidelity IoU plus identity-stability checks (T-0340, #364), enforced by
  one authoritative validator in CI and the reviewer route (T-0357, #375); recorded motion scores
  bound to content hashes (T-0360, #389); a committed negative-control battery and a per-part
  identity check against the sheet's own reference frame (T-0361, #391).
- Concept art: player (T-0209, #213), entities (T-0210, #215), props (T-0211, #217; v2, T-0239,
  #265; for approval, T-0257, #291) and the full Signal Tower concept set (T-0226, #247).
- Signal Tower props and tiles: prop pack (T-0201, #218), per-room packs (T-0240, #267; T-0241,
  #268; T-0242, #269; T-0243, #315; T-0244, #308; T-0245, #309; T-0246, #310), 16px value
  re-tune (T-0223, #243) and the full seven-room tileset (T-0232, #262).
- Audio: Signal Tower ambience bed (T-0202, #216), four-stage collapse layer (T-0203, #222) and a
  deterministic one-shot SFX set (T-0204, #224).
- Tooling: committed RGBA cutout generation path (T-0220, #235); `concept_hash` threading
  through `generate_cutout` (#266); sprites always ship true transparency (P-6, #289); P-7
  generator-resolvability check (T-0219, #234); concept tests gated in CI (#239).

### Fixes

#### Board and agent runner

- Run lifecycle: real heartbeat, earlier `in-progress`, runstate cleanup and work preserved on
  FAIL (#326); the orphan reaper no longer reaps a live pid or growing log (T-0289, #314), never
  writes status for a run the orchestrator owns (#322), closes its launch window (T-0296, #336)
  and only runs in the board's owning process (T-0296, #340); the inactivity watchdog accepts
  filesystem progress (T-0308, #341); clean fast shutdown propagates SIGTERM (T-0290, #320).
- Launch safety: a duplicate launch of the same card is refused (#327); non-owners cannot
  blocked-write a live card (#325); large card bodies no longer crash spawn with E2BIG after a
  successful review (T-0291, #328); the branch is pushed on any terminal outcome (T-0299, #332);
  a closed PR is treated as absent and a new one opened (T-0287, #311); worktrees are cut from
  `origin/develop`, not a frozen local ref (#241); untracked run artifacts survive worktree resets
  (#277).
- Verdicts and escalation: the board-suite verdict cross-check was unwinnable (#214);
  python-verify cross-check false negative on a persisted cwd (#219); the no-progress abort
  signature uses git state (#255); capability preflight distinguishes produced from required
  models (#257) and reads model cues by position (#270); escalation was suppressed on every card
  (#264) and dead in db mode (T-0301, #324); escalation dedupe matches by status (T-0310, #342);
  the usage-limit detector no longer treats quoted rate-limit text as a quota stop (T-0377,
  #385); `checkDeliverable --require-artifact` rejects failed-attempt evidence (T-0352, #367); asset
  export counts only committed files (T-0320, #353).
- Usage gate: early rate-limit telemetry no longer stalls the poller (#331).
- Approval provenance: the drift gate gets a data source CI can reach (#316) and no longer fails
  closed in CI (T-0292, #329); approval checks read the live board, not a stale ledger (T-0307,
  #344); ledger regenerated from the live board (#347).
- Deploy and data: `check:live-run` scoped to board dirs (#211); `BOARD_TASK_STORE`/`BOARD_DB_PATH`
  passed through to spawned CLIs (#230); auto-pull and deploy no longer create an empty merge
  commit (T-0304, #339); the test suite no longer mutates tracked task files (T-0302, #335); a
  known host issue can be withdrawn (#355).
- UI: Run is disabled on dependency-blocked cards (#244); poll-driven re-renders no longer clobber
  live interaction (#250); columns fill the viewport (#318, #337); PR bodies summarize the card
  (#273).
- Flow-health rework fixes (T-0216, #238; T-0238, #283; T-0303, #338); two timing-flaky ci-board
  tests de-flaked (#274).
- Agent grants: reviewer `checkDeliverable.js` (#201), audio agent Python (#210), assets agent
  LoRA venv Python (#223) and a runnable Python with the attempt-log rule (#294), reviewer `cd`
  into the character package (#296), assets `cd` into `tools/asset-gate` (#298), scoped
  `referenceFetch` wrapper (#301), and character-package routing in python-verify (T-0264, #295).

#### Game client and server

- Game boot: duplicate `class_name` declarations removed, with a main-scene compile smoke test
  (T-0366, #380).

#### Assets and provenance

- `model_hash` null-refuse enforcement and regeneration of flagged assets (#221; T-0215, #231);
  procedural vs real provenance verified (T-0217, #232); entity-v2 generator fields remediated
  for P-7 (T-0222, #236); the last baseline-exempt concept sheet resolved (T-0236, #286); reference
  sidecars emit `model_hash` and generator at fetch time (T-0297, #333); existing approval
  propagated into `ASSET_PROVENANCE.md` (#307).
- Final PNGs that are fully transparent or blank are rejected (#233); comfy-client provenance goes
  through a validating writer (#248); the Signal Tower prop pack was regenerated via the committed
  cutout recipe (T-0221, #237).
- Walk frames render on true black (T-0319, #350); IP-Adapter references no longer get border
  background forced (T-0347, #360).
- Character package test hygiene: tests no longer write into `assets/final`, the package runs
  from a clean install in CI, and only well-formed Git LFS pointers are skipped (T-0363, #390).

### Security

- Gitleaks secret scanning in CI with a reviewed false-positive ignore list (#386).
- Agents' blanket `curl` grant replaced by a board-API-scoped HTTP wrapper, so agents cannot
  mutate the board API (#240).
- The tool allowlist is path-aware for `.claude/**`: Edit/Write are denied there, matching what
  the Claude Code CLI actually allows (T-0376, #384).

## [0.6.0] - 2026-08-18

Side-on rebuild & broadcast systems: the room/movement/sensor stack is rebuilt for the side-on
camera per the updated design (§11 v5) — floor-anchored plane runtime, a no-jump vertical player
controller, a side-on sensor kit with horizontal-occlusion cover, and floor-anchored hiding spots
replace their top-down predecessors. On the server, broadcast petitions and an append-only unique
custody log land the remaining core economy/notes systems. The client also gains a build-time
localization gate (`LocId` type-split wrapper plus L-1..L-4 checks) that turns a missed
translation into a compile error instead of a raw id on screen. Board reliability work continues:
the agent-run stdin-hang bug is hardened against, and auto-opened PRs retry with a REST fallback
on transient GitHub failures.

### Added

- Broadcast petitions: `POST`/`GET /v1/petitions`, enforcing INV-8 reachability with a
  per-player rate limit and an optional gating-item slot (T-0117).
- Unique custody log: append-only `unique_custody_log` table plus `UniqueCustodyLog`
  read/write path, replacing in-place custody updates for unique items per the
  copy-on-write server-ops model (T-0118).
- `LocId` wrapper and the `locale-gate` build-check tool (L-1..L-4): a POD-integer id type with
  no `to_string()`, so an unresolved localization key fails the build instead of shipping
  (T-0119).

### Changed

- Room/tile runtime, player controller, sensor kit, and hiding spots rebuilt for the side-on
  camera (§11 v5), replacing the top-down versions: floor-anchored plane runtime (T-0187,
  replaces T-0172), no-jump vertical player controller (T-0188, replaces T-0173),
  horizontal-occlusion sight/sound sensor kit (T-0189, replaces T-0174), and floor-anchored
  hiding spots with cover-break (T-0190, replaces T-0175).
- Decision log DL-17: Climax rooms are independent of chain-key tier, closing DL-16.

### Fixed

- Agent runs are hardened against the stdin-hang bug in the board runner (T-0117).
- Auto-opened PRs now retry with a REST fallback when GitHub's GraphQL API fails
  transiently, instead of failing the run outright.

## [0.5.0] - 2026-08-17

Signal Tower & board hardening: the biggest content and reliability release yet. On the game
side, the §16 blockout stands up an anchor-bound room/tile runtime, the sensor/hiding/interaction
systems (sight cones, sound radius, cover-break, item-locked doors, levers, ladders, tear
crossings), room-role authoring metadata, and the Chroma palette-swap shader — capped by the
seven-room, three-entity Signal Tower chain and the one-room blockout that proved it out. On the
board/runner side, the agent harness gains several defense-in-depth layers: cards that exhaust 5
auto-retries now escalate to a dispatch remediation card instead of stalling silently; a
hung-child/Godot phase timeout plus wedged-pid reaper closes the last hang class; a harness-side
verdict cross-check stops the reviewer's self-reported PASS from being trusted blindly; and two
separate crash-guard fixes (TaskWatcher's unlistened `error` throws, and a `spawn claude ENOENT`
case) are now backed by a global `uncaughtException`/`unhandledRejection` net so one bad run can
no longer take the whole board process down. `generic` is now a validated, defaulted board agent,
and every auto-opened PR branch auto-merges `develop` before landing. Release automation is new: a
GitHub Actions workflow builds and publishes tagged Windows/Linux/server zips to GitHub Releases,
plus a rolling `latest` pre-release rebuilt on every `develop` push.

### Added

- Signal Tower chain: seven rooms, three entities, Chroma palette-swap shader (§16-b, T-0185);
  one-room blockout proof — Watcher, hiding, item-locked door (§16-a, T-0184).
- Room/tile runtime: scene + tilemap runtime, anchor runtime binding anchor tags to positions and
  rendering room-entry snapshots, and a side-on player controller with 4 animation states
  (T-0172, T-0176, T-0173).
- Sensor and stealth kit: sight-cone/sound-radius/proximity/patrol sensors, cover-break and
  dedicated hiding spots, hazard sensor-category slots rolled per-universe (T-0174, T-0175,
  T-0182); three slice entities — Watcher, Sound, Still Air (T-0178).
- Room interaction vocabulary: item pick-up/leave against the anchor snapshot, item-locked and
  switch-locked doors, levers, ladders, and tear crossings (chain + pocket) (T-0177, T-0179,
  T-0180).
- Room-type authoring metadata (Climax/Tear tags, Gate/Hazard/Transit roles), debug/seeded
  item-grant command for dev+test builds, and unlock persistence (T-0181, T-0171, T-0127).
- Note rating (one vote per player); offline/degraded client mode that stays runnable, not
  completable (T-0047, T-0067).
- Escrow atomic pay-and-release (INV-4); build-time anchor-tag validation (INV-12); audio bus
  split (D-20); sprite-sheet packer to Godot `.tres` atlas as a CI build step; loudness
  normalization (EBU R128) + loop-fold + Godot import presets (T-0097, T-0092, T-0103, T-0074,
  T-0083); economy-sim exit-condition model and INV-14 remeasurement (T-0130, T-0133).
- `ASSET_PROVENANCE.md` auto-writer, with assets/audio granted `ruff` and a tightened reviewer
  pre-existing-lint check (T-0075).
- `generic` promoted to a validated, defaulted board agent — never null (#182).
- Blocked-5x auto-retry exhaustion now escalates to a dispatch remediation card with `depends_on`
  wiring back to the blocked card (#158).
- Every auto-opened PR branch now auto-merges `origin/develop` after opening; conflicts are handed
  to the owning agent rather than auto-resolved (#173).
- Harness-side reviewer verdict cross-check: re-verifies the reviewer's self-reported PASS against
  actual test exit codes, fail-closed (#186).
- GitHub Actions release automation: `release.yml` builds and publishes Windows/Linux/server zip
  artifacts to GitHub Releases on every `v*` tag push, reusing the CI workflows' build steps via
  `workflow_call` with zero duplication (#179); a companion rolling `latest` pre-release rebuilds
  on every `develop` push (#185).

### Fixed

- Hung-child/Godot run phases now time out, and the orphan reaper cross-checks wedged pids
  (including active-card runs) instead of hanging indefinitely (#183).
- TaskWatcher no longer crashes the board process on an unlistened `error` throw (#184); a `spawn
  claude ENOENT` case from a missing CLI wrapper is likewise guarded, and both are now backed by a
  global `uncaughtException`/`unhandledRejection` net (#187).

### Changed

- Rework-rate investigation distinguishing genuine defects from underspecified cards, feeding back
  into planner card-authoring quality (§16-c, #176, #180).
- Dropped a stale image-LFS `DEFERRED` note from `.gitattributes` (#149).

## [0.4.0] - 2026-08-13

Notes & multiplayer economy: the social notes feature (server + Postgres store +
GDExtension client) lands end to end, alongside the core multiplayer-economy
invariants (session leases, custody-transfer CAS, sweep worker, transfer receipts,
spontaneous item spawner). The Windows/Godot client gets native async HTTP
(vendored libcurl) and seed-phrase persistence. The LoRA style-training pipeline
is now fully WSL-native, auto-deploys trained weights to ComfyUI, is hardened
against fallback-copy fakery, and lands its first trained model
(`soviet_brutalism_style_v1`) via Git LFS. A wave of board reliability fixes
(dependency-status dots, side-panel layout, live-edit clobbering, card dedup)
round out the release.

### Added

- Notes feature: `NoteRepo` + Postgres implementation, `POST`/`GET /v1/notes`
  (tag equality + ranking), GDExtension `NoteClient` (post/fetch/rate), and
  template-based note rendering (T-0044–T-0046, T-0063–T-0064).
- Multiplayer economy invariants: session leases with heartbeat/TTL/evict-on-takeover
  (INV-11), custody transfer as CAS on item version (INV-2), a sweep worker,
  transfer receipts, a spontaneous item spawner with rarity caps, and a
  two-player economy integration test (INV-1/2/3) (T-0093, T-0095, T-0123–T-0126,
  T-0128, T-0096).
- Windows/Godot client: vendored libcurl with async multi-handle networking
  pumped from `_process`, and client-side seed-phrase persistence (T-0062, T-0066).
- Room-entry snapshot endpoint and run assembler (T-0123, T-0124).
- Transition tile sheet generation with seamlessness + adjacency-gate proof (T-0153).
- LoRA style pipeline: fully WSL-native kohya training stack, auto-deploy of
  trained weights to ComfyUI, handshake gate hardened against fallback-copy
  fakery, and the first trained model landed via Git LFS (T-0072, T-0167).
- Card run-failures now surface on the board instead of dying silently in the
  log (T-0165); new board invariants doc covering the pull-on-done db-mode
  regression and dependency-dot coverage gaps.
- Planner authors and self-verifies Edge cases in Acceptance Criteria.
- Reviewer granted `godot`/`scons`/`gh` so it can build and run client
  GDExtension tests.
- Ops: board asset pipeline + integrity checker brought under version control;
  scheduled daily DB backup with retention, now also copied off-machine to Drive.

### Fixed

- Dependency-status dots no longer show both red and green on the same card,
  and badges are verified to never go stale across cards.
- Card delete now cleans up its on-disk attachment directory.
- Side panel reflows the board instead of covering columns; new cards no
  longer render doubled until refresh.
- Live board re-renders no longer clobber unsaved detail-panel edits.
- Planner prompt now includes card comments.

### Changed

- Untracked compiled build output (`server/build2/`).
- Reconciled GDD/design docs and decision log (DL-2…DL-14) from Notion into
  git as the canonical source.
- Card corrections and reconciliation: T-0073/T-0154/T-0169 retitle, T-0152
  home-palette reconciliation, T-0155 key-art card of record, T-0156 chain-key
  sweep fold-in, T-0151 asset-provenance `model_hash`, T-0157 INV-9 wording.

## [0.3.0] - 2026-08-07

Cards out of git, into a database: card state now lives in SQLite instead of git-tracked
markdown. Refreshing the board, editing a card, or moving one to Done no longer touches git,
eliminating the merge-to-refresh / push-on-every-edit coupling and the outages it caused
(#94 design, #95 Phase 1 additive SQLite store + importer + audit + backups, #96 Phase 2
runtime cutover). Additive and reversible behind the `BOARD_TASK_STORE` env flag; the
filesystem store remains the fallback. Now live in production.

### Added

- Card comments (#59) and attachments with upload/download/remove (#68, #77).
- Reviewer gate now verifies acceptance criteria, not just green tests (#75).
- Planner does an acceptance-criteria completeness self-check (#89).
- Bounded auto-retry loop for failed runs (#74).
- Deploy hardening: stop-before-merge deploy script + auto-push-on-commit (#79).
- Auto-restart-on-pull for the board service (#47).
- Weekly-cadence self-improvement loop proposing infra-fix cards from flow metrics (#82, #93).

### Changed

- Re-run now preserves prior work on a card's branch instead of wiping or blocking it (#68).

### Fixed

- Orphan-reaper liveness: startup/periodic reaper no longer resets live runs, only truly
  stranded ones (#64, #78).
- Card writes that weren't being committed, blocking downstream pulls (#88, #92).
- Comment draft input no longer erased by live board updates (#81).

## [0.2.0] - 2026-08-04

High-level summary derived from commit history; see `git log v0.1.0..v0.2.0` for detail.

### Added

- Generation-client agents: ComfyUI, Stable Audio Open, and ACE-Step integrations for
  image/audio asset generation, behind a shared `gen-client-base` license-allowlist ABC.
- Concept-art and material-descent pipelines (T-0104/T-0105/T-0106), palette extraction,
  and an end-to-end asset pipeline proof (Signal Tower).
- SFX synthesis pipeline and asset/audio validation gate (T-0101, T-0102).
- Planner agent with a diff guard and backlog validator gating planner-authored changes.
- Board UX: dependency picker, blocker badges, per-column sort, live run-status updates,
  clickable backlog export, auto-open PR on reviewer PASS.
- Economy simulation harness (T-0099).

### Fixed

- Stale worktree/branch collisions auto-heal instead of blocking a run.
- Card-detail panel no longer overlapped by the terminal panel; delete confirmation no
  longer shown by default.
- Create-task form no longer wiped by refresh events.

## [0.1.0] - 2026-08-02

The dev platform: initial release.

### Added

- Repository foundation: license, `.gitignore`, `.gitattributes`, `.editorconfig`,
  `.clang-format`, path-scoped `.claude/rules`, design docs, and branching conventions.
- Board core: task markdown parser/serializer, gap-tolerant `T-NNNN` id allocator,
  filesystem-backed `TaskStore`, REST API for tasks, and live WebSocket board updates.
- Board UI: Kanban board with drag-and-drop status changes and a card detail view with
  markdown rendering and inline edit.

[Unreleased]: https://github.com/dennie-seth/assembled/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/dennie-seth/assembled/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dennie-seth/assembled/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dennie-seth/assembled/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dennie-seth/assembled/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dennie-seth/assembled/releases/tag/v0.1.0
