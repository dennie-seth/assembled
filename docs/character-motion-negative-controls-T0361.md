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
  session13_negative_control/            # rescued -- see "Session 13" below
    sheet_192x96_indexed.png             # committed, sha256-verified
    provenance_candidate.json            # committed, sha256-verified
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
measured margin (0.375, `detached_joint`) and `loop_seam_jump`'s (0.800) — comfortably separating
"a real gait's own ordinary asymmetry" from "an actual displaced/misplaced part," the same
between-two-populations argument DL-31 used for 0.15. That 0.025 headroom below the cap is
tighter than an earlier draft of this table showed (0.341/0.786, an apparent 0.059 margin) — see
"Tooling note" below for why those earlier numbers were wrong. Like 0.70 was at T-0340, this is
**not** independently validated against an approved *passing* locomotion example — no committed
sheet currently declares `motion_class: locomotion` at all (the shipped walk deliberately doesn't,
see `test_character_motion_class_T0357.py`), so this check never fires against real committed art
today. T-0362 is what freezes real numbers against an approved walk.

## Calibration table

**Measured by the real Python gate (`asset_gate.character.sweep_character_gate`) against the
actual committed fixtures** — pinned by `test_control_metric_ranges_match_the_committed_
calibration_table`, and reproduced live by `test_every_control_fails_sweep_character_gate_
naming_the_expected_check` / `test_every_control_makes_the_real_cli_exit_non_zero` in
`tools/asset-gate/tests/test_character_negative_controls_T0361.py`. See "Tooling note" below:
`tests/fixtures/generate_negative_controls_T0361.js` also prints its own version of this table
while it builds the fixtures, but that script's own pose-fidelity/part-identity numbers are a
*different, incorrect* reimplementation of the capsule rasterization `asset_gate.art.
render_rig_silhouette` actually uses — the numbers below are the ones the real gate computes, not
that script's.

| Control | pose-fidelity IoU range | identity-stability (torso) range | part-identity (worst region) range | Caught by |
|---|---|---|---|---|
| `frozen_frame` | **0.4814 – 0.9274** (< 0.70 floor) | 0.000 – 0.000 | 0.0143 – 0.1455 (far_limb) | `character_motion_fidelity` (pose-fidelity) |
| `wrong_phase` | **0.4330 – 0.8028** (< 0.70 floor) | 0.000 – 0.000 | 0.0625 – 0.1764 (far_limb) | `character_motion_fidelity` (pose-fidelity) |
| `swapped_limbs` | **0.6217 – 0.8142** (< 0.70 floor) | 0.000 – 0.000 | 0.0571 – 0.1057 (far_limb) | `character_motion_fidelity` (pose-fidelity) — identity-stability's own 0.000 here IS the DL-31 finding this card exists to fix; see `test_region_identity_stability_fails_on_a_swap_the_whole_frame_misses` for the isolated proof that only the new per-region check catches a swap when pose-fidelity does not |
| `detached_joint` | **0.6155 – 0.6524** (< 0.70 floor) | 0.000 – 0.008 | 0.1962 – 0.3750 (far_limb) | `character_motion_fidelity` (pose-fidelity) |
| `foot_sliding` | **0.5836 – 0.6837** (< 0.70 floor) | **0.000 – 0.234** (> 0.15 cap) | 0.0571 – 0.2656 (torso) | `character_motion_fidelity` (both pose-fidelity and identity-stability) |
| `loop_seam_jump` | **0.1901 – 0.9280** (< 0.70 floor) | **0.000 – 0.664** (> 0.15 cap) | **0.0143 – 0.8000** (> 0.40 cap, head) | `character_motion_fidelity` (both) **and** `character_part_identity` |
| *(reference, unperturbed — not a committed control)* | 1.000 – 1.000 | 0.000 – 0.000 | 0.000 – 0.000 | — sanity baseline only |

Every control makes the `character-gate` CLI exit non-zero (`test_every_control_makes_the_real_cli_exit_non_zero`,
one real `subprocess.run` per control, not just the in-process function).

## Session 13 (T-0340's original negative control) — rescued

**Status: rescued.** `tools/asset-gate/tests/fixtures/session13_negative_control/` is committed
(`50e88e1`), sha256-verified against the card body's "PRESERVED COPY" table before committing:

| File | Bytes | sha256 |
|---|---|---|
| `sheet_192x96_indexed.png` | 4,775 | `f3441daab4fe471437becdaa5a3c8ed9cbe6d8b0fb3ffc0f9ac7b1d9d32dcf8c` |
| `provenance_candidate.json` | 27,791 | `1247a0692331b7804bf5f74979d497796266f1510a2961595e59671ece2f3470` |

`assets/src/character/calibrate_motion_fidelity_T0340.py`'s `SESSION13_SHEET`/`SESSION13_PROVENANCE`
now point at this committed path instead of the sibling `feature/T-0259` worktree, so
`calibrate_session13_drift_candidate()` reads the rescued fixture directly — no sibling worktree
needed on the machine running it. The test
(`test_negative_control_session13_drift_candidate_reproduces_from_real_artifact` in
`tools/asset-gate/tests/test_character_gate.py`) calls that same production helper, re-verifies
both sha256 values itself, and asserts `calibrated["available"]` is true; the old
skip-if-neither-path-exists branch is removed, since the committed fixture is now always present
once this branch is checked out.

## Tooling note: why the generator is JavaScript, not Python

`tools/asset-gate` is a Python package everywhere else (`.claude/rules/python.md`). The fixture
generator (`tests/fixtures/generate_negative_controls_T0361.js`) is JavaScript because this card's
implementer session (the `infra` persona) has no Python execution grant at all — its Bash access
is scoped to `node`/`npm`/`npx vitest`/`git` only, and both `python3 -m venv .venv` and
`python3 -c "import PIL"` required approval that no human was present in this Agent Runner session
to grant (confirmed live, not assumed from a stale permission note). The generator deterministically
reimplements the same gait math (`assets/src/character/pose_rig_walk_T0259.py`, copied as inert
reference data — the same treatment `tests/test_character_gate_pixel_recompute_T0357.py`'s own
`_BASE_POSE_NORM` already gives it) and *attempts* the same capsule-silhouette geometry
`asset_gate.art.render_rig_silhouette` draws. It is deterministic (no `Math.random`/`Date.now`)
and its own PNG bytes were verified structurally (signature, IHDR, IDAT round-trip through
`zlib.inflateSync`) before being committed — the fixtures themselves are trustworthy.

**The generator's own calibration-number output is not.** Its first two VALIDATION rounds (2026-09-17,
archived at `GET /api/tasks/T-0361/verdicts`, 06:40:35Z and 06:51:04Z) found that this script's
`pose_fidelity_range`/`part_identity_range` numbers do not match what `sweep_character_gate` (the
real, enforced gate) actually computes on the same committed fixtures, while
`identity_stability_range` matches exactly. The reason is a genuine rasterization mismatch, not a
rounding artifact: `render_rig_silhouette` draws each limb with PIL's
`ImageDraw.line(..., width=line_width)` (plus a round end-cap ellipse at each joint), which for a
non-axis-aligned segment is not the same raster as this script's own `pointSegDist(...) <= radius`
per-pixel point-to-segment capsule test — the original "a PIL thick line is exactly the Minkowski
sum of the segment with a disk" claim this section used to make here was wrong.
`identity_stability_range` is unaffected because it never touches the predicted silhouette at all —
it only compares a control's own actual frames to each other — while `pose_fidelity_range` and
`part_identity_range` both measure actual-vs-predicted-silhouette overlap and so inherit the
mismatch in full. **The calibration table above is therefore sourced from the real gate's own
output** (`sweep_character_gate`'s `pose_fidelity_range`/`part_identity_range`/
`identity_stability_range` details, as measured live against the committed fixtures and cross-checked
against the reviewer's independent VALIDATION run), pinned against drifting back out of sync by
`test_control_metric_ranges_match_the_committed_calibration_table` in
`tools/asset-gate/tests/test_character_negative_controls_T0361.py` — not by the JS generator's
own printed numbers, which remain useful only as a rough sanity check and a record of which
region is worst per control.

## Note for the reviewer: `assets/src/character`'s own `pytest` suite is pre-existing-broken and out of this card's scope

That same VALIDATION pass also ran `assets/src/character`'s own suite (not one of this card's
acceptance items — see "Acceptance" above, which scopes the required suite to
`tools/asset-gate`) and got 17 failed / 131 errored. This is **not** caused by this card. This
branch touches exactly one file under `assets/src/character/`
(`calibrate_motion_fidelity_T0340.py`, a path-constant + docstring change, see the diff above) —
and:

- That file lives at the package root, not under `tests/`, and doesn't match pytest's
  `test_*.py` collection pattern, so `pytest tests/` never collects or executes it.
- Nothing else in `assets/src/character/` (including every file under `tests/`) references
  `calibrate_motion_fidelity_T0340` or `SESSION13` — grep confirms zero matches outside the file
  itself.
- The actual failure signature traces to `assets/src/character/tests/conftest.py`, a file this
  branch never touched: it `sys.path.insert`s `tools/asset-gate/src`, this package's own `src/`,
  and `assets/src/lora/src` "so a plain `pytest` run against a venv that only has this package's
  `[dev]` deps installed… still collects cleanly" (its own docstring), but does **not** add
  `tools/comfy-client/src`. At least 7 `gen_*_T0*.py` generation scripts import
  `comfy_client.provenance_sidecar` (etc.) at module level, and 16 test files import those
  `gen_*` modules, so those files fail collection with `ModuleNotFoundError: No module named
  'comfy_client'` on a venv that only has `pillow`/`numpy`/`pytest`/`ruff` installed (this
  package's `pyproject.toml` `[dev]` deps — no `comfy_client`, `torch`, or `diffusers`).

Fixing that gap means editing `assets/src/character/tests/conftest.py`, which is outside the
`infra` agent's path scope (`tools/**`, `.github/**`, `.claude/**`, `docs/**` only — never
`assets/**`). It predates this branch and is unrelated to motion-gate negative controls; it
belongs on its own card against `assets/src/character`'s test infra, not this one.
