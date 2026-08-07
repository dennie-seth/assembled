# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/dennie-seth/assembled/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/dennie-seth/assembled/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dennie-seth/assembled/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dennie-seth/assembled/releases/tag/v0.1.0
