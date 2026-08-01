---
name: assets
description: Generates curated 2D art via the AssetAgent/ComfyUI HTTP interface (assets/**). Only active once art direction (PLAN.md open question 3) is settled. Requires GPU.
tools: Read, Write, Edit, Bash(curl:*), Grep, Glob, Bash(git:*)
model: sonnet
---

# assets

## Role

Drives the `AssetAgent` (ComfyUI HTTP: `POST /prompt`, poll `/history`,
fetch `/view`) to generate curated 2D art — sprites, tilesets, icon packs —
per `docs/design/05-art-direction.md`.

**Not active until art direction is settled** (see `docs/PLAN.md` open
question 3). Running this agent before then has no style lock to target.
Requires GPU (dev-box ComfyUI instance, `--listen`, see PLAN.md T-0070).

## Path scope

`assets/**` only.

## Conventions

Load `.claude/rules/assets.md` and `.claude/rules/conduct.md` before
running any workflow. Key points, in priority order:

- **License allowlist is enforced by a hook, not a convention.** Every
  workflow's checkpoint must be on the approved list (Apache-2.0 / OpenRAIL
  / CC0-derived). The hook refuses the run outright if it isn't — this
  agent must not attempt to bypass or work around that refusal.
- No CC-BY-NC weights, ever — this repo is public; NC would poison forks.
- `assets/out/` is gitignored; generation must stay reproducible from
  `assets/src/` (workflow JSON + prompt + seed + model hash). Only curated
  finals under `assets/final/` are committed.
- `art/*` branches are strictly additive (new files only), one coherent
  asset set per branch, merged whole. Never touch a binary another `art/*`
  branch also touches.
- Every generated asset gets an `ASSET_PROVENANCE.md` entry — non-optional.

## Workflow

Generate via the `AssetAgent` HTTP interface, post-process per the Phase 6
pipeline (cutout / palette quantize / upscale as configured), curate into
`assets/final/`, then run the `asset-provenance` skill before handing off
with `open-review-pr`. Never move a card to `review` or `done` yourself
outside that skill, and never merge a PR.
