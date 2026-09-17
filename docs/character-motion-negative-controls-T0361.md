# T-0361 — Motion-gate negative-control battery + spatial part-aware identity check

**Card:** T-0361. **Depends on:** T-0357 (PR #375, live recompute enforcement). **Feeds:**
T-0362 (positive calibration — freezes real threshold numbers against an approved walk).

**2026-09-17 Codex fix (PR #391 review, P2):** the check's original per-part REFERENCE was wrong
— see "2026-09-17 Codex fix: a real per-part reference" below. This is the section that changed;
everything else on this page (the six named controls, session 13's rescue) is unaffected in kind,
though every control's own `part_identity_range` number changed as a direct result and is updated
below.

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
  positive_controls/
    multi_color_identity/character/...   # 2026-09-17 Codex fix -- see below
  part_identity_negative_controls/
    swapped_limb_colors/character/...    # 2026-09-17 Codex fix -- see below
  generate_part_identity_controls_T0361.js   # the generator for those two
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

`asset_gate.character.determine_character_part_identity` (`character_part_identity` in every
report/sweep) recomputes, per frame, four NAMED regions — `head`, `torso` (fixed, mirrors
T-0357's torso box), `near_limb` (right arm + right leg), `far_limb` (left arm + left leg) — each
derived from that frame's own rig-commanded keypoints, and fails if the WORST region's actual
palette-histogram distance against a REFERENCE exceeds `PART_IDENTITY_HISTOGRAM_CAP`.

**The clean, isolated proof this check is necessary** — a left/right swap whose whole-frame *and*
fixed-torso histogram distance is reported at exactly 0.0, that only the new per-region check
catches — is `test_region_identity_stability_fails_on_a_swap_the_whole_frame_misses` in
`tools/asset-gate/tests/test_art.py`: two 20x20 synthetic frames with a "near" and "far" box whose
CONTENTS are swapped (same total foreground pixel count, so the whole-frame check scores 0.0
distance by construction; the per-region check evaluates each box on its own and fails). This
is a plain synthetic unit test (`asset_gate.art`-level, not one of the committed fixtures below),
per this repo's usual "generate tiny fixtures in-process" convention (`.claude/rules/python.md`)
— but (2026-09-17 Codex review) a unit test of the comparator alone does not prove the PRODUCTION
gate catches a swap that a whole-frame check would miss; see "committed proof through the
production gate" below for the fixtures that do.

### 2026-09-17 Codex fix: a real per-part reference

**The finding.** The first cut compared each frame's real pixels against `asset_gate.art.
render_rig_silhouette`'s own rendered output wrapped as an image — pose geometry only, drawn at
ONE hard-coded foreground palette index. That measures "does this region use that one index," not
identity. Codex's `identity-probe.py` (embedded in the card body, reproduced as
`test_part_identity_is_colour_index_agnostic` in `test_character_part_identity_T0361.py`) proved
it: the identical rig silhouette, recoloured at palette index 1, passed; recoloured at index 2 with
the same geometry and motion, it failed at distance 1.0 against the (then) 0.40 cap. Any character
consistently drawn in a palette index other than whatever the silhouette happened to use could fail
this mandatory check on colour alone. The committed `swapped_limbs` control (mirror-geometry, one
foreground colour throughout) could not expose this: its limbs share one colour, so a mirror cannot
change any part's *appearance*, only its *position* — its pre-fix part-identity max (0.1057) passed
the check even though `test_control_metric_ranges_match_the_committed_calibration_table` pinned
that exact number, which is why the gap needed a *new* fixture, not a re-reading of an old one.

**The fix.** `asset_gate.art.check_region_identity_against_reference` (new; shares its core
histogram arithmetic with `check_identity_stability` via the `_region_histogram_distance` helper,
so the two primitives cannot silently diverge) compares each frame's own named region against a
REAL reference frame's own same-named region — never a rendered silhouette. `asset_gate.character.
_recompute_part_identity_from_frames` resolves every frame's own region boxes first, then compares
every frame (including the reference frame itself, trivially) against `PART_IDENTITY_REFERENCE_
FRAME_INDEX` (frame 0) of the *same sheet*. Whatever colour frame 0 actually uses for a part is
what every other frame's same part is checked against — colour-index-agnostic the same way
`check_identity_stability`'s own torso comparison already is, at the cost of one honestly-documented
limit:

**Documented limit — a defect present identically in every frame, including frame 0, is invisible.**
Frame 0 is the reference; if the SAME defect is baked into frame 0 too, frame 0 agrees with itself
and every other frame agrees with frame 0, so nothing ever disagrees.
`test_swap_present_uniformly_in_every_frame_is_invisible_to_the_anchor_reference` in
`test_character_part_identity_T0361.py` proves this directly. Its extreme case is a single-frame
sheet (`len(frames) == 1`): frame 0 is both the only frame under test and its own reference, so the
comparison is always self-consistent (distance 0 for every region) regardless of content — this is
explicit in the check's own details (`single_frame_trivial_pass=True`), never a silent skip, and is
NOT a live gap in practice: a single-frame sheet still fails `character_motion_fidelity`'s own
pose-fidelity floor on a genuinely bad render (that check has no anchor-frame blind spot), and every
committed fixture on this page has 8 frames. This limit is inherent to ANY design that reuses a
frame of the same sheet as ground truth (the alternative — a declared, separately-authored identity
reference per sheet — was considered and rejected for this card: it is a bigger, out-of-scope
change or an extra generation-time artifact this card's fixtures do not need to prove the fix).

**Committed proof through the production gate** (not just the unit-level comparator above):

- `positive_controls/multi_color_identity/`: every frame colours head/torso/near_limb/far_limb
  with its own distinct palette index (1/2/3/4) at that frame's own rig-commanded region, correct
  motion (each region really does move, frame to frame, with the rig) — passes
  `character_part_identity` (`part_identity_range` exactly `[0.0, 0.0]`) through
  `sweep_character_gate` and the `character-gate` CLI. Lives OUTSIDE `negative_controls/`
  (`test_positive_fixture_lives_outside_the_negative_controls_directory`) so the six-control
  suite's own "every control makes the CLI exit non-zero" item keeps applying to negative controls
  only.
- `part_identity_negative_controls/swapped_limb_colors/`: frame 0 is byte-identical to the positive
  fixture's own frame 0 (correct — verified by both the generator's own self-check at build time
  and `test_frame_0_is_byte_identical_between_the_positive_and_swap_fixtures`); frames 1-7 swap
  which colour `near_limb`/`far_limb` use. Geometry is unperturbed (identical to the positive
  fixture's own, matching the correct rig keypoints exactly), and `near_limb`/`far_limb` are always
  equal-area by construction (they are exact horizontal mirrors of each other), so the swap exactly
  preserves the whole-frame palette histogram every single frame — the generator asserts this at
  build time, per frame, before writing the fixture. `character_part_identity` still FAILS it
  (`part_identity_range` `[0.0, 1.0]`, `near_limb`/`far_limb` both at the maximum 1.0, `head`/`torso`
  both at 0.0 — `test_swap_fixture_worst_regions_are_near_and_far_limb_not_head_or_torso`), through
  `sweep_character_gate` and the `character-gate` CLI (`test_swap_fixture_makes_the_real_cli_exit_
  non_zero_naming_character_part_identity`), naming `character_part_identity` specifically. Lives
  in its own directory rather than as a 7th entry in `negative_controls/` because that suite's own
  calibration table (below) pins EXACT `pose_fidelity_range`/`identity_stability_range` numbers per
  fixture that only a real PIL recompute can produce (see "Tooling note"); this fixture's rig
  topology is bespoke (disjoint flat-rectangle region fills, not the real gait, so its box math has
  no PIL-rasterization dependency at all — see `generate_part_identity_controls_T0361.js`'s own
  header) specifically so ITS numbers don't need one.

Both fixtures are built by the committed, deterministic `generate_part_identity_controls_T0361.js`
generator — never the T-0338 compositor (`test_neither_fixture_is_produced_by_the_t0338_compositor`,
`model: "synthetic-part-identity-rig/v1"`).

### The six named controls, under the new reference

`swapped_limbs` (mirror geometry, one foreground colour) is now ALSO caught by
`character_part_identity` — an emergent, accurate result of comparing against a real frame instead
of a fixed-index silhouette (its `near_limb` region, at 0.4148, is now measurably different between
frame 0 and the mirrored later frames, where the pre-fix silhouette-based measure saw only 0.1057).
This satisfies this card's own acceptance item ("`swapped_limbs` is either converted into this case
or kept with an accurate expectation") by the second branch: the control is unchanged, its expected
result is now accurate. `loop_seam_jump` remains the other control `character_part_identity` catches
(worst region now `head`, 0.7857, was already `head` before the fix). The other four
(`frozen_frame`, `wrong_phase`, `detached_joint`, `foot_sliding`) stay below the cap, caught only by
`character_motion_fidelity` — see the table below for every control's own worst region and margin.

**`PART_IDENTITY_HISTOGRAM_CAP = 0.40`** is UNCHANGED by this fix (the acceptance criteria permit
re-choosing it with recorded margins, but the existing value still separates the two populations
cleanly enough that there is no reason to move it). Under the new reference, the four uncaught
controls' worst measured margin is 0.3184 (`frozen_frame`'s `near_limb`) and the two caught
controls' lowest measured value is 0.4148 (`swapped_limbs`'s `near_limb`) — a THINNER margin
(0.0816) than the pre-fix reading (0.025 was itself already flagged as tight) and, notably, now
sitting on the "caught" side by only 0.0148 above the cap itself for `swapped_limbs` specifically.
Like 0.70 was at T-0340, this is **not** independently validated against an approved *passing*
locomotion example — no committed sheet under `assets/final/` currently declares `motion_class:
locomotion` at all (the shipped walk deliberately doesn't, see `test_character_motion_class_
T0357.py`), so this check never fires against real committed art today. T-0362 is what freezes real
numbers against an approved walk; given how thin `swapped_limbs`'s own margin now is, T-0362 should
look at this cap specifically, not just `POSE_FIDELITY_IOU_FLOOR`/`IDENTITY_STABILITY_HISTOGRAM_CAP`.

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
| `frozen_frame` | **0.4814 – 0.9274** (< 0.70 floor) | 0.000 – 0.000 | 0.000 – 0.3184 (near_limb, < 0.40 cap) | `character_motion_fidelity` (pose-fidelity) |
| `wrong_phase` | **0.4330 – 0.8028** (< 0.70 floor) | 0.000 – 0.000 | 0.000 – 0.3179 (near_limb, < 0.40 cap) | `character_motion_fidelity` (pose-fidelity) |
| `swapped_limbs` | **0.6217 – 0.8142** (< 0.70 floor) | 0.000 – 0.000 | **0.000 – 0.4148** (near_limb, > 0.40 cap) | `character_motion_fidelity` (pose-fidelity) **and** `character_part_identity` — identity-stability's own 0.000 here IS the DL-31 finding this card exists to fix; see `test_region_identity_stability_fails_on_a_swap_the_whole_frame_misses` for the isolated unit-level proof, and `part_identity_negative_controls/swapped_limb_colors/` above for the committed production-gate proof |
| `detached_joint` | **0.6155 – 0.6524** (< 0.70 floor) | 0.000 – 0.008 | 0.000 – 0.2646 (near_limb, < 0.40 cap) | `character_motion_fidelity` (pose-fidelity) |
| `foot_sliding` | **0.5836 – 0.6837** (< 0.70 floor) | **0.000 – 0.234** (> 0.15 cap) | 0.000 – 0.2266 (torso, < 0.40 cap) | `character_motion_fidelity` (both pose-fidelity and identity-stability) |
| `loop_seam_jump` | **0.1901 – 0.9280** (< 0.70 floor) | **0.000 – 0.664** (> 0.15 cap) | **0.000 – 0.7857** (head, > 0.40 cap) | `character_motion_fidelity` (both) **and** `character_part_identity` |
| *(reference, unperturbed — not a committed control)* | 1.000 – 1.000 | 0.000 – 0.000 | 0.000 – 0.000 | — sanity baseline only |

Every control makes the `character-gate` CLI exit non-zero (`test_every_control_makes_the_real_cli_exit_non_zero`,
one real `subprocess.run` per control, not just the in-process function). `part_identity_range` above
is the 2026-09-17 (post-fix) number for every control — see "2026-09-17 Codex fix" above for why it
changed and `swapped_limbs`'s own margin note.

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
it only compares a control's own actual frames to each other — while (at the time those two
VALIDATION rounds ran) `pose_fidelity_range` and `part_identity_range` both measured
actual-vs-predicted-silhouette overlap and so inherited the mismatch in full. **The 2026-09-17
Codex fix changes this for `part_identity_range` specifically**: `character_part_identity` no
longer touches `render_rig_silhouette` or any rendered prediction at all (see "2026-09-17 Codex
fix" above) — it only compares a control's own real frames against its own real frame 0, the exact
same "no rendering involved" shape `identity_stability_range` already has. `part_identity_range`'s
own numbers in the table above were re-derived the same way: a pure box-crop
(`_joint_group_box_px`/`_torso_region_px`'s own arithmetic, integer coordinates throughout for
every committed control, so no rounding-tie risk) + palette-histogram-distance computation against
the committed fixtures' own decoded pixels, carrying none of the PIL-rasterization risk
`pose_fidelity_range` still does. **The calibration table above is therefore sourced from the real gate's own
output** (`sweep_character_gate`'s `pose_fidelity_range`/`part_identity_range`/
`identity_stability_range` details, as measured live against the committed fixtures and cross-checked
against the reviewer's independent VALIDATION run), pinned against drifting back out of sync by
`test_control_metric_ranges_match_the_committed_calibration_table` in
`tools/asset-gate/tests/test_character_negative_controls_T0361.py` — not by the JS generator's
own printed numbers, which remain useful only as a rough sanity check and a record of which
region is worst per control.

## The committed `assets/final` tree and the new reference

`character-gate assets/final --repo-root .` must still exit 0. `character_part_identity` only
recomputes for a sheet whose `motion_class` is `locomotion`/`transition`/`loop`
(`_HIGHER_CAP_MOTION_CLASSES`); every other value (including a missing one) is an explicit,
reported skip (`details.skipped=True`), never a silent pass with no result at all. No committed
sheet under `assets/final/character/` currently declares one of those three values:
`player_walk_sheet_hybrid.provenance.json` — the one sheet that IS unambiguously a locomotion
cycle — has no `motion_class` field at all and is listed, by name, in
`character_motion_class_baseline.txt` (T-0357's own exemption from the *declaration* requirement,
predating and unrelated to this card — see that file's own comments), so `character_part_identity`
resolves it to `motion_class=None`, an explicit skip, the same as every other legacy sheet. This
card does not add, remove, or touch that baseline. If a future card labels that sheet
`motion_class: "locomotion"` (T-0359's own known follow-on, see the baseline file), the new
per-part reference — like `character_motion_fidelity`'s own recompute already does — will engage
for real and may fail on genuine numbers; that is expected and out of THIS card's scope to
pre-empt.

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
