#!/usr/bin/env python3
"""Independent per-part SAM3 cutouts for the parts compositor (T-0417).

T-0337's FIX ROUND 2 put valid hip/knee/ankle-derived points on the "legs"
panel, but Chat's round-3 re-review of #419 (`c5d07fcc`) found all six
positive points went into ONE `positive_coords` list through ONE
`SAM3_Detect` call: "These are constraints on one segmentation, not six
separately identified part requests." This module is the structural fix:
a bounded, explicit set of SEPARATE part requests -- each with its own
single positive point on that part and its own negative points on every
sibling part -- each destined for its OWN `SAM3_Detect` call, with
part-labelled masks/counts/descended-PNGs/provenance throughout, so a part
is addressable by name (`legs/right_upper_leg`, etc.) without re-deriving it
from a whole-figure mask.

**Scope, per the card's own acceptance:** only the "legs" panel gets a part
decomposition -- it is the panel the round-3 review actually flagged (both
complete legs still joined, plus stray fragments). The five whole-figure
panels (front/back T-pose, both side-forward, side-neutral) are not parts
panels and are not forced through decomposition; `PARTS_BY_PANEL` makes that
explicit rather than leaving it implicit in which functions get called.
T-0337's own whole-figure comparison (`gen_master_sheet_cutout_compare_T0337.py`,
`docs/assets/evidence/T-0337/`) is untouched by this module -- preserved as
supporting evidence of that separate experiment, never re-presented as the
part result.

**No Oklab fallback for a part request.** `char_gen.cutout_sam3.cut_master_sheet_part`'s
sam3->oklab fallback is a whole-image, content-based flood; it has no notion
of "this specific limb segment" and substituting it per-part would not
produce a part-labelled cutout, only relabel a whole-figure flood as if it
were one. If SAM3 is unavailable, this module reports the prerequisite and
performs no part decomposition at all -- same shape as
`gen_master_sheet_cutout_compare_T0337.main`'s own availability
short-circuit, never a silent substitute model.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/character/gen_master_sheet_part_cutouts_T0417.py [--part PART_KEY]

Writes (per part, when SAM3 is available):
    docs/assets/evidence/T-0417/panel_legs_part_{part}_sam3_after.png
    docs/assets/evidence/T-0417/panel_legs_part_{part}_prompts.json
    docs/assets/evidence/T-0417/panel_legs_part_{part}_descended.png (+.provenance.json,
        only when the part is present -- see PartResult.present)
    docs/assets/evidence/T-0417/part_comparison.json
"""

from __future__ import annotations

import itertools
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parent
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(REPO_ROOT / "tools" / "gen-client-base" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

import gen_master_sheet_cutout_compare_T0337 as compare_t0337  # noqa: E402
import pose_rig_master_sheet_T0351 as rig  # noqa: E402
from asset_gate.palette import load_palette  # noqa: E402

if TYPE_CHECKING:
    from comfy_client.comfyui_client import ComfyUIClient

from char_gen.cutout_sam3 import (  # noqa: E402
    Sam3SegmentationUnavailable,
    build_sam3_part_workflow,
    mask_png_bytes_to_bool_array,
)
from char_gen.part_descend import box_descend_part  # noqa: E402
from char_gen.part_isolation import (  # noqa: E402
    PART_OVERLAP_FRACTION_TOLERANCE,
    PART_OVERLAP_FRACTION_TOLERANCE_NON_ADJACENT,
    exceeds_stray_fraction_tolerance,
    is_part_mask_degenerate,
    keep_components_containing_points,
    mask_overlap_fraction,
)
from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

# ── Reused, unmodified, from T-0337's own module -- panel geometry, joint
# indices and the sam3 loader/availability plumbing are shared facts about
# this master sheet and this ComfyUI host, not business logic this card
# should duplicate or drift from. ────────────────────────────────────────
COMFY_BASE_URL = compare_t0337.COMFY_BASE_URL
SHEET_PATH = compare_t0337.SHEET_PATH
PANEL_SIZE = compare_t0337.PANEL_SIZE
PANEL_KEYS = compare_t0337.PANEL_KEYS
PALETTE_PATH = compare_t0337.PALETTE_PATH
SAM3_UNET_CHECKPOINT = compare_t0337.SAM3_UNET_CHECKPOINT
_NECK = compare_t0337._NECK
_R_HIP, _R_KNEE, _R_ANKLE = compare_t0337._R_HIP, compare_t0337._R_KNEE, compare_t0337._R_ANKLE
_L_HIP, _L_KNEE, _L_ANKLE = compare_t0337._L_HIP, compare_t0337._L_KNEE, compare_t0337._L_ANKLE
_LEGS_ONLY_PANEL_KEYS = compare_t0337._LEGS_ONLY_PANEL_KEYS
_px = compare_t0337._px
_midpoint = compare_t0337._midpoint
_sam3_model_loader = compare_t0337._sam3_model_loader
_panel_crop = compare_t0337._panel_crop
_probe_sam3_availability = compare_t0337._probe_sam3_availability
_png_bytes = compare_t0337._png_bytes

EVIDENCE_DIR = REPO_ROOT / "docs" / "assets" / "evidence" / "T-0417"
GENERATOR_PATH = "assets/src/character/gen_master_sheet_part_cutouts_T0417.py"


@dataclass(frozen=True)
class PartSpec:
    """One anatomical part's own derivation rule: its positive anchor is
    `joint_a` alone (`joint_b is None`, e.g. a boot at the ankle) or the
    midpoint of `joint_a`/`joint_b` (e.g. an upper leg at hip-knee)."""

    part_key: str
    side: str
    label: str
    joint_a: int
    joint_b: int | None


def _build_legs_part_specs() -> tuple[PartSpec, ...]:
    """Bounded, explicit, one rule for both sides -- not six independently
    hand-typed specs. A rig change to the hip/knee/ankle indices moves both
    sides identically because both are generated from the same loop over
    the same `(hip, knee, ankle)` triples, mirroring
    `gen_master_sheet_cutout_compare_T0337.panel_prompt_points`'s own
    `for side, hip_idx, knee_idx, ankle_idx in (...)` construction for the
    legs-only panel."""
    specs: list[PartSpec] = []
    for side, hip_idx, knee_idx, ankle_idx in (
        ("right", _R_HIP, _R_KNEE, _R_ANKLE),
        ("left", _L_HIP, _L_KNEE, _L_ANKLE),
    ):
        specs.append(PartSpec(f"{side}_upper_leg", side, "upper_leg", hip_idx, knee_idx))
        specs.append(PartSpec(f"{side}_lower_leg", side, "lower_leg", knee_idx, ankle_idx))
        specs.append(PartSpec(f"{side}_boot", side, "boot", ankle_idx, None))
    return tuple(specs)


_LEGS_PART_SPECS: tuple[PartSpec, ...] = _build_legs_part_specs()
_LEGS_PART_SPECS_BY_KEY: dict[str, PartSpec] = {spec.part_key: spec for spec in _LEGS_PART_SPECS}

#: Explicit, bounded, per-panel part sets -- "the set of parts per panel is
#: explicit" (card's own edge-case wording). A panel absent from this dict
#: (every whole-figure panel) is never forced through part decomposition;
#: `.get(key, ())` is how callers read that.
PARTS_BY_PANEL: dict[str, tuple[str, ...]] = {
    "legs": tuple(spec.part_key for spec in _LEGS_PART_SPECS),
}

#: Adjacent, anatomically-sharing-a-joint part pairs per panel -- the pairs
#: the 0.25 joint-blur allowance (`PART_OVERLAP_FRACTION_TOLERANCE`) is
#: actually meaningful for (thigh/lower-leg share the knee, lower-leg/boot
#: share the ankle).
#:
#: [FIX ROUND finding 3] This list used to be the ONLY pairs
#: `_evaluate_overlaps` checked -- cross-side pairs and upper_leg/boot were
#: excluded as "never physically adjacent," which is exactly the assumption
#: a failed segmentation violates: two independent SAM3 requests can both
#: return (near-)identical masks for the same limb (e.g. right_upper_leg
#: and left_upper_leg), and nothing ever compared them. `_evaluate_overlaps`
#: now evaluates every distinct pair of PRESENT parts in the panel; this
#: dict now only decides which pairs get the joint-blur tolerance --
#: every other pair gets `PART_OVERLAP_FRACTION_TOLERANCE_NON_ADJACENT`
#: (zero) instead, so a pair with no anatomical reason to touch is never
#: silently skipped again.
SIBLING_PART_PAIRS_BY_PANEL: dict[str, tuple[tuple[str, str], ...]] = {
    "legs": tuple(
        (f"{side}_upper_leg", f"{side}_lower_leg") for side in ("right", "left")
    )
    + tuple((f"{side}_lower_leg", f"{side}_boot") for side in ("right", "left")),
}


def _part_anchor_norm(spec: PartSpec, points_norm: dict[int, tuple[float, float]]):
    a = points_norm[spec.joint_a]
    if spec.joint_b is None:
        return a
    return _midpoint(a, points_norm[spec.joint_b])


def part_prompt_points(
    panel_key: str,
    part_key: str,
    points_norm: dict[int, tuple[float, float]],
    panel_size: int = PANEL_SIZE,
) -> list[dict]:
    """Bounded, one-configuration-per-part prompt derivation: exactly one
    positive point (this part's own anchor) and negative points on every
    OTHER part's own anchor in this panel, plus the panel's fixed corners
    and (for a legs-only panel) the collapsed upper-body placeholder --
    never this part's positive point folded into a shared request with its
    siblings, which is exactly the round-2/round-3 shape this card fixes.

    Raises `ValueError` for a `(panel_key, part_key)` this panel's own
    `PARTS_BY_PANEL` entry doesn't list -- there is no derivation to fall
    back to."""
    specs_by_key = _specs_for_panel(panel_key)
    if part_key not in specs_by_key:
        raise ValueError(f"panel {panel_key!r} has no part {part_key!r}: {PARTS_BY_PANEL}")

    anchors_px = {
        key: _px(_part_anchor_norm(spec, points_norm), panel_size)
        for key, spec in specs_by_key.items()
    }

    records: list[dict] = []
    px, py = anchors_px[part_key]
    spec = specs_by_key[part_key]
    derivation = (
        f"{spec.part_key} = ANKLE[{spec.joint_a}]"
        if spec.joint_b is None
        else f"{spec.part_key} = midpoint(JOINT[{spec.joint_a}], JOINT[{spec.joint_b}])"
    )
    records.append({"x": px, "y": py, "polarity": "positive", "derivation": derivation})

    for other_key, (ox, oy) in anchors_px.items():
        if other_key == part_key:
            continue
        records.append(
            {"x": ox, "y": oy, "polarity": "negative", "derivation": f"sibling_part:{other_key}"}
        )

    records.append({"x": 4, "y": 4, "polarity": "negative", "derivation": "corner_top_left"})
    records.append(
        {"x": panel_size - 4, "y": 4, "polarity": "negative", "derivation": "corner_top_right"}
    )
    records.append(
        {"x": 4, "y": panel_size - 4, "polarity": "negative", "derivation": "corner_bottom_left"}
    )
    records.append(
        {
            "x": panel_size - 4,
            "y": panel_size - 4,
            "polarity": "negative",
            "derivation": "corner_bottom_right",
        }
    )
    if panel_key in _LEGS_ONLY_PANEL_KEYS:
        collapse_x, collapse_y = _px(points_norm[_NECK], panel_size)
        records.append(
            {
                "x": collapse_x,
                "y": collapse_y,
                "polarity": "negative",
                "derivation": (
                    f"{panel_key}_panel_upper_body_collapse_point "
                    "(NECK[1], not real anatomy on this panel)"
                ),
            }
        )

    return records


def _specs_for_panel(panel_key: str) -> dict[str, PartSpec]:
    if panel_key == "legs":
        return _LEGS_PART_SPECS_BY_KEY
    return {}


def _make_part_sam3_runner(
    client: ComfyUIClient,
    image_filename: str,
    positive_coords: list[dict],
    negative_coords: list[dict],
    filename_prefix: str,
):
    """Builds and submits exactly ONE `SAM3_Detect` graph for exactly one
    part's own single-positive-point request -- the structural fix. Calling
    this once per part (never once per panel) is what makes each part a
    genuinely separate segmentation call, not a shared constraint set."""

    def _run() -> np.ndarray:
        from comfy_client.errors import ExecutionError, PollTimeoutError, SubmitError

        workflow = build_sam3_part_workflow(
            image_filename,
            _sam3_model_loader(),
            positive_coords=positive_coords,
            negative_coords=negative_coords,
            filename_prefix=filename_prefix,
        )
        try:
            job_id = client.submit(workflow)
            result = client.wait_for_completion(job_id, timeout=60.0)
        except (SubmitError, ExecutionError, PollTimeoutError) as exc:
            raise Sam3SegmentationUnavailable(str(exc)) from exc
        try:
            png_bytes = client.fetch_output(result)
        except Exception as exc:  # noqa: BLE001 -- fetch failure is also "unavailable"
            raise Sam3SegmentationUnavailable(f"fetch_output failed: {exc}") from exc
        return mask_png_bytes_to_bool_array(png_bytes)

    return _run


def _load_existing_part_comparison() -> dict | None:
    path = EVIDENCE_DIR / "part_comparison.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def _write_part_comparison(comparison: dict) -> Path:
    path = EVIDENCE_DIR / "part_comparison.json"
    path.write_text(json.dumps(comparison, indent=2) + "\n")
    return path


def _record_mid_run_sam3_failure(
    panel_key: str,
    part_key: str,
    exc: Exception,
    initial_availability: dict,
    initial_availability_error: str | None,
    run_id: str | None,
) -> Path:
    """[FIX ROUND finding 2] SAM3 passed the initial probe but then failed
    during `part_key`'s own request -- either a submission/execution/
    timeout/fetch failure from `_make_part_sam3_runner`'s own runner, or an
    upload failure `_run_one_part` re-raises as `Sam3SegmentationUnavailable`
    (finding 1). `main()` catches that exception around `_run_one_part` and
    calls this function instead of letting the script crash silently.

    Never clobbers `part_comparison.json`: reloads whatever is currently on
    disk, which already includes every part THIS run completed before the
    failure (each successful loop iteration in `main()` writes it
    immediately), and writes that back verbatim under `panels` -- the same
    "never destroy committed evidence on a failure path" rule the
    initial-probe-unavailable branch above already follows. `panels` is
    explicitly marked `panels_historical` so a later reader never mistakes
    it for a fresh, complete comparison from this run. `sam3_availability`
    is overwritten to `available: False` here -- the initial probe's own
    result is preserved separately under `sam3_initial_probe_availability`
    -- so nothing reads `available: true` standing next to a comparison
    that did not actually finish."""
    existing = _load_existing_part_comparison() or {}
    comparison = {
        "sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
        "sam3_availability": {
            "available": False,
            "reason": f"sam3_unavailable_mid_run: {exc}",
        },
        "sam3_initial_probe_availability": initial_availability,
        "sam3_availability_probe_error": initial_availability_error,
        "sam3_mid_run_failure": {
            "panel": panel_key,
            "part": part_key,
            "reason": str(exc),
        },
        "run_id": run_id,
        "panels": existing.get("panels", {}),
        "panels_historical": True,
        "note": (
            f"SAM3 became unavailable during {panel_key}/{part_key}, after the initial probe "
            "passed this run -- comparison stopped, no further parts run this pass. `panels` "
            "below is retained from before this failure (HISTORICAL -- not produced by this "
            "run) and is never deleted on a failure path."
        ),
    }
    return _write_part_comparison(comparison)


def _run_one_part(
    client: ComfyUIClient,
    crop: Image.Image,
    image_filename: str,
    panel_key: str,
    part_key: str,
    points: dict[int, tuple[float, float]],
    palette_list: list[tuple[int, int, int]],
    run_id: str | None,
) -> dict:
    """Runs exactly one part's own SAM3 request and writes exactly that
    part's own evidence -- never batched with a sibling part into the same
    graph or the same output files, so every artefact this function writes
    is addressable by `(panel_key, part_key)` alone."""
    from comfy_client.errors import UploadError
    from comfy_client.provenance_sidecar import write_provenance_sidecar

    prompts = part_prompt_points(panel_key, part_key, points, PANEL_SIZE)
    positive_coords = [{"x": r["x"], "y": r["y"]} for r in prompts if r["polarity"] == "positive"]
    negative_coords = [{"x": r["x"], "y": r["y"]} for r in prompts if r["polarity"] == "negative"]

    prompts_path = EVIDENCE_DIR / f"panel_{panel_key}_part_{part_key}_prompts.json"
    prompts_path.write_text(json.dumps(prompts, indent=2) + "\n")

    try:
        client.upload_image(_png_bytes(crop), image_filename)
    except UploadError as exc:
        # [FIX ROUND finding 1] An upload failure does NOT imply the
        # submission fails -- ComfyUI may still hold a PRIOR image under
        # `image_filename`, so submitting anyway would segment stale
        # pixels while the local overlay/descent/provenance all identify
        # the CURRENT crop. Abort this part's request before the runner is
        # ever built: no submit/wait_for_completion/fetch_output call, no
        # mask/overlay/descended PNG/success-shaped provenance. Raising
        # here (rather than returning a sentinel) reuses the exact
        # "prerequisite unmet" idiom `_make_part_sam3_runner` already uses
        # for a submission/execution/timeout/fetch failure -- `main()`
        # catches both the same way (finding 2), with the exception
        # message itself distinguishing "upload failed" from "segmentation
        # failed after a successful upload" for whoever reads the recorded
        # reason.
        raise Sam3SegmentationUnavailable(
            f"{panel_key}/{part_key}: upload of {image_filename} failed -- aborting this "
            f"part's request rather than submitting against a filename ComfyUI may still hold "
            f"stale pixels under: {exc}"
        ) from exc

    runner = _make_part_sam3_runner(
        client,
        image_filename,
        positive_coords,
        negative_coords,
        filename_prefix=f"T0417_sam3_{panel_key}_{part_key}",
    )
    raw_mask = runner()
    foreground_px_raw = int(raw_mask.sum())

    positive_points_px = [(r["x"], r["y"]) for r in prompts if r["polarity"] == "positive"]
    cleaned_mask, isolation = keep_components_containing_points(raw_mask, positive_points_px)
    foreground_px_after = isolation["foreground_px_after"]
    present = foreground_px_after > 0
    degenerate = (
        is_part_mask_degenerate(foreground_px_after, cleaned_mask.size) if present else None
    )
    stray_fraction_exceeds_tolerance = (
        exceeds_stray_fraction_tolerance(isolation["stray_fraction"]) if present else None
    )
    # This part's own verdict in isolation: present, not degenerate, and not
    # rejected on stray-fragment grounds. `main()`'s `_apply_overlap_rejection`
    # folds the sibling-overlap verdict (from `_evaluate_overlaps`, which
    # needs every part in the panel's own mask first) back into this value
    # once the whole panel has run -- see that function for why this base
    # value is kept under `isolated_before_overlap` rather than overwritten.
    isolated = bool(present and not degenerate and not stray_fraction_exceeds_tolerance)

    after_arr = np.array(crop).copy()
    after_arr[~cleaned_mask] = (255, 0, 255)  # magenta marks this part's own background call
    after_path = EVIDENCE_DIR / f"panel_{panel_key}_part_{part_key}_sam3_after.png"
    Image.fromarray(after_arr).save(after_path)

    # The cleaned boolean mask itself, not just the magenta-tinted overlay --
    # `main()`'s overlap evaluation reloads this to reconstruct each part's
    # own mask exactly, rather than trying to infer it back out of the
    # colour-coded visualization.
    mask_path = EVIDENCE_DIR / f"panel_{panel_key}_part_{part_key}_mask.png"
    Image.fromarray((cleaned_mask * 255).astype(np.uint8), mode="L").save(mask_path)

    descended_path = None
    if present:
        descended_path = EVIDENCE_DIR / f"panel_{panel_key}_part_{part_key}_descended.png"
        descended = box_descend_part(
            crop, cleaned_mask, palette_list, target_size=(32, 32), margin_px=2
        )
        save_sprite_sheet(descended, descended_path, palette=palette_list)
        write_provenance_sidecar(
            EVIDENCE_DIR / f"panel_{panel_key}_part_{part_key}_descended.provenance.json",
            {
                "source_sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
                "panel": panel_key,
                "part": part_key,
                "cutout_method": "sam3",
                "target_size": [32, 32],
                "palette": str(PALETTE_PATH.relative_to(REPO_ROOT)),
            },
            generator=GENERATOR_PATH,
            card="T-0417",
            note=(
                f"Evidence/demonstration descent, not a curated final -- descends the "
                f"independent per-part SAM3 cutout for {panel_key}/{part_key}; see "
                "docs/assets/evidence/T-0417/README.md."
            ),
            run_id=run_id,
        )

    result = {
        "panel": panel_key,
        "part": part_key,
        "method_used": "sam3",
        "present": present,
        "foreground_px_raw": foreground_px_raw,
        "foreground_px_after_isolation": foreground_px_after,
        "isolation": isolation,
        "degenerate": degenerate,
        "stray_fraction_exceeds_tolerance": stray_fraction_exceeds_tolerance,
        # `isolated_before_overlap` is this part's own verdict, never touched
        # again once written. `isolated`/`overlap_exceeds_tolerance` start
        # equal to it/False and are folded in by `_apply_overlap_rejection`
        # in `main()`, which recomputes both fresh from this base value on
        # every run -- see that function's docstring for why.
        "isolated_before_overlap": isolated,
        "overlap_exceeds_tolerance": False,
        "isolated": isolated,
        "prompts": prompts,
        "sam3_after": str(after_path.relative_to(REPO_ROOT)),
        "mask": str(mask_path.relative_to(REPO_ROOT)),
        "descended_part": str(descended_path.relative_to(REPO_ROOT)) if descended_path else None,
    }
    stray_fraction = isolation["stray_fraction"]
    print(
        f"{panel_key}/{part_key}: present={present} fg_raw={foreground_px_raw} "
        f"fg_after_isolation={foreground_px_after} stray_fraction={stray_fraction:.4f} "
        f"degenerate={degenerate} isolated={isolated}"
    )
    return result


def _evaluate_overlaps(panel_key: str, masks_by_part: dict[str, np.ndarray]) -> list[dict]:
    """[FIX ROUND finding 3] Pairwise overlap for EVERY distinct pair of
    PRESENT parts in this panel, not just `SIBLING_PART_PAIRS_BY_PANEL`'s
    adjacent list -- a part absent this run (empty mask) never reaches
    `masks_by_part` in the first place (`main()` filters on
    `res.get("present")` before calling this), so it's excluded from
    overlap evaluation entirely rather than counted as a 0-overlap pass.

    A pair on the adjacent list gets the joint-blur allowance
    (`PART_OVERLAP_FRACTION_TOLERANCE`, 0.25); every other pair -- cross-
    side, or a non-adjacent same-side pair like upper_leg/boot -- gets
    `PART_OVERLAP_FRACTION_TOLERANCE_NON_ADJACENT` (0.0), since none of
    them have a shared joint to justify any overlap at all."""
    adjacent_pairs = set(SIBLING_PART_PAIRS_BY_PANEL.get(panel_key, ()))
    adjacent_pairs |= {(b, a) for a, b in adjacent_pairs}

    overlaps = []
    for part_a, part_b in itertools.combinations(sorted(masks_by_part), 2):
        is_adjacent = (part_a, part_b) in adjacent_pairs
        tolerance = (
            PART_OVERLAP_FRACTION_TOLERANCE
            if is_adjacent
            else PART_OVERLAP_FRACTION_TOLERANCE_NON_ADJACENT
        )
        fraction = mask_overlap_fraction(masks_by_part[part_a], masks_by_part[part_b])
        overlaps.append(
            {
                "part_a": part_a,
                "part_b": part_b,
                "overlap_fraction": fraction,
                "exceeds_tolerance": fraction > tolerance,
                "tolerance": tolerance,
                "adjacent": is_adjacent,
            }
        )
    return overlaps


def _apply_overlap_rejection(
    parts_by_key: dict[str, dict], overlaps: list[dict]
) -> dict[str, dict]:
    """Folds `_evaluate_overlaps`'s pairwise verdicts back into each
    individual part's own `isolated` flag -- the half of "isolation judged
    on more than total area" that stray-fragment rejection alone doesn't
    cover. `_run_one_part`'s own verdict (present, not degenerate, not
    stray-rejected) is preserved verbatim under `isolated_before_overlap`
    and never mutated again; every call here recomputes `isolated` and
    `overlap_exceeds_tolerance` fresh from that base plus the CURRENT
    `overlaps` list, so re-running a single part later (`--part`) can never
    compound a stale overlap verdict left over from an earlier pass -- e.g.
    a part rejected on overlap grounds against a sibling that has since been
    re-run and no longer overlaps is correctly un-rejected, not stuck
    rejected forever.

    Both parts in an over-tolerance pair are marked, not just one:
    `mask_overlap_fraction` measures how much they share, not which side
    bled into the other, so neither is treated as the innocent one -- "the
    overlap tolerance decides, and the decision is recorded per part rather
    than silently merged" (card's own edge-case wording)."""
    overlapping_parts: set[str] = set()
    for pair in overlaps:
        if pair["exceeds_tolerance"]:
            overlapping_parts.add(pair["part_a"])
            overlapping_parts.add(pair["part_b"])

    updated: dict[str, dict] = {}
    for key, result in parts_by_key.items():
        result = dict(result)
        base_isolated = result.get("isolated_before_overlap", result["isolated"])
        result["isolated_before_overlap"] = base_isolated
        result["overlap_exceeds_tolerance"] = key in overlapping_parts
        result["isolated"] = bool(base_isolated and key not in overlapping_parts)
        updated[key] = result
    return updated


def main() -> None:
    import argparse

    from comfy_client.comfyui_client import ComfyUIClient
    from comfy_client.provenance_sidecar import resolve_run_id

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--panel",
        choices=list(PARTS_BY_PANEL),
        default="legs",
        help="which parts panel to run (only panels with a PARTS_BY_PANEL entry are valid)",
    )
    parser.add_argument(
        "--part",
        default=None,
        help="run exactly one part and merge its result into the existing part_comparison.json",
    )
    args = parser.parse_args()

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    palette = load_palette(PALETTE_PATH)
    palette_list = [palette.rgb_by_index[i] for i in sorted(palette.rgb_by_index)]

    sheet = Image.open(SHEET_PATH).convert("RGB")
    client = ComfyUIClient(COMFY_BASE_URL, request_timeout=30.0)
    run_id = resolve_run_id()

    availability, availability_error = _probe_sam3_availability(client)
    if not availability.get("available"):
        # "Performs no comparison" means exactly that -- any part evidence
        # already on disk from a prior run stays untouched. Unconditionally
        # writing `"panels": {}` here would destroy that record every time
        # this short-circuit fires, which is a materially different failure
        # from merely skipping this run's own decomposition.
        existing = _load_existing_part_comparison() or {}
        comparison = {
            "sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
            "sam3_availability": availability,
            "sam3_availability_probe_error": availability_error,
            "run_id": run_id,
            "panels": existing.get("panels", {}),
            "note": (
                "SAM3 prerequisite unmet on this host -- no part decomposition performed. "
                f"reason={availability.get('reason')!r}"
            ),
        }
        _write_part_comparison(comparison)
        print(f"SAM3 unavailable ({availability.get('reason')}); part decomposition skipped")
        return

    panel_key = args.panel
    index = PANEL_KEYS.index(panel_key)
    crop = _panel_crop(sheet, index)
    image_filename = f"T0417_panel_{panel_key}.png"
    points = rig.keypoints_for(panel_key)

    existing = _load_existing_part_comparison() or {}
    existing_panels = existing.get("panels", {})
    existing_parts_by_key = dict(existing_panels.get(panel_key, {}).get("parts", {}))

    parts_to_run = [args.part] if args.part else list(PARTS_BY_PANEL[panel_key])
    for part_key in parts_to_run:
        try:
            result = _run_one_part(
                client, crop, image_filename, panel_key, part_key, points, palette_list, run_id
            )
        except Sam3SegmentationUnavailable as exc:
            # [FIX ROUND finding 2] SAM3 passed the initial probe (above)
            # but failed during this specific part's own request -- catch
            # it at the driver boundary rather than letting the script
            # crash, which used to leave sam3_availability.available=true
            # standing next to whatever partial/stale results were already
            # on disk with no record of what actually happened.
            _record_mid_run_sam3_failure(
                panel_key, part_key, exc, availability, availability_error, run_id
            )
            print(
                f"SAM3 unavailable mid-run at {panel_key}/{part_key}: {exc}; "
                "comparison stopped"
            )
            return
        existing_parts_by_key[part_key] = result

        masks_by_part: dict[str, np.ndarray] = {}
        for key, res in existing_parts_by_key.items():
            if not res.get("present"):
                continue
            mask_path_for_key = REPO_ROOT / res["mask"]
            masks_by_part[key] = np.array(Image.open(mask_path_for_key).convert("L")) >= 128

        overlaps = _evaluate_overlaps(panel_key, masks_by_part)
        existing_parts_by_key = _apply_overlap_rejection(existing_parts_by_key, overlaps)

        ordered_parts = {
            k: existing_parts_by_key[k]
            for k in PARTS_BY_PANEL[panel_key]
            if k in existing_parts_by_key
        }
        existing_panels[panel_key] = {
            "parts": ordered_parts,
            "overlaps": overlaps,
        }
        comparison = {
            "sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
            "sam3_availability": availability,
            "sam3_availability_probe_error": availability_error,
            "run_id": run_id,
            "prompt_strategy": (
                "[T-0417] genuinely independent per-part point prompts -- one positive point "
                "per part, negatives on every sibling part's own anchor plus the panel's fixed "
                "corners/collapse point, one SAM3_Detect call per part. See "
                "gen_master_sheet_part_cutouts_T0417.part_prompt_points."
            ),
            "panels": existing_panels,
        }
        path = _write_part_comparison(comparison)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
