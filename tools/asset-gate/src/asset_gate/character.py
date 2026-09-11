"""CHR-1 enforcement: the character asset-gate (T-0258, docs/board-invariants.md CHR-1).

CHR-1 (DL-25, PR #287) requires every character-generation output to record
both its own frame-delta measurement (``frame_delta_range``) and its
comparison against the Arm-C benchmark (``arm_c_benchmark`` +
``beats_arm_c_benchmark``) in its provenance sidecar. Before this module that
was convention only -- CHR-1's own coverage cell said so, and a new
character-sheet generator could drop the fields silently. This is the
enforcement half; ``comfy_client.provenance_sidecar.apply_arm_c_benchmark_fields``
is the write half that guarantees the fields go in together, correctly
derived -- this gate catches anything that lands without it, from any writer.

**Scope.** CHR-1 only applies to the ``character`` asset class -- classified
the same way ``transparency.asset_class`` does, by top-level directory under
``assets/final/``. Props, tiles, concept sheets, and entity sheets (their own
top-level class, ``assets/final/entity/``) are explicitly out of scope and
must never fail this gate; ``sweep_character_arm_c_provenance`` reports them
as passing, skipped, without even opening them.

**CHR-2 (recorded, not deciding).** ``beats_arm_c_benchmark`` records whether
a sheet's frame-delta beat Arm C's own benchmark, not whether the sheet is
acceptable -- the shipped winning arm (§24-e, T-0252) is itself ``false``.
``check_character_arm_c_provenance`` only asserts the fields are *present
and well-formed*; it never fails a sheet for ``beats_arm_c_benchmark: false``.

**Backfill (T-0258 item 5, option (b)).** 15 character sidecars predate
CHR-1 and are not backfilled by this card -- a frame-delta that was never
measured must not be invented. They are listed in
``character_arm_c_baseline.txt``, the same baseline-exemption idiom
``generator_baseline.txt``/``provenance_baseline.txt``/``transparency_baseline.txt``
already use. That list is expected to shrink to zero as each sheet is
regenerated or has its CHR-1 fields genuinely backfilled by a dedicated card
-- never by adding a new exemption for a new output.

**T-0340 (docs/decision-log.md DL-31): the motion-class frame-delta gate is
retired for locomotion/transition/loop.** T-0271/DL-26 gave those three
classes a higher whole-silhouette XOR/union cap (``MOTION_FRAME_DELTA_CAP``,
0.50) on the theory that a real gait legitimately moves more silhouette
pixels per frame than an idle pose. The theory was right; the fix was not
big enough. Rendering the rig's own commanded skeletons as capsules --
perfect pose, zero drift, nothing to catch -- already consumes 0.23-0.49 of
that same 0.50 cap by itself, because the measure is frame-to-frame delta,
and a leg mid-stride is nowhere near where it was a frame ago regardless of
how faithfully anything rendered it. The only sheets that reliably passed
were the ones that barely moved. Independently, a sequential-chained
candidate (session 13's overnight run) scored a deceptively low delta and
passed most of its interior pairs because colour drift was *shrinking* the
silhouette, not because it walked -- the same measure that punishes
legitimate motion also rewards a specific kind of failure that isn't
motion at all.

``check_character_frame_delta_cap`` / ``sweep_character_frame_delta_cap``
now report locomotion/transition/loop as not-applicable (skipped, passing)
regardless of the recorded ``frame_delta_range`` -- ``idle`` (and any
missing/unrecognised class) is completely unaffected and keeps exactly
DL-26's 0.30 cap. ``check_character_motion_fidelity`` /
``sweep_character_motion_fidelity`` are the replacement for the retired
three: pose-fidelity IoU (does the render match what the rig commanded for
THIS frame, not how much the previous frame differed -- so it does not
charge a sheet for its own legitimate motion) plus identity-stability
histogram distance over a fixed torso box (does the torso's own colour
stay put, independent of how far the limbs swing -- so it catches the
colour-drift failure the old measure rewarded). Both live in
``asset_gate.art`` (``check_pose_fidelity``, ``check_identity_stability``,
``render_rig_silhouette``); this module only grades the provenance fields
a generator recorded from them, the same shape CHR-1 already uses for
``frame_delta_range``. ``MOTION_FRAME_DELTA_CAP`` and
``frame_delta_cap_for_motion_class`` are unchanged and still exported --
existing generator scripts (``assets/src/character/gen_hybrid_walk_T0259.py``
etc.) use the function for their own generation-time self-check, a
different concern from this module's gate enforcement, and editing those
scripts is out of this card's scope.
"""

from __future__ import annotations

import json
import numbers
from pathlib import Path

from PIL import Image

from asset_gate import art
from asset_gate.result import CheckResult

_MISSING = object()
_BASELINE_FILENAME = "character_arm_c_baseline.txt"
_MOTION_CLASS_BASELINE_FILENAME = "character_motion_class_baseline.txt"

#: The asset class this gate applies to -- see the module docstring's Scope
#: section. Everything else is reported as passing, skipped.
CHARACTER_CLASS = "character"

#: DL-21 criterion 2's cap, pre-registered against the player IDLE sheet.
#: Unchanged by T-0271 -- every idle-class (or unrecognised-class, see
#: `frame_delta_cap_for_motion_class`) sheet keeps exactly this bar.
IDLE_FRAME_DELTA_CAP = 0.30

#: T-0271/DL-26: locomotion/transition/loop legitimately move more
#: silhouette pixels per frame than an idle pose. T-0259's calibration trail
#: (docs/decision-log.md DL-26) measured sheets that read as a real walk on
#: human review at 0.212-0.375 (attempt 6) and 0.328-0.473 (attempt 5,
#: full-amplitude), with a restored leg-cross pushing higher still -- so the
#: cap must clear ~0.47 with headroom while staying low enough to still
#: catch gross drift. 0.50 is chosen: it clears every measured real-walk
#: upper bound with room to spare, while still failing sheets that drift far
#: past what any of T-0259's attempts produced.
MOTION_FRAME_DELTA_CAP = 0.50

#: Motion classes T-0271 gave the higher `MOTION_FRAME_DELTA_CAP`, and that
#: T-0340 now routes to `check_character_motion_fidelity` instead (see the
#: T-0340 module note below). `idle` is deliberately not listed here -- it,
#: and anything not in this set (including a missing motion class), falls
#: through to `IDLE_FRAME_DELTA_CAP` in `frame_delta_cap_for_motion_class`
#: and stays on `check_character_frame_delta_cap`'s whole-silhouette path.
#: This is the fail-closed behaviour the card requires: an unlabelled or
#: unrecognised sheet must never silently get the permissive cap, or skip
#: straight past both gates.
_HIGHER_CAP_MOTION_CLASSES = frozenset({"locomotion", "transition", "loop"})

#: T-0340 (docs/decision-log.md DL-31): floor for pose-fidelity IoU --
#: rendered silhouette vs. the rig-predicted (capsule) silhouette for that
#: frame's own commanded pose -- on locomotion/transition/loop sheets.
#: Calibrated against the real, committed T-0259 attempt-4 walk (measured
#: 0.393-0.630, DL-31's table): a floor of 0.70 correctly rejects that
#: sheet, which DL-26 already documents as reading with "motion barely
#: visible" -- exactly the failure this floor exists to catch, not a
#: contradiction of it.
POSE_FIDELITY_IOU_FLOOR = 0.7

#: T-0340 (DL-31): cap for torso palette-histogram distance frame to frame,
#: on the same three motion classes. Calibrated against the same real
#: T-0259 attempt-4 walk: its interior frame pairs measured 0.047-0.070
#: (ordinary per-frame cutout-mask noise, not drift), while the pairs
#: touching a cropped loop-seam frame spiked to 0.297-0.320. 0.15 sits
#: between those two populations -- comfortably above ordinary noise,
#: comfortably below a real drift/cropping fault.
IDENTITY_STABILITY_HISTOGRAM_CAP = 0.15

#: T-0357: every motion_class value any check in this module treats as
#: meaningful -- `idle` plus the three T-0340 higher-cap classes. A missing
#: or unrecognised value is NOT a member of this set; see
#: `check_character_motion_class_declared`, the new requirement that a
#: sheet actually be one of these rather than silently riding whichever
#: check's own fail-closed default happens to treat an absent class like
#: `idle`.
KNOWN_MOTION_CLASSES = frozenset({"idle"}) | _HIGHER_CAP_MOTION_CLASSES

#: T-0357 finding 3: versioned rig config for recomputing pose-fidelity/
#: identity-stability live from a sheet's own pixels instead of trusting
#: whatever range its sidecar records. Mirrors
#: `assets/src/character/gen_arm_a_idle_T0228.py`'s `_POSE_LIMBS` joint
#: topology (colour is irrelevant to a silhouette, so only the joint pairs
#: are kept) and the capsule radius
#: `assets/src/character/calibrate_motion_fidelity_T0340.py` established
#: (docs/decision-log.md DL-31) -- duplicated rather than imported for the
#: same import-isolation reason `asset_class()` gives for its own mirrored
#: constant, one path scope further out: `asset_gate` (tools/**) must not
#: depend on `assets/src/character/**` (a different agent's path scope
#: entirely, not just an unrelated module in this package). Bump
#: RIG_CONFIG_VERSION if either the joint pairs or the radius ever changes,
#: so a cache keyed on it (if a future caller adds one) invalidates itself.
RIG_CONFIG_VERSION = "gen_arm_a_idle_T0228:_POSE_LIMBS+capsule_radius:v1"

#: (joint_a, joint_b) pairs only -- see RIG_CONFIG_VERSION's docstring.
RIG_LIMB_JOINT_PAIRS: tuple[tuple[int, int], ...] = (
    (1, 2),
    (1, 5),
    (2, 3),
    (3, 4),
    (5, 6),
    (6, 7),
    (1, 8),
    (8, 9),
    (9, 10),
    (1, 11),
    (11, 12),
    (12, 13),
    (1, 0),
    (0, 14),
    (14, 16),
    (0, 15),
    (15, 17),
)

#: Capsule half-width in the same cell-pixel space the sheet is indexed in
#: -- see RIG_CONFIG_VERSION's docstring.
MOTION_FIDELITY_CAPSULE_RADIUS_PX = 2.5

#: Right shoulder, left shoulder, right hip, left hip -- the static base
#: pose's own normalised coordinates (mirrors the relevant subset of
#: `gen_arm_a_idle_T0228._POSE_KEYPOINTS_NORM`), used to derive a torso
#: region that is FIXED across every frame of a sheet: the torso does not
#: stride, so identity-stability must compare the same box in every frame
#: regardless of which frame's own keypoints happen to be recorded (see
#: `calibrate_motion_fidelity_T0340.py`'s own `_torso_region`, which this
#: mirrors exactly so recomputation reproduces its calibrated numbers).
TORSO_ANCHOR_POINTS_NORM: dict[int, tuple[float, float]] = {
    2: (0.417, 0.225),
    5: (0.583, 0.225),
    8: (0.446, 0.570),
    11: (0.554, 0.570),
}


def frame_delta_cap_for_motion_class(motion_class: object) -> float:
    """The frame-delta cap for a character sheet's motion class.

    `idle`, `None`, and any value not in `_HIGHER_CAP_MOTION_CLASSES` all
    resolve to `IDLE_FRAME_DELTA_CAP` -- a missing or unrecognised motion
    class fails closed to the strict cap, never the permissive one.
    """
    if motion_class in _HIGHER_CAP_MOTION_CLASSES:
        return MOTION_FRAME_DELTA_CAP
    return IDLE_FRAME_DELTA_CAP


def asset_class(relative_path: Path | str) -> str:
    """The top-level asset class of a path relative to `assets/final/`.

    Mirrors `transparency.asset_class` exactly -- same classification rule,
    kept here rather than imported so this module has no import-time
    dependency on `transparency`'s own (unrelated) scope list.
    """
    parts = Path(relative_path).parts
    return parts[0] if len(parts) > 1 else ""


def _is_well_formed_range(value: object) -> bool:
    """A 2-element numeric sequence, lo <= hi. `bool` is excluded even
    though it subclasses `int` in Python -- a range built from booleans is
    never a real measurement."""
    if not isinstance(value, list | tuple) or len(value) != 2:
        return False
    lo, hi = value
    if isinstance(lo, bool) or isinstance(hi, bool):
        return False
    if not isinstance(lo, numbers.Real) or not isinstance(hi, numbers.Real):
        return False
    return lo <= hi


def check_character_arm_c_provenance(provenance: dict, sheet_name: str = "<sheet>") -> CheckResult:
    """Fail if `frame_delta_range` or the Arm-C comparison fields are absent
    or malformed on a character-class provenance record.

    Checks presence and shape only -- never the derived verdict (CHR-2). A
    sheet whose `beats_arm_c_benchmark` is `False` still passes; only a
    missing or malformed field fails it.

    Args:
        provenance: dict loaded from a `.provenance.json` sidecar.
        sheet_name: identifies the sheet in the failure message (typically
            its path relative to some root) -- callers doing a one-off check
            outside a sweep may leave this as the default.

    Returns:
        `CheckResult` with `passed=True` iff `frame_delta_range`,
        `arm_c_benchmark` and `beats_arm_c_benchmark` are all present and
        well-formed.
    """
    missing: list[str] = []

    frame_delta_range = provenance.get("frame_delta_range", _MISSING)
    if frame_delta_range is _MISSING or not _is_well_formed_range(frame_delta_range):
        missing.append("frame_delta_range")

    arm_c_benchmark = provenance.get("arm_c_benchmark", _MISSING)
    if arm_c_benchmark is _MISSING or not _is_well_formed_range(arm_c_benchmark):
        missing.append("arm_c_benchmark")

    beats_arm_c_benchmark = provenance.get("beats_arm_c_benchmark", _MISSING)
    if beats_arm_c_benchmark is _MISSING or not isinstance(beats_arm_c_benchmark, bool):
        missing.append("beats_arm_c_benchmark")

    if missing:
        return CheckResult(
            check="character_arm_c_provenance",
            passed=False,
            reason=(
                f"{sheet_name} is missing or has a malformed CHR-1 field(s): "
                f"{', '.join(missing)} -- every character-generation output must record both "
                "its frame-delta and its Arm-C benchmark comparison "
                "(docs/board-invariants.md CHR-1)"
            ),
            details={"missing": missing},
        )

    return CheckResult(
        check="character_arm_c_provenance",
        passed=True,
        reason=f"{sheet_name}: frame_delta_range + Arm-C benchmark comparison both recorded",
        details={
            "frame_delta_range": frame_delta_range,
            "arm_c_benchmark": arm_c_benchmark,
            "beats_arm_c_benchmark": beats_arm_c_benchmark,
        },
    )


def check_character_frame_delta_cap(provenance: dict, sheet_name: str = "<sheet>") -> CheckResult:
    """Fail if an `idle`-class (or missing/unrecognised, fail-closed)
    character sheet's `frame_delta_range` exceeds DL-21's 0.30 cap
    (T-0271, docs/decision-log.md DL-26).

    **T-0340 (DL-31): locomotion/transition/loop are retired from this
    check.** See this module's docstring for why the whole-silhouette
    XOR/union measure was unpassable for real motion. Those three classes
    now report not-applicable (`passed=True`, `details["skipped"]`)
    regardless of the recorded range -- `check_character_motion_fidelity`
    is what grades them. `idle` (and anything missing or unrecognised) is
    completely unaffected and keeps exactly DL-26's 0.30 cap. Reads
    `motion_class` from the provenance sidecar itself rather than card
    metadata, so a sheet is self-describing without a board lookup.

    Only evaluates the cap -- CHR-1's own presence/shape check
    (`check_character_arm_c_provenance`) is unchanged and unrelated; a sheet
    can fail this check while still passing that one, and vice versa.

    Args:
        provenance: dict loaded from a `.provenance.json` sidecar.
        sheet_name: identifies the sheet in the failure message.

    Returns:
        `CheckResult` with `passed=True` iff the sidecar's `motion_class` is
        one of the retired three (skipped), or `frame_delta_range` is
        present, well-formed, and within DL-26's 0.30 idle cap.
    """
    motion_class = provenance.get("motion_class")
    if motion_class in _HIGHER_CAP_MOTION_CLASSES:
        return CheckResult(
            check="character_frame_delta_cap",
            passed=True,
            reason=(
                f"{sheet_name}: motion_class={motion_class!r} -- the whole-silhouette "
                "XOR/union frame-delta cap is retired for locomotion/transition/loop "
                "(T-0340, docs/decision-log.md DL-31); see check_character_motion_fidelity"
            ),
            details={"motion_class": motion_class, "skipped": True},
        )

    frame_delta_range = provenance.get("frame_delta_range", _MISSING)
    if frame_delta_range is _MISSING or not _is_well_formed_range(frame_delta_range):
        return CheckResult(
            check="character_frame_delta_cap",
            passed=False,
            reason=(
                f"{sheet_name} is missing or has a malformed frame_delta_range -- "
                "cannot evaluate the motion-class frame-delta cap"
            ),
            details={"missing": ["frame_delta_range"]},
        )

    # motion_class is already known NOT to be one of the retired three
    # (handled above) -- this is always DL-26's idle cap, never the retired
    # MOTION_FRAME_DELTA_CAP. Reused via frame_delta_cap_for_motion_class
    # rather than IDLE_FRAME_DELTA_CAP directly so the two can never drift
    # apart if that function's fail-closed behaviour ever changes.
    cap = frame_delta_cap_for_motion_class(motion_class)
    _, hi = frame_delta_range
    passed = hi <= cap

    return CheckResult(
        check="character_frame_delta_cap",
        passed=passed,
        reason=(
            f"{sheet_name}: motion_class={motion_class!r} frame-delta upper bound "
            f"{hi:.4f} {'<=' if passed else '>'} cap {cap}"
        ),
        details={
            "frame_delta_range": frame_delta_range,
            "motion_class": motion_class,
            "cap": cap,
        },
    )


def build_character_gate_report(
    sheet: Image.Image,
    provenance: dict,
    *,
    cols: int,
    rows: int,
    cell_px: int,
    background_index: int = 0,
    sheet_name: str = "<sheet>",
    repo_root: Path | str = ".",
) -> dict:
    """Assemble the machine-readable gate report for a character sheet
    (T-0349, docs/board-invariants.md CHR-1).

    Every T-0259 reviewer re-derived frame deltas from a sheet by hand and
    disagreed -- one measurement on the wrong grid gave 1.29x where the true
    value on the correct grid is 5.3077x. This function is the fix: it
    records the grid *explicitly* (`cols`/`rows`/`cell_px` are required
    keyword args, never inferred), the sheet's `motion_class`, the
    threshold actually applied (`frame_delta_cap_for_motion_class`, not a
    re-derived number), and, per adjacent frame pair (interior pairs plus
    the explicit loop seam, last frame -> frame 0), two distinct per-frame
    metrics:

    - `pixel_delta_count` (`asset_gate.art.count_pixel_deltas`): ANY
      palette-index change between the two frames -- the number a reviewer
      eyeballing the sheet by hand actually sees.
    - `silhouette_delta_ratio` (`asset_gate.art.check_frame_consistency`):
      the foreground/background *state* delta ratio the gate's own
      `frame_delta_cap` already thresholds on.

    Changes no threshold or gate semantics: `checks` is exactly what
    `check_character_arm_c_provenance` / `check_character_frame_delta_cap`
    (the real enforcement predicates) already decide for *provenance*,
    reused rather than re-derived.

    T-0357: `checks` also includes `character_motion_fidelity` --
    `determine_character_motion_fidelity`'s own result, recomputed live from
    this sheet's pixels when the provenance records enough rig evidence to
    do so (`repo_root` resolves each frame's `pose_keypoints_file`), FAILING
    outright for a locomotion/transition/loop asset that does not (2026-09-11
    PR review, P1) -- it never falls back to the sidecar-trusting predicate
    for one of those three classes. Before this card a
    failing motion result never appeared here at all, so a CLI caller doing
    `all(check["passed"] for check in report["checks"].values())` (exactly
    what `cli.py`'s `character-gate-report` subcommand does) could not see
    it. `thresholds["frame_delta_cap_diagnostic_only"]` marks whether the
    reported `frame_delta_cap` is the real, enforced idle cap or the
    retired 0.50 motion-class cap (T-0340/DL-31) that
    `check_character_frame_delta_cap` no longer evaluates for locomotion/
    transition/loop -- present in the report for visibility only, never an
    acceptance criterion in its own right.
    """
    frames = art.slice_sheet_frames(sheet, cell_px, cell_px, cols, rows)
    if len(frames) != cols * rows:
        raise ValueError(
            f"expected {cols * rows} frames for a {cols}x{rows} grid, got {len(frames)}"
        )

    frame_cells = [[r, c] for r in range(rows) for c in range(cols)]
    pairs = [(i, i + 1) for i in range(len(frames) - 1)] + [(len(frames) - 1, 0)]

    motion_class = provenance.get("motion_class")
    frame_delta_cap = frame_delta_cap_for_motion_class(motion_class)
    arm_c_benchmark = provenance.get("arm_c_benchmark")

    frame_pairs = []
    for a, b in pairs:
        pixel_delta_count = art.count_pixel_deltas(frames[a], frames[b])
        consistency = art.check_frame_consistency(
            frames[a],
            frames[b],
            background_index=background_index,
            max_delta_ratio=frame_delta_cap,
        )
        frame_pairs.append(
            {
                "pair": [frame_cells[a], frame_cells[b]],
                "pixel_delta_count": pixel_delta_count,
                # check_frame_consistency's ratio/passed are numpy scalars
                # (numpy.float64/numpy.bool_) -- cast to native types so the
                # report is plain-json-serializable without touching that
                # function's own (pre-existing, untouched) behaviour.
                "silhouette_delta_ratio": float(consistency.details["ratio"]),
                "within_frame_delta_cap": bool(consistency.passed),
            }
        )

    pixel_delta_counts = [p["pixel_delta_count"] for p in frame_pairs]
    silhouette_ratios = [p["silhouette_delta_ratio"] for p in frame_pairs]
    min_count, max_count = min(pixel_delta_counts), max(pixel_delta_counts)

    arm_c_result = check_character_arm_c_provenance(provenance, sheet_name=sheet_name)
    cap_result = check_character_frame_delta_cap(provenance, sheet_name=sheet_name)
    motion_result = determine_character_motion_fidelity(
        provenance,
        frames=frames,
        cell_px=cell_px,
        repo_root=repo_root,
        background_index=background_index,
        sheet_name=sheet_name,
    )

    return {
        "sheet": sheet_name,
        "grid": {
            "cols": cols,
            "rows": rows,
            "cell_px": cell_px,
            "frame_cells": frame_cells,
        },
        "motion_class": motion_class,
        "thresholds": {
            "frame_delta_cap": frame_delta_cap,
            # T-0357: the 0.50 motion-class cap is retired (T-0340/DL-31) --
            # check_character_frame_delta_cap already skips it entirely for
            # locomotion/transition/loop, so the value reported above is
            # informational only for those classes, never an acceptance
            # criterion. character_motion_fidelity is the real gate.
            "frame_delta_cap_diagnostic_only": motion_class in _HIGHER_CAP_MOTION_CLASSES,
            "arm_c_benchmark": arm_c_benchmark,
        },
        "frame_pairs": frame_pairs,
        "pixel_delta_summary": {
            "counts": pixel_delta_counts,
            "max": max_count,
            "min": min_count,
            "max_min_ratio": (max_count / min_count) if min_count else None,
        },
        "silhouette_delta_range": [min(silhouette_ratios), max(silhouette_ratios)],
        "checks": {
            "character_arm_c_provenance": {
                "passed": arm_c_result.passed,
                "reason": arm_c_result.reason,
            },
            "character_frame_delta_cap": {
                "passed": cap_result.passed,
                "reason": cap_result.reason,
            },
            "character_motion_fidelity": {
                "passed": motion_result.passed,
                "reason": motion_result.reason,
            },
        },
    }


def _default_baseline_path() -> Path:
    return Path(__file__).parent / _BASELINE_FILENAME


def load_character_arm_c_baseline(path: Path | str | None = None) -> frozenset[str]:
    """Load the set of documented pre-existing CHR-1 gaps (T-0258 item 5,
    option (b)) -- character sidecars committed before CHR-1 existed, not
    backfilled here.  `sweep_character_arm_c_provenance` exempts exactly
    these paths; anything not listed here still fails the gate.
    """
    baseline_path = Path(path) if path is not None else _default_baseline_path()
    if not baseline_path.is_file():
        return frozenset()
    return frozenset(
        line.strip()
        for line in baseline_path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    )


def sweep_character_arm_c_provenance(
    root: Path | str, baseline: frozenset[str] = frozenset()
) -> list[CheckResult]:
    """Run `check_character_arm_c_provenance` against every `*.provenance.json`
    under *root*, scoped to the `character` asset class (CHR-1's own scope).

    Writer-agnostic, same shape as the other sweeps in this package: reads
    the sidecars that actually landed in the repo, so a gap in any writer is
    caught here regardless of which script produced it.

    Args:
        root: directory to search recursively (e.g. `assets/final`). Asset
            class is read from each sidecar's path relative to *root* --
            pass a root whose immediate subdirectories are the asset
            classes (`character/`, `props/`, `tiles/`, ...), not a directory
            already scoped to `character/` itself.
        baseline: paths (relative to *root*, forward-slashed) allowed to
            keep failing -- documented pre-existing gaps (see
            `load_character_arm_c_baseline`). Anything not in *baseline*
            must pass.
    """
    root_path = Path(root)
    results = []
    for path in sorted(root_path.rglob("*.provenance.json")):
        rel = path.relative_to(root_path)
        rel_str = rel.as_posix()
        cls = asset_class(rel)

        if cls != CHARACTER_CLASS:
            results.append(
                CheckResult(
                    check="character_arm_c_provenance",
                    passed=True,
                    reason=(
                        f"{rel_str}: asset class {cls!r} is not character -- CHR-1 does not apply"
                    ),
                    details={"path": rel_str, "asset_class": cls, "skipped": True},
                )
            )
            continue

        provenance = json.loads(path.read_text())
        single = check_character_arm_c_provenance(provenance, sheet_name=rel_str)

        if not single.passed and rel_str in baseline:
            results.append(
                CheckResult(
                    check="character_arm_c_provenance",
                    passed=True,
                    reason=f"{single.reason} [baseline-exempt: predates CHR-1, T-0258]",
                    details={**single.details, "path": rel_str, "baseline_exempt": True},
                )
            )
            continue

        results.append(
            CheckResult(
                check="character_arm_c_provenance",
                passed=single.passed,
                reason=single.reason,
                details={**single.details, "path": rel_str},
            )
        )
    return results


def sweep_character_frame_delta_cap(
    root: Path | str, baseline: frozenset[str] = frozenset()
) -> list[CheckResult]:
    """Run `check_character_frame_delta_cap` against every `*.provenance.json`
    under *root*, scoped to the `character` asset class -- the T-0271/DL-26
    motion-class-aware cap's actual enforcement path.

    Same shape and scope as `sweep_character_arm_c_provenance`, and reuses
    that check's baseline idiom: a sidecar predating CHR-1 has no
    `frame_delta_range` at all (there is no cap to evaluate it against), so
    it is exempted by the same `character_arm_c_baseline.txt` list, not a
    second one -- the two sweeps share exactly the same set of pre-CHR-1
    gaps by construction.

    Args:
        root: directory to search recursively (e.g. `assets/final`). Asset
            class is read from each sidecar's path relative to *root* --
            pass a root whose immediate subdirectories are the asset
            classes (`character/`, `props/`, `tiles/`, ...), not a directory
            already scoped to `character/` itself.
        baseline: paths (relative to *root*, forward-slashed) allowed to
            keep failing -- documented pre-existing gaps (see
            `load_character_arm_c_baseline`). Anything not in *baseline*
            must pass.
    """
    root_path = Path(root)
    results = []
    for path in sorted(root_path.rglob("*.provenance.json")):
        rel = path.relative_to(root_path)
        rel_str = rel.as_posix()
        cls = asset_class(rel)

        if cls != CHARACTER_CLASS:
            results.append(
                CheckResult(
                    check="character_frame_delta_cap",
                    passed=True,
                    reason=(
                        f"{rel_str}: asset class {cls!r} is not character -- "
                        "the motion-class frame-delta cap does not apply"
                    ),
                    details={"path": rel_str, "asset_class": cls, "skipped": True},
                )
            )
            continue

        provenance = json.loads(path.read_text())
        single = check_character_frame_delta_cap(provenance, sheet_name=rel_str)

        if not single.passed and rel_str in baseline:
            results.append(
                CheckResult(
                    check="character_frame_delta_cap",
                    passed=True,
                    reason=f"{single.reason} [baseline-exempt: predates CHR-1, T-0258]",
                    details={**single.details, "path": rel_str, "baseline_exempt": True},
                )
            )
            continue

        results.append(
            CheckResult(
                check="character_frame_delta_cap",
                passed=single.passed,
                reason=single.reason,
                details={**single.details, "path": rel_str},
            )
        )
    return results


def check_character_motion_fidelity(provenance: dict, sheet_name: str = "<sheet>") -> CheckResult:
    """Fail if a locomotion/transition/loop character sheet's
    `pose_fidelity_range` lower bound is below `POSE_FIDELITY_IOU_FLOOR`, or
    its `identity_stability_range` upper bound is above
    `IDENTITY_STABILITY_HISTOGRAM_CAP` (T-0340, docs/decision-log.md DL-31 --
    the replacement for the retired whole-silhouette XOR/union cap; see this
    module's docstring).

    `idle` (and anything missing or unrecognised) is out of scope for this
    check entirely -- it stays on `check_character_frame_delta_cap`'s
    XOR/union path, unchanged, so this returns a not-applicable pass for
    those. Mirrors `check_character_frame_delta_cap`'s own shape: reads
    `motion_class` from the sidecar itself, checks presence/shape before
    evaluating, and never touches CHR-1's own fields.

    Args:
        provenance: dict loaded from a `.provenance.json` sidecar.
        sheet_name: identifies the sheet in the failure message.

    Returns:
        `CheckResult` with `passed=True` iff `motion_class` is not one of
        locomotion/transition/loop (skipped), or both `pose_fidelity_range`
        and `identity_stability_range` are present, well-formed, and clear
        their respective floor/cap.
    """
    motion_class = provenance.get("motion_class")
    if motion_class not in _HIGHER_CAP_MOTION_CLASSES:
        return CheckResult(
            check="character_motion_fidelity",
            passed=True,
            reason=(
                f"{sheet_name}: motion_class={motion_class!r} is not locomotion/transition/loop "
                "-- the pose-fidelity/identity-stability gate does not apply "
                "(idle keeps the XOR/union cap instead)"
            ),
            details={"motion_class": motion_class, "skipped": True},
        )

    missing: list[str] = []

    pose_fidelity_range = provenance.get("pose_fidelity_range", _MISSING)
    if pose_fidelity_range is _MISSING or not _is_well_formed_range(pose_fidelity_range):
        missing.append("pose_fidelity_range")

    identity_stability_range = provenance.get("identity_stability_range", _MISSING)
    if identity_stability_range is _MISSING or not _is_well_formed_range(identity_stability_range):
        missing.append("identity_stability_range")

    if missing:
        return CheckResult(
            check="character_motion_fidelity",
            passed=False,
            reason=(
                f"{sheet_name} is missing or has a malformed motion-fidelity field(s): "
                f"{', '.join(missing)} -- every locomotion/transition/loop character output "
                "must record both pose_fidelity_range and identity_stability_range (T-0340)"
            ),
            details={"missing": missing},
        )

    pose_lo, _pose_hi = pose_fidelity_range
    _identity_lo, identity_hi = identity_stability_range
    pose_ok = pose_lo >= POSE_FIDELITY_IOU_FLOOR
    identity_ok = identity_hi <= IDENTITY_STABILITY_HISTOGRAM_CAP
    passed = pose_ok and identity_ok

    return CheckResult(
        check="character_motion_fidelity",
        passed=passed,
        reason=(
            f"{sheet_name}: motion_class={motion_class!r} pose-fidelity IoU floor "
            f"{pose_lo:.4f} {'>=' if pose_ok else '<'} {POSE_FIDELITY_IOU_FLOOR}, "
            f"identity-stability distance {identity_hi:.4f} "
            f"{'<=' if identity_ok else '>'} {IDENTITY_STABILITY_HISTOGRAM_CAP}"
        ),
        details={
            "pose_fidelity_range": pose_fidelity_range,
            "identity_stability_range": identity_stability_range,
            "pose_ok": pose_ok,
            "identity_ok": identity_ok,
        },
    )


def sweep_character_motion_fidelity(
    root: Path | str, baseline: frozenset[str] = frozenset()
) -> list[CheckResult]:
    """Run `check_character_motion_fidelity` against every `*.provenance.json`
    under *root*, scoped to the `character` asset class -- the enforcement
    path for T-0340's replacement gate.

    Same shape and scope as `sweep_character_frame_delta_cap`. No existing
    committed sidecar records `pose_fidelity_range`/`identity_stability_range`
    (the fields are new in this card) or a locomotion/transition/loop
    `motion_class` at all, so this sweep has nothing to baseline-exempt yet
    -- the parameter is accepted for shape-parity with the other sweeps in
    this module, not because a real gap exists today.

    Args:
        root: directory to search recursively (e.g. `assets/final`). Asset
            class is read from each sidecar's path relative to *root* --
            pass a root whose immediate subdirectories are the asset
            classes (`character/`, `props/`, `tiles/`, ...), not a directory
            already scoped to `character/` itself.
        baseline: paths (relative to *root*, forward-slashed) allowed to
            keep failing -- see `check_character_arm_c_provenance`'s own
            baseline idiom. Anything not in *baseline* must pass.
    """
    root_path = Path(root)
    results = []
    for path in sorted(root_path.rglob("*.provenance.json")):
        rel = path.relative_to(root_path)
        rel_str = rel.as_posix()
        cls = asset_class(rel)

        if cls != CHARACTER_CLASS:
            results.append(
                CheckResult(
                    check="character_motion_fidelity",
                    passed=True,
                    reason=(
                        f"{rel_str}: asset class {cls!r} is not character -- "
                        "the pose-fidelity/identity-stability gate does not apply"
                    ),
                    details={"path": rel_str, "asset_class": cls, "skipped": True},
                )
            )
            continue

        provenance = json.loads(path.read_text())
        single = check_character_motion_fidelity(provenance, sheet_name=rel_str)

        if not single.passed and rel_str in baseline:
            results.append(
                CheckResult(
                    check="character_motion_fidelity",
                    passed=True,
                    reason=f"{single.reason} [baseline-exempt]",
                    details={**single.details, "path": rel_str, "baseline_exempt": True},
                )
            )
            continue

        results.append(
            CheckResult(
                check="character_motion_fidelity",
                passed=single.passed,
                reason=single.reason,
                details={**single.details, "path": rel_str},
            )
        )
    return results


# ---- T-0357: motion_class must be a validated declaration, not an absence ----


def check_character_motion_class_declared(
    provenance: dict, sheet_name: str = "<sheet>"
) -> CheckResult:
    """Fail unless `motion_class` is present and one of `KNOWN_MOTION_CLASSES`
    (T-0357, Codex review 2026-09-11 finding 2).

    Before this check, a missing or unrecognised `motion_class` silently
    rode the same skip/pass path `idle` legitimately uses in both
    `check_character_frame_delta_cap` and `check_character_motion_fidelity`
    -- correct fail-closed defaults for THOSE two checks (an unlabelled
    sheet must keep the strict cap, never the permissive one), but it meant
    nothing anywhere ever required a new asset to actually declare what it
    is. This is that requirement, kept as its own check rather than folded
    into either of the above, so a sheet can fail it while still legitimately
    being skipped by (or passing) the frame-delta or motion-fidelity checks.
    """
    motion_class = provenance.get("motion_class")
    if motion_class in KNOWN_MOTION_CLASSES:
        return CheckResult(
            check="character_motion_class_declared",
            passed=True,
            reason=f"{sheet_name}: motion_class={motion_class!r} is a recognised classification",
            details={"motion_class": motion_class},
        )

    if motion_class is None:
        reason = (
            f"{sheet_name} has no motion_class recorded -- every character-generation "
            "output must declare one (T-0357)"
        )
    else:
        reason = (
            f"{sheet_name}: motion_class={motion_class!r} is not a recognised classification "
            f"(expected one of {sorted(KNOWN_MOTION_CLASSES)}) (T-0357)"
        )
    return CheckResult(
        check="character_motion_class_declared",
        passed=False,
        reason=reason,
        details={"motion_class": motion_class},
    )


def sweep_character_motion_class_declared(
    root: Path | str, baseline: frozenset[str] = frozenset()
) -> list[CheckResult]:
    """Run `check_character_motion_class_declared` against every
    `*.provenance.json` under *root*, scoped to the `character` asset class
    -- same shape/scope/baseline idiom as the other sweeps in this module.

    Args:
        root: directory to search recursively (e.g. `assets/final`).
        baseline: paths (relative to *root*, forward-slashed) allowed to
            keep failing -- documented pre-T-0357 gaps, see
            `load_character_motion_class_baseline`. Anything not in
            *baseline* must declare a known motion_class.
    """
    root_path = Path(root)
    results = []
    for path in sorted(root_path.rglob("*.provenance.json")):
        rel = path.relative_to(root_path)
        rel_str = rel.as_posix()
        cls = asset_class(rel)

        if cls != CHARACTER_CLASS:
            results.append(
                CheckResult(
                    check="character_motion_class_declared",
                    passed=True,
                    reason=(
                        f"{rel_str}: asset class {cls!r} is not character -- "
                        "motion_class declaration is not required"
                    ),
                    details={"path": rel_str, "asset_class": cls, "skipped": True},
                )
            )
            continue

        provenance = json.loads(path.read_text())
        single = check_character_motion_class_declared(provenance, sheet_name=rel_str)

        if not single.passed and rel_str in baseline:
            results.append(
                CheckResult(
                    check="character_motion_class_declared",
                    passed=True,
                    reason=(
                        f"{single.reason} "
                        "[baseline-exempt: predates T-0357 motion-class enforcement]"
                    ),
                    details={**single.details, "path": rel_str, "baseline_exempt": True},
                )
            )
            continue

        results.append(
            CheckResult(
                check="character_motion_class_declared",
                passed=single.passed,
                reason=single.reason,
                details={**single.details, "path": rel_str},
            )
        )
    return results


def _default_motion_class_baseline_path() -> Path:
    return Path(__file__).parent / _MOTION_CLASS_BASELINE_FILENAME


def load_character_motion_class_baseline(path: Path | str | None = None) -> frozenset[str]:
    """Load the set of documented pre-T-0357 motion-class gaps -- character
    sidecars committed before this card's enforcement existed, with no
    motion_class opinion recorded at all. `sweep_character_motion_class_declared`
    exempts exactly these paths; anything not listed here (including
    `player_walk_sheet_hybrid.provenance.json`, deliberately excluded) must
    declare a known motion_class.
    """
    baseline_path = Path(path) if path is not None else _default_motion_class_baseline_path()
    if not baseline_path.is_file():
        return frozenset()
    return frozenset(
        line.strip()
        for line in baseline_path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    )


# ---- T-0357: recompute pose-fidelity/identity-stability live from pixels ----


def _load_rig_keypoints(path: Path) -> dict[int, tuple[float, float]]:
    """Parse a committed per-frame rig-keypoints JSON file (the same shape
    `keypoints_to_coco_list` in `assets/src/character/pose_rig_walk_T0259.py`
    writes: a list of `{"joint": i, "x": ..., "y": ...}` objects) into the
    `{joint: (x, y)}` mapping `render_rig_silhouette`'s caller needs."""
    data = json.loads(path.read_text())
    return {int(item["joint"]): (float(item["x"]), float(item["y"])) for item in data}


def _rig_limbs_px(
    points_norm: dict[int, tuple[float, float]], cell_px: int
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    return [
        (
            (points_norm[a][0] * cell_px, points_norm[a][1] * cell_px),
            (points_norm[b][0] * cell_px, points_norm[b][1] * cell_px),
        )
        for a, b in RIG_LIMB_JOINT_PAIRS
    ]


def _torso_region_px(cell_px: int) -> tuple[int, int, int, int]:
    xs = [pt[0] for pt in TORSO_ANCHOR_POINTS_NORM.values()]
    ys = [pt[1] for pt in TORSO_ANCHOR_POINTS_NORM.values()]
    return (
        round(min(xs) * cell_px),
        round(min(ys) * cell_px),
        round(max(xs) * cell_px),
        round(max(ys) * cell_px),
    )


def _missing_rig_evidence_reason(provenance: dict) -> str | None:
    """None iff `provenance` records enough to recompute pose-fidelity/
    identity-stability from pixels: a declared `layout` (cols/rows/cell_px,
    all ints) and one `frame_generation` entry per frame. Otherwise, a
    human-readable reason naming exactly what is missing or malformed, for
    use in a failing `CheckResult.reason` (T-0357 Codex PR review 2026-09-11,
    P1: missing/malformed rig evidence on a locomotion/transition/loop asset
    must FAIL naming the gap, never silently fall back to trusting the
    sidecar's own self-reported scores). Does not check that each
    `frame_generation` entry actually names a resolvable
    `pose_keypoints_file` -- that failure is reported per-frame, with a
    specific reason, by `_recompute_motion_fidelity_from_frames`."""
    layout = provenance.get("layout")
    if not isinstance(layout, dict):
        return "no 'layout' is declared"
    cols, rows, cell_px = layout.get("cols"), layout.get("rows"), layout.get("cell_px")
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (cols, rows, cell_px)):
        return "'layout' is missing or has non-integer cols/rows/cell_px"
    frame_generation = provenance.get("frame_generation")
    if not isinstance(frame_generation, list):
        return "no 'frame_generation' is declared"
    expected = cols * rows
    if len(frame_generation) != expected:
        return (
            f"'frame_generation' has {len(frame_generation)} entries but 'layout' declares "
            f"{cols}x{rows} = {expected} frames"
        )
    return None


def _recompute_motion_fidelity_from_frames(
    frames: list[Image.Image],
    provenance: dict,
    *,
    cell_px: int,
    repo_root: Path | str,
    background_index: int,
    sheet_name: str,
) -> CheckResult:
    """The actual recomputation: render each frame's rig-predicted
    silhouette from its own versioned keypoints file, compare against that
    frame's real pixels, then run `check_character_motion_fidelity` against
    the values just measured -- never whatever the sidecar itself recorded.
    Caller (`determine_character_motion_fidelity`) has already established
    `motion_class` is one of the higher-cap classes and rig evidence exists.
    """
    motion_class = provenance["motion_class"]
    repo_root_path = Path(repo_root)
    frame_generation = provenance["frame_generation"]

    if len(frame_generation) != len(frames):
        return CheckResult(
            check="character_motion_fidelity",
            passed=False,
            reason=(
                f"{sheet_name}: 'frame_generation' has {len(frame_generation)} entries but the "
                f"sheet was sliced into {len(frames)} frames -- cannot pair each frame with its "
                "versioned rig keypoints"
            ),
            details={
                "frame_generation_count": len(frame_generation),
                "frame_count": len(frames),
            },
        )

    pose_ious: list[float] = []
    for i, (frame, frame_info) in enumerate(zip(frames, frame_generation, strict=True)):
        rel_keypoints = (
            frame_info.get("pose_keypoints_file") if isinstance(frame_info, dict) else None
        )
        if not rel_keypoints:
            return CheckResult(
                check="character_motion_fidelity",
                passed=False,
                reason=(
                    f"{sheet_name}: frame {i} has no 'pose_keypoints_file' -- cannot resolve "
                    "its versioned rig input to recompute pose-fidelity"
                ),
                details={"frame_index": i},
            )
        keypoints_path = repo_root_path / rel_keypoints
        if not keypoints_path.is_file():
            return CheckResult(
                check="character_motion_fidelity",
                passed=False,
                reason=(
                    f"{sheet_name}: frame {i}'s rig keypoints file {rel_keypoints!r} does not "
                    f"exist under repo_root {repo_root_path}"
                ),
                details={"frame_index": i, "pose_keypoints_file": rel_keypoints},
            )
        points = _load_rig_keypoints(keypoints_path)
        predicted = art.render_rig_silhouette(
            size=cell_px,
            limbs=_rig_limbs_px(points, cell_px),
            radius=MOTION_FIDELITY_CAPSULE_RADIUS_PX,
        )
        # min_iou=0.0: only the per-frame IoU itself is used (aggregated into
        # pose_fidelity_range below); the real floor is applied once, on the
        # aggregate range, by check_character_motion_fidelity -- mirrors
        # calibrate_motion_fidelity_T0340.py's own calibration usage.
        result = art.check_pose_fidelity(
            frame, predicted, background_index=background_index, min_iou=0.0
        )
        pose_ious.append(result.details["iou"])

    torso_region = _torso_region_px(cell_px)
    identity_distances: list[float] = []
    pairs = [(i, i + 1) for i in range(len(frames) - 1)] + [(len(frames) - 1, 0)]
    for a, b in pairs:
        # max_histogram_distance=1.0: only the per-pair distance itself is
        # used (aggregated into identity_stability_range below); the real
        # cap is applied once, on the aggregate range, by
        # check_character_motion_fidelity.
        result = art.check_identity_stability(
            frames[a],
            frames[b],
            background_index=background_index,
            region=torso_region,
            max_histogram_distance=1.0,
        )
        identity_distances.append(result.details["distance"])

    recomputed = {
        "motion_class": motion_class,
        "pose_fidelity_range": [min(pose_ious), max(pose_ious)],
        "identity_stability_range": [min(identity_distances), max(identity_distances)],
    }
    verdict = check_character_motion_fidelity(recomputed, sheet_name=sheet_name)
    return CheckResult(
        check=verdict.check,
        passed=verdict.passed,
        reason=(
            f"{verdict.reason} [recomputed live from the sheet's own pixels + versioned rig "
            "keypoints, not the sidecar's recorded range]"
        ),
        details={
            **verdict.details,
            "recomputed_from_pixels": True,
            "rig_config_version": RIG_CONFIG_VERSION,
        },
    )


def determine_character_motion_fidelity(
    provenance: dict,
    *,
    frames: list[Image.Image] | None = None,
    cell_px: int | None = None,
    sheet: Image.Image | None = None,
    sheet_path: Path | str | None = None,
    repo_root: Path | str = ".",
    background_index: int = 0,
    sheet_name: str = "<sheet>",
) -> CheckResult:
    """The authoritative T-0357 motion-fidelity determination (Codex review
    2026-09-11 finding 3, and the 2026-09-11 PR review's P1 fix): recompute
    pose-fidelity/identity-stability LIVE from the sheet's own pixels and its
    versioned rig keypoints whenever `motion_class` is locomotion/transition/
    loop -- a recomputed result always overrides whatever range the sidecar
    itself records, so a stale sidecar score cannot survive the sheet's own
    PNG changing underneath it.

    A locomotion/transition/loop asset that does not record enough to
    recompute from (missing `layout`, missing `frame_generation`, or a frame
    count that does not match the declared layout) FAILS, with a reason
    naming exactly what evidence is missing -- it never falls back to
    trusting the sidecar's own self-reported `pose_fidelity_range`/
    `identity_stability_range`. (The PR review's P1 finding: that fallback
    let a brand-new, fully transparent sheet with self-reported perfect
    scores pass every check.)

    `idle` (and missing/unrecognised motion_class) is unaffected -- see
    `check_character_motion_fidelity`'s own docstring; a validated
    classification is `check_character_motion_class_declared`'s job, not
    this function's.

    Args:
        frames: already-sliced per-cell frames, if the caller has them
            (`build_character_gate_report` does) -- skips re-opening/
            re-slicing the sheet. `cell_px` must be supplied alongside it.
        sheet / sheet_path: how to obtain the sheet when `frames` is not
            already available (a whole-tree sweep only has a path). `sheet`
            takes priority if both are given.
    """
    motion_class = provenance.get("motion_class")
    if motion_class not in _HIGHER_CAP_MOTION_CLASSES:
        return check_character_motion_fidelity(provenance, sheet_name=sheet_name)

    missing_reason = _missing_rig_evidence_reason(provenance)
    if missing_reason is not None:
        return CheckResult(
            check="character_motion_fidelity",
            passed=False,
            reason=(
                f"{sheet_name}: motion_class={motion_class!r} requires recomputing "
                "pose-fidelity/identity-stability from the sheet's own pixels + versioned rig "
                f"evidence, but {missing_reason} -- a locomotion/transition/loop asset must never "
                "fall back to trusting the sidecar's own self-reported scores (T-0357 Codex PR "
                "review 2026-09-11, P1)"
            ),
            details={"motion_class": motion_class, "missing_rig_evidence": missing_reason},
        )

    layout = provenance["layout"]
    resolved_cell_px = cell_px if cell_px is not None else layout["cell_px"]

    if frames is None:
        cols, rows = layout["cols"], layout["rows"]
        if sheet is None:
            if sheet_path is None or not Path(sheet_path).is_file():
                return CheckResult(
                    check="character_motion_fidelity",
                    passed=False,
                    reason=(
                        f"{sheet_name}: motion_class={motion_class!r} declares a recomputable "
                        f"rig but the sheet image ({sheet_path or '<no path given>'}) does not "
                        "exist -- cannot recompute pose-fidelity/identity-stability from pixels"
                    ),
                    details={"missing_image": str(sheet_path) if sheet_path else None},
                )
            sheet = Image.open(sheet_path)
        try:
            frames = art.slice_sheet_frames(sheet, resolved_cell_px, resolved_cell_px, cols, rows)
        except ValueError as exc:
            return CheckResult(
                check="character_motion_fidelity",
                passed=False,
                reason=(
                    f"{sheet_name}: cannot slice the sheet into its declared "
                    f"{cols}x{rows} grid: {exc}"
                ),
                details={"layout": layout},
            )

    return _recompute_motion_fidelity_from_frames(
        frames,
        provenance,
        cell_px=resolved_cell_px,
        repo_root=repo_root,
        background_index=background_index,
        sheet_name=sheet_name,
    )


def sweep_character_gate(
    root: Path | str,
    *,
    repo_root: Path | str = ".",
    baseline: frozenset[str] = frozenset(),
    motion_class_baseline: frozenset[str] = frozenset(),
) -> list[CheckResult]:
    """The single authoritative character validator (T-0357, Codex review
    2026-09-11 finding 1): every character-class `*.provenance.json` under
    *root* must pass CHR-1 presence, the idle-class frame-delta cap, a
    validated `motion_class` declaration, and -- recomputed live from the
    sheet's own PNG whenever rig evidence permits it -- pose-fidelity/
    identity-stability.

    This is the union of `sweep_character_arm_c_provenance`,
    `sweep_character_frame_delta_cap`, `sweep_character_motion_class_declared`
    and `determine_character_motion_fidelity` -- the one function the
    `character-gate` CLI subcommand exposes, and the one both
    `ci-asset-gate.yml` and the board's reviewer route invoke, so there is
    exactly one enforcement path instead of two that can silently drift
    apart (this card's own motivating gap: T-0340's motion-fidelity sweep
    existed and was unit-tested, but no workflow anywhere ever called it).

    Args:
        root: directory whose subdirectories are asset classes (e.g.
            `assets/final`).
        repo_root: repository root used to resolve each frame's versioned
            rig-keypoints file (`frame_generation[i].pose_keypoints_file`).
        baseline: paths (relative to *root*) exempt from CHR-1 presence and
            the idle frame-delta cap -- see `load_character_arm_c_baseline`.
        motion_class_baseline: paths (relative to *root*) exempt from the
            motion_class declaration requirement -- see
            `load_character_motion_class_baseline`.
    """
    root_path = Path(root)
    results: list[CheckResult] = []

    for path in sorted(root_path.rglob("*.provenance.json")):
        rel = path.relative_to(root_path)
        rel_str = rel.as_posix()
        cls = asset_class(rel)

        if cls != CHARACTER_CLASS:
            results.append(
                CheckResult(
                    check="character_gate",
                    passed=True,
                    reason=(
                        f"{rel_str}: asset class {cls!r} is not character -- "
                        "the character gate does not apply"
                    ),
                    details={"path": rel_str, "asset_class": cls, "skipped": True},
                )
            )
            continue

        provenance = json.loads(path.read_text())

        arm_c = check_character_arm_c_provenance(provenance, sheet_name=rel_str)
        if not arm_c.passed and rel_str in baseline:
            arm_c = CheckResult(
                check=arm_c.check,
                passed=True,
                reason=f"{arm_c.reason} [baseline-exempt: predates CHR-1, T-0258]",
                details={**arm_c.details, "baseline_exempt": True},
            )
        results.append(
            CheckResult(
                check=arm_c.check,
                passed=arm_c.passed,
                reason=arm_c.reason,
                details={**arm_c.details, "path": rel_str},
            )
        )

        cap = check_character_frame_delta_cap(provenance, sheet_name=rel_str)
        if not cap.passed and rel_str in baseline:
            cap = CheckResult(
                check=cap.check,
                passed=True,
                reason=f"{cap.reason} [baseline-exempt: predates CHR-1, T-0258]",
                details={**cap.details, "baseline_exempt": True},
            )
        results.append(
            CheckResult(
                check=cap.check,
                passed=cap.passed,
                reason=cap.reason,
                details={**cap.details, "path": rel_str},
            )
        )

        declared = check_character_motion_class_declared(provenance, sheet_name=rel_str)
        if not declared.passed and rel_str in motion_class_baseline:
            declared = CheckResult(
                check=declared.check,
                passed=True,
                reason=(
                    f"{declared.reason} [baseline-exempt: predates T-0357 motion-class enforcement]"
                ),
                details={**declared.details, "baseline_exempt": True},
            )
        results.append(
            CheckResult(
                check=declared.check,
                passed=declared.passed,
                reason=declared.reason,
                details={**declared.details, "path": rel_str},
            )
        )

        image_path = path.with_name(path.name[: -len(".provenance.json")] + ".png")
        fidelity = determine_character_motion_fidelity(
            provenance, sheet_path=image_path, repo_root=repo_root, sheet_name=rel_str
        )
        results.append(
            CheckResult(
                check=fidelity.check,
                passed=fidelity.passed,
                reason=fidelity.reason,
                details={**fidelity.details, "path": rel_str},
            )
        )

    return results
