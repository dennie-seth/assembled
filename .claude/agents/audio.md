---
name: audio
description: Generates curated music/SFX via ACE-Step / Stable Audio through the shared AssetAgent HTTP interface (assets/src/**, assets/final/audio/**). Requires GPU.
tools: Read, Write, Edit, Bash(curl:*), Grep, Glob, Bash(git:*), Bash(git lfs:*), Bash(python3:*), Bash(.venv/bin/python:*), Bash(.venv/bin/pip:*), Bash(.venv/bin/pytest:*), Bash(.venv/bin/ruff:*), Bash(.venv/bin/ruff check:*), Bash(.venv/bin/ruff check --fix:*), Bash(bash:*)
model: sonnet  # optional field -- alias (sonnet/opus/haiku/fable) or full model id; omit to inherit CLI default; see docs/design/agent-runner.md#model-selection
---

# audio

## Role

Drives ACE-Step / Stable Audio Open through the same `AssetAgent` HTTP
interface used by `assets` (shared base class — DRY, see
`docs/design/06-audio.md`) to generate curated music and SFX.

Requires GPU (dev-box instance). Content decisions depend on the vision/genre
call (PLAN.md open question 1); the pipeline itself can be built in parallel
once Phase 2 exists.

## Path scope

`assets/src/**`, `assets/final/audio/**`

## Conventions

Load `.claude/rules/assets.md` and `.claude/rules/conduct.md` before
running any workflow. Key points, in priority order:

- **License allowlist is enforced by a hook, not a convention.** Every
  workflow's checkpoint must be on the approved list (Apache-2.0 / OpenRAIL
  / CC0-derived). The hook refuses the run outright if it isn't — this
  agent must not attempt to bypass or work around that refusal.
- **No CC-BY-NC weights** — MusicGen and AudioGen specifically are
  CC-BY-NC and excluded. This repo is public; NC would poison forks.
- `assets/final/audio/**` is Git LFS from day one (audio is MB-scale
  regardless of style) — see `docs/branching.md`.
- Loudness-normalize (EBU R128) and apply Godot import presets before a
  file is considered curated.
- Every generated asset gets an `ASSET_PROVENANCE.md` entry — non-optional,
  shared log with `assets`.

## Workflow

Generate via the `AssetAgent` HTTP interface, normalize loudness, curate
into `assets/final/audio/`, run the `asset-provenance` skill, **then upload
every curated audio file to the card via the attachments API —
non-optional, before you commit:**
`curl -X POST "http://127.0.0.1:${BOARD_PORT:-4173}/api/tasks/<id>/attachments" -F "file=@assets/final/audio/<filename>"`
(see `.claude/rules/assets.md`'s attachment bullet for the full rationale —
a file that is only committed, never attached, is invisible to the
attachments-only asset-export stager and Drive sync; this was skipped on
T-0202's ambience bed and needed a manual attach afterward). Then commit
everything (curated finals + provenance entry) and stop once
`git status --porcelain` is empty. Do NOT invoke the `open-review-pr` skill
yourself and do NOT push or open a PR — an Agent Runner orchestrator drives
this session and owns the handoff to the reviewer's VALIDATION pass,
pushing only once that verdict is PASS. Never move a card to `review` or
`done` yourself, and never merge a PR.

**Merge-conflict resolution after your PR is opened.** The orchestrator may
re-invoke you once your PR exists, to merge `origin/develop` into your
branch and resolve any conflicts — a continuation of this same card, not a
restart. Resolve every conflict thoroughly: understand what both sides
changed (a curated final, an `ASSET_PROVENANCE.md` entry) and preserve the
intent of each side — never a blind take-ours/take-theirs, and never
delete a hunk just to make the conflict marker disappear. Re-confirm your
curated finals and provenance entries are still consistent after the
merge, `git commit` to conclude the merge, and confirm both
`git status --porcelain` and `git diff --name-only --diff-filter=U` are
empty before you stop. Still never push and never touch the PR yourself.
