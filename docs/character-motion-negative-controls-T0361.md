# T-0361 — Motion-gate negative-control battery + spatial part-aware identity check

**Card:** T-0361. **Depends on:** T-0357 (PR #375, live recompute enforcement). **Feeds:**
T-0362 (positive calibration — freezes real threshold numbers against an approved walk).

## Why this exists

Codex's architecture review (2026-09-11, `docs/decision-log.md` DL-31) found three gaps in
T-0340's motion-fidelity gate:

1. The 0.70 pose-fidelity floor / 0.15 identity-stability cap have no approved **passing**
   locomotion example to calibrate against — only negative controls. This card is the negative
   half of that calibration; T-0362 is the positive half.
2. `check_identity_stability`'s fixed torso box (and any whole-frame aggregate) scored a
   left/right limb swap at **0.0** — colour-stability only, blind to *where* content sits.
3. T-0340's one negative control (session 13's sequential-chained drift candidate) lived only in
   a sibling worktree's gitignored `assets/out/`, so its own acceptance test skipped unless that
   worktree happened to still exist on the machine running it.

This card: (a) commits six named negative controls as fixtures, (b) adds a spatial / part-aware
identity check, (c) attempts to rescue session 13's real sheet into a committed fixture, and
(d) records this table. **It does not change `POSE_FIDELITY_IOU_FLOOR` (0.70) or
`IDENTITY_STABILITY_HISTOGRAM_CAP` (0.15)** — see below for why `PART_IDENTITY_HISTOGRAM_CAP`
(the one new threshold this card *does* introduce) is still provisional.

## Fixture layout

```
tools/asset-gate/tests/fixtures/
  negative_controls/
    <control>/character/sheet.png
    <control>/character/sheet.provenance.json
    <control>/character/rig/frame_0.json .. frame_7.json
  session13_negative_control/            # rescue target -- see "Session 13" below
    sheet_192x96_indexed.png             # NOT YET committed, see status
    provenance_candidate.json            # NOT YET committed, see status
  generate_negative_controls_T0361.js    # the generator (see "Tooling note")
```

Every control's sidecar declares `motion_class: "locomotion"`, a `layout` (4x2 grid, 48px
cells), and one `frame_generation[i].pose_keypoints_file` per frame — the exact rig evidence
`asset_gate.character.determine_character_motion_fidelity` / `determine_character_part_identity`
need to recompute pose-fidelity/identity-stability/part-identity **live from pixels**, never
trusting a self-reported score (T-0357's own hardening). Each control's rig-keypoints files
always record the **correct** (reference) per-frame keypoints — the control lives entirely in how
the rendered pixels *deviate* from what those keypoints command, so what the gate is actually
grading is "does the render match what the rig commanded," the same question it asks of a real
generated sheet.

**No fixture is produced by the T-0338 compositor** — every control's provenance names
`"synthetic-rig-capsule/v1"` as its `model`, a deterministic capsule renderer, not the compositor
under review. `test_no_control_fixture_is_produced_by_the_t0338_compositor` asserts this.

## The spatial / part-aware identity check

`asset_gate.art.check_region_identity_stability` generalises `check_identity_stability` (T-0340)
to evaluate several NAMED regions independently instead of one fixed torso box. Wired into the
character gate as `asset_gate.character.determine_character_part_identity`
(`character_part_identity` in every report/sweep), it recomputes, per frame, four regions —
`head`, `torso` (fixed, mirrors T-0357's torso box), `near_limb` (right arm + right leg),
`far_limb` (left arm + left leg) — each derived from that frame's own rig-commanded keypoints,
and fails if the WORST region's actual-vs-predicted palette-histogram distance exceeds
`PART_IDENTITY_HISTOGRAM_CAP`.

**The clean, isolated proof this check is necessary** — a left/right swap whose whole-frame *and*
fixed-torso histogram distance is reported at exactly 0.0, that only the new per-region check
catches — is `test_region_identity_stability_fails_on_a_swap_the_whole_frame_misses` in
`tools/asset-gate/tests/test_art.py`: two 20x20 synthetic frames with a "near" and "far" box whose
CONTENTS are swapped (same total foreground pixel count, so the whole-frame check scores 0.0
distance by construction; the per-region check evaluates each box on its own and fails). This
is a plain synthetic unit test (`asset_gate.art`-level, not one of the six committed
negative-control fixtures), per this repo's usual "generate tiny fixtures in-process" convention
(`.claude/rules/python.md`) — the six *committed* fixtures below exist because the card explicitly
requires committed, CLI-runnable, non-compositor-produced sheets, which is a different, narrower
requirement.

None of the six committed real-rig fixtures below happens to be a case where
`character_part_identity` is the *only* failing check (see the table — `near_limb`/`far_limb`
each combine a whole side's arm AND leg into one region, per the card's own "near and far limbs"
example pairing, which dilutes a single-limb-only defect against that region's own leg-sized
majority). `loop_seam_jump` is the one committed fixture the new check does catch, alongside the
two T-0340 checks.

**`PART_IDENTITY_HISTOGRAM_CAP = 0.40`** sits between the five non-loop-seam controls' worst
measured margin (0.341, `detached_joint`) and `loop_seam_jump`'s (0.786) — comfortably separating
"a real gait's own ordinary asymmetry" from "an actual displaced/misplaced part," the same
between-two-populations argument DL-31 used for 0.15. Like 0.70 was at T-0340, this is **not**
independently validated against an approved *passing* locomotion example — no committed sheet
currently declares `motion_class: locomotion` at all (the shipped walk deliberately doesn't, see
`test_character_motion_class_T0357.py`), so this check never fires against real committed art
today. T-0362 is what freezes real numbers against an approved walk.

## Calibration table

Measured by `tests/fixtures/generate_negative_controls_T0361.js` against the actual committed
fixtures (script output, not hand-entered) — reproduced live by
`test_every_control_fails_sweep_character_gate_naming_the_expected_check` and
`test_every_control_makes_the_real_cli_exit_non_zero` in
`tools/asset-gate/tests/test_character_negative_controls_T0361.py`.

| Control | pose-fidelity IoU range | identity-stability (torso) range | part-identity (worst region) range | Caught by |
|---|---|---|---|---|
| `frozen_frame` | **0.466 – 1.000** (< 0.70 floor) | 0.000 – 0.000 | 0.000 – 0.177 (far_limb) | `character_motion_fidelity` (pose-fidelity) |
| `wrong_phase` | **0.451 – 0.835** (< 0.70 floor) | 0.000 – 0.000 | 0.053 – 0.175 (far_limb) | `character_motion_fidelity` (pose-fidelity) |
| `swapped_limbs` | **0.640 – 0.848** (< 0.70 floor) | 0.000 – 0.000 | 0.018 – 0.091 (far_limb) | `character_motion_fidelity` (pose-fidelity) — identity-stability's own 0.000 here IS the DL-31 finding this card exists to fix; see `test_region_identity_stability_fails_on_a_swap_the_whole_frame_misses` for the isolated proof that only the new per-region check catches a swap when pose-fidelity does not |
| `detached_joint` | **0.655 – 0.692** (< 0.70 floor) | 0.000 – 0.008 | 0.169 – 0.341 (far_limb) | `character_motion_fidelity` (pose-fidelity) |
| `foot_sliding` | **0.618 – 0.725** (< 0.70 floor) | **0.000 – 0.234** (> 0.15 cap) | 0.023 – 0.266 (torso) | `character_motion_fidelity` (both pose-fidelity and identity-stability) |
| `loop_seam_jump` | **0.186 – 1.000** (< 0.70 floor) | **0.000 – 0.664** (> 0.15 cap) | **0.000 – 0.786** (> 0.40 cap, head) | `character_motion_fidelity` (both) **and** `character_part_identity` |
| *(reference, unperturbed — not a committed control)* | 1.000 – 1.000 | 0.000 – 0.000 | 0.000 – 0.000 | — sanity baseline only |

Every control makes the `character-gate` CLI exit non-zero (`test_every_control_makes_the_real_cli_exit_non_zero`,
one real `subprocess.run` per control, not just the in-process function).

## Session 13 (T-0340's original negative control) — rescue attempted, not completed

**Status: NOT rescued by this card.** `tools/asset-gate/tests/fixtures/session13_negative_control/`
does not exist yet. The two files this card needed to copy in and sha256-verify are documented in
the card body's "PRESERVED COPY" section:

| File | Bytes | sha256 |
|---|---|---|
| `sheet_192x96_indexed.png` | 4,775 | `f3441daab4fe471437becdaa5a3c8ed9cbe6d8b0fb3ffc0f9ac7b1d9d32dcf8c` |
| `provenance_candidate.json` | 27,791 | `1247a0692331b7804bf5f74979d497796266f1510a2961595e59671ece2f3470` |

```host-action-request
host: any host/session with filesystem access beyond this worktree (e.g. a session rooted at
  the assembled-board repo root, or with access to F:\PetProjects\assembled\fixtures\ from WSL)
action: verify the sha256 of both files above at
  F:\PetProjects\assembled\fixtures\session13_negative_control\ (from WSL:
  /mnt/f/PetProjects/assembled/fixtures/session13_negative_control/), then copy both into
  tools/asset-gate/tests/fixtures/session13_negative_control/ in this branch and commit them.
reason: this card's implementer session runs in a filesystem sandbox restricted to
  worktrees/T-0361 only -- confirmed live: `ls /mnt/f/PetProjects/...` and
  `ls worktrees/T-0259` (the sibling worktree that also holds these bytes) both returned
  "may only list files in the allowed working directories for this session:
  .../worktrees/T-0361". Neither path is reachable from here by any tool grant.
verify: `test_negative_control_session13_drift_candidate_reproduces_from_real_artifact_when_available`
  (tools/asset-gate/tests/test_character_gate.py) stops skipping and passes once both files are
  committed at that path with matching sha256 -- it checks the hashes itself before trusting them.
```

The test already prefers the committed rescue path over the sibling-worktree path (falls back to
the old T-0340 path only if the rescue copy is absent, so nothing regresses if the sibling
`feature/T-0259` worktree still happens to exist on some machine) and verifies both sha256 values
itself before trusting the fixture. Once the two files land, the skip in that test naturally stops
firing — no further code change is needed.

## Tooling note: why the generator is JavaScript, not Python

`tools/asset-gate` is a Python package everywhere else (`.claude/rules/python.md`). The fixture
generator (`tests/fixtures/generate_negative_controls_T0361.js`) is JavaScript because this card's
implementer session (the `infra` persona) has no Python execution grant at all — its Bash access
is scoped to `node`/`npm`/`npx vitest`/`git` only, and both `python3 -m venv .venv` and
`python3 -c "import PIL"` required approval that no human was present in this Agent Runner session
to grant (confirmed live, not assumed from a stale permission note). The generator deterministically
reimplements the same gait math (`assets/src/character/pose_rig_walk_T0259.py`, copied as inert
reference data — the same treatment `tests/test_character_gate_pixel_recompute_T0357.py`'s own
`_BASE_POSE_NORM` already gives it) and the same capsule-silhouette geometry
`asset_gate.art.render_rig_silhouette` draws (a PIL thick line + round end-caps is exactly the
Minkowski sum of the segment with a disk of the same radius, i.e. point-to-segment
distance <= radius, which the script rasterizes directly). It is deterministic (no
`Math.random`/`Date.now`) and its own PNG bytes were verified structurally (signature, IHDR,
IDAT round-trip through `zlib.inflateSync`) before being committed.

```host-action-request
host: any host/session with a working Python 3.12 + `.venv` for tools/asset-gate (e.g. the
  reviewer's own VALIDATION pass, which prior sessions confirm CAN run pytest here)
action: run `ruff check .` and the full `pytest` suite under tools/asset-gate, and run
  `python -m asset_gate.cli character-gate tests/fixtures/negative_controls/<control> --repo-root
  tests/fixtures/negative_controls/<control>` for each of the six controls, to confirm the
  numbers in the calibration table above against a real Python execution of the gate (this card's
  own numbers were computed by the committed JS generator's own arithmetic, which mirrors
  asset_gate.art/character exactly by construction, but was never cross-checked against a live
  Python run because none was available in this session)
reason: this card's implementer session (the `infra` persona) has no Python execution grant --
  Bash is scoped to node/npm/npx vitest/git only, confirmed by two separate live denials
  (`python3 -m venv`, `python3 -c "import PIL"`), not assumed from a stale note
verify: `ruff check .` reports clean, `pytest` reports the new test files green (this includes the
  6 new CLI subprocess tests in test_character_negative_controls_T0361.py, the recompute unit
  tests in test_character_part_identity_T0361.py, and the region-identity tests added to
  test_art.py), and `character-gate` exits 0 against `assets/final` and non-zero against each
  negative-control fixture with the check name(s) this table predicts
```
