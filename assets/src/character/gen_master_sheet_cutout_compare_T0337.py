#!/usr/bin/env python3
"""SAM3-vs-Oklab cutout comparison on T-0351's real six-panel Tier-1 master
sheet (T-0337, docs/assets/evidence/T-0337/README.md).

This is the "exercised end-to-end against a real Tier-1 sheet" driver the
card's acceptance criteria ask for. It runs against the real, live ComfyUI
host (never a mock) for every one of T-0351's six panels: attempts SAM3 (via
`char_gen.cutout_sam3`) first, falls back to the Oklab flood
(`char_gen.cutout`, unmodified) exactly the way `cut_master_sheet_part`
always does, records the real result either way, and box-descends the
resulting whole-figure cutout to game scale
(`char_gen.part_descend.box_descend_part`) as a demonstration of the descent
pipeline running on a real per-panel mask.

**Consumes T-0351's own committed evidence, not a promoted master sheet.**
T-0351 never promoted a compliant sheet to
`assets/src/character/master_sheets/` -- 21 attempts across three
architectures ended in a pre-registered STOP AND REPORT
(`docs/assets/evidence/T-0351/README.md`). Attempt 19 is the real
ComfyUI-sampled six-panel image this script consumes:
front_tpose/back_tpose/side_neutral converged cleanly (a genuine T-pose/back
view/true profile every time), side_left_forward/side_right_forward never
did, and legs partially exposed the thigh. Real pixels either way -- not a
synthetic stand-in -- which is what this card's own comparison needs; T-0337
does not require T-0351's own acceptance criteria to have passed, only a
real sheet to segment.

**[FIX ROUND 1] `_sam3_model_loader` builds the real loader.** SAM3's model
input is satisfied by `UNETLoader` (ComfyUI core), naming the now-installed
`sam3.1_multiplex_fp16.safetensors` checkpoint -- see
`char_gen.cutout_sam3`'s module docstring for the full loader-location
correction and `docs/assets/evidence/T-0337/README.md` for the weight
installation's verification. There is no placeholder checkpoint substituted
anywhere in this script: if `evaluate_sam3_availability` reports the
prerequisite unmet, `main()` reports that and performs no comparison, full
stop -- it never wires a structurally-valid-but-wrong model in its place.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/character/gen_master_sheet_cutout_compare_T0337.py

Writes (always, when SAM3 is available -- see `main()` for the unavailable
short-circuit):
    docs/assets/evidence/T-0337/panel_{key}_before.png
    docs/assets/evidence/T-0337/panel_{key}_oklab_after.png
    docs/assets/evidence/T-0337/panel_{key}_sam3_after.png (when SAM3 succeeds for that panel)
    docs/assets/evidence/T-0337/panel_{key}_descended_32x64.png (+.provenance.json)
    docs/assets/evidence/T-0337/comparison.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))
# comfy-client is not a declared dependency of char-gen's own pyproject.toml
# -- same informal sys.path convention every other generator script in this
# package already uses (gen_chained_idle_T0250.py's own comment explains
# why), not a formal pip dependency.
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(REPO_ROOT / "tools" / "gen-client-base" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pose_rig_master_sheet_T0351 as rig  # noqa: E402
from asset_gate.palette import load_palette  # noqa: E402

# comfy_client pulls in `requests`, which is not a declared dependency of
# char-gen's own pyproject.toml (nor of tools/comfy-client's own, at this
# checkpoint) -- so importing it at module scope breaks collection of this
# module (and anything that imports it, incl. the test module) in a clean
# char-gen venv that never installed `requests`. Deferred into the functions
# that actually call ComfyUIClient/resolve_run_id/write_provenance_sidecar at
# runtime, same lazy-import shape T-0363 applied to asset_gate.cli. Only used
# as type hints at module scope, which `from __future__ import annotations`
# above already turns into unevaluated strings.
if TYPE_CHECKING:
    from comfy_client.comfyui_client import ComfyUIClient

from char_gen.cutout import (  # noqa: E402
    BACKGROUND_MASK_MARGIN_FRAC,
    CUTOUT_OKLAB_TOLERANCE,
    cutout_foreground_mask,
)
from char_gen.cutout_sam3 import (  # noqa: E402
    Sam3SegmentationUnavailable,
    build_sam3_part_workflow,
    cut_master_sheet_part,
    evaluate_sam3_availability,
    mask_png_bytes_to_bool_array,
)
from char_gen.part_descend import box_descend_part  # noqa: E402
from char_gen.sprite_io import save_sprite_sheet  # noqa: E402

COMFY_BASE_URL = "http://172.18.192.1:8188"
SHEET_PATH = (
    REPO_ROOT
    / "docs"
    / "assets"
    / "evidence"
    / "T-0351"
    / "attempt_19_first_per_panel_reference_run_front_back_neutral_clean_sides_malformed.png"
)
EVIDENCE_DIR = REPO_ROOT / "docs" / "assets" / "evidence" / "T-0337"
#: [FIX ROUND 2] Where the withdrawn single-neck-point run's own SAM3
#: results are archived, relabelled -- not deleted, not presented as the
#: anatomical-part result. Archived by a one-off `git mv` in commit
#: `a060b469` ahead of this round's live rerun overwriting the parent
#: directory's comparison.json -- there is no `main()` helper that performs
#: this; it is not part of this script's own runtime behaviour.
INITIAL_EXPERIMENT_DIR = EVIDENCE_DIR / "initial_single_point_experiment"
GENERATOR_PATH = "assets/src/character/gen_master_sheet_cutout_compare_T0337.py"
PANEL_SIZE = 1024
PANEL_KEYS = [
    "front_tpose",
    "back_tpose",
    "side_left_forward",
    "side_right_forward",
    "side_neutral",
    "legs",
]
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
#: The now-installed SAM3.1 checkpoint (docs/assets/evidence/T-0337/README.md
#: has the sha256 + source verification), loaded via the generic `UNETLoader`
#: node -- the real loader location, per char_gen.cutout_sam3's [FIX ROUND 1]
#: module docstring. Never substituted with a placeholder: if this filename
#: isn't in UNETLoader's own unet_name option list, `_probe_sam3_availability`
#: reports unavailable and `main()` performs no comparison.
SAM3_UNET_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors"

# ── [FIX ROUND 2] Standard 18-keypoint COCO/OpenPose joint indices --------
# Mirrored deliberately from `pose_rig_master_sheet_T0351.py`'s own (private,
# unexported) numbering rather than importing it: this module already
# depends on that one via `rig.keypoints_for`, and duplicating a handful of
# stable integer constants keeps this card's own prompt-derivation logic
# free of a second, informal coupling to that module's private names (same
# rationale `char_gen.part_descend`'s own docstring gives for duplicating
# `_srgb_to_oklab` rather than importing it).
_NECK = 1
_R_WRIST, _L_WRIST = 4, 7
_R_HIP, _R_KNEE, _R_ANKLE = 8, 9, 10
_L_HIP, _L_KNEE, _L_ANKLE = 11, 12, 13

#: Panel keys whose pose has no real upper-body anatomy -- T-0351's own
#: `LEGS_KEYPOINTS_NORM` collapses every upper-body joint (including NECK)
#: to one placeholder point near the top edge, since the panel is a
#: waist-down crop. Point-prompting any of those collapsed joints (the
#: withdrawn initial experiment's own `_neck_pixel` did exactly this) always
#: produced a near-empty mask -- not a segmentation failure, an invalid
#: query.
_LEGS_ONLY_PANEL_KEYS = frozenset({"legs"})

#: [FIX ROUND 2] Degenerate-mask fraction thresholds for a 1024x1024 panel.
#: Justified against this round's own committed numbers
#: (docs/assets/evidence/T-0337/comparison.json's withdrawn
#: single-neck-point experiment): the three unusable masks measured
#: 16,777 / 7,467 / 547 px of 1,048,576 -- fractions 0.016 / 0.007 / 0.0005
#: -- while Oklab's own flood on the same six panels spans roughly
#: 0.124-0.396. DEGENERATE_MASK_FRACTION_LOW (0.03) sits strictly between
#: the worst of those three failures (0.016) and the smallest plausible
#: Oklab result (0.124), so a comparably bad SAM3 result is still caught
#: without rejecting a legitimately smaller *part* mask (this round's
#: per-part prompting on the legs panel can validly produce a foreground
#: fraction well below a whole-figure flood's). DEGENERATE_MASK_FRACTION_HIGH
#: (0.55) sits strictly above the largest plausible Oklab result (0.396),
#: catching the opposite failure -- a mask that grew to cover most of the
#: panel including background.
DEGENERATE_MASK_FRACTION_LOW = 0.03
DEGENERATE_MASK_FRACTION_HIGH = 0.55


def is_degenerate_mask_fraction(foreground_px: int, total_px: int) -> bool:
    """True when `foreground_px / total_px` falls outside the plausible
    range for a real part/figure mask on a 1024x1024 T-0351 panel -- pure
    arithmetic, no ComfyUI/host dependency, so it runs offline."""
    if total_px <= 0:
        raise ValueError("total_px must be positive")
    fraction = foreground_px / total_px
    return fraction < DEGENERATE_MASK_FRACTION_LOW or fraction > DEGENERATE_MASK_FRACTION_HIGH


def _px(point_norm: tuple[float, float], panel_size: int) -> tuple[int, int]:
    x, y = point_norm
    return int(x * panel_size), int(y * panel_size)


def _midpoint(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0


def panel_prompt_points(
    pose_key: str, points_norm: dict[int, tuple[float, float]], panel_size: int = PANEL_SIZE
) -> list[dict]:
    """[FIX ROUND 2] Bounded, panel/part-aware SAM3 point-prompt derivation
    -- one fixed configuration per panel, decided up front, never a sweep.
    Replaces the withdrawn single-neck-point query
    (`_neck_pixel`/`_NECK_JOINT`, removed this round) that queried every
    panel -- including the legs-only panel, whose neck is a collapsed,
    invalid placeholder -- with the same one point regardless of what that
    panel is actually meant to isolate.

    Returns a flat list of `{"x": int, "y": int, "polarity": "positive" |
    "negative", "derivation": str}` records -- every point used is
    recorded, not just the final mask, and `derivation` names exactly which
    joint(s) (or which corner) produced it so the evidence is self-
    explaining without cross-referencing this function's source.

    `pose_key in _LEGS_ONLY_PANEL_KEYS` (today, just `"legs"`): the panel's
    only real anatomy is hip/knee/ankle, both sides -- six positive points,
    one each for thigh (`midpoint(HIP, KNEE)`), lower leg
    (`midpoint(KNEE, ANKLE)`), and boot (`ANKLE` itself), per side. Negatives
    are the four corners plus the panel's own collapsed upper-body
    placeholder point (real coordinates on this panel, but never real
    anatomy), suppressing exactly the invalid anchor the withdrawn
    experiment queried.

    Every other panel is a whole-figure pose: T-0351's T-pose and profile
    rigs spread both arms/legs well clear of the torso, and the withdrawn
    experiment's own committed numbers (16,777 / 7,467 px of 1,048,576 for
    front/back_tpose) show a single torso point does not reliably grow to
    cover a spread figure. Five positive points -- NECK plus both WRIST and
    both ANKLE extremities -- give SAM3 enough spatial spread; negatives are
    the four corners."""
    records: list[dict] = []

    def positive(point_norm: tuple[float, float], derivation: str) -> None:
        x, y = _px(point_norm, panel_size)
        records.append({"x": x, "y": y, "polarity": "positive", "derivation": derivation})

    def negative(x: int, y: int, derivation: str) -> None:
        records.append({"x": x, "y": y, "polarity": "negative", "derivation": derivation})

    if pose_key in _LEGS_ONLY_PANEL_KEYS:
        for side, hip_idx, knee_idx, ankle_idx in (
            ("right", _R_HIP, _R_KNEE, _R_ANKLE),
            ("left", _L_HIP, _L_KNEE, _L_ANKLE),
        ):
            hip, knee, ankle = points_norm[hip_idx], points_norm[knee_idx], points_norm[ankle_idx]
            positive(
                _midpoint(hip, knee),
                f"{side}_thigh = midpoint(HIP[{hip_idx}], KNEE[{knee_idx}])",
            )
            positive(
                _midpoint(knee, ankle),
                f"{side}_lower_leg = midpoint(KNEE[{knee_idx}], ANKLE[{ankle_idx}])",
            )
            positive(ankle, f"{side}_boot = ANKLE[{ankle_idx}]")
        negative(4, 4, "corner_top_left")
        negative(panel_size - 4, 4, "corner_top_right")
        negative(4, panel_size - 4, "corner_bottom_left")
        negative(panel_size - 4, panel_size - 4, "corner_bottom_right")
        collapse_x, collapse_y = _px(points_norm[_NECK], panel_size)
        negative(
            collapse_x,
            collapse_y,
            "legs_panel_upper_body_collapse_point (NECK[1], not real anatomy on this panel)",
        )
    else:
        positive(points_norm[_NECK], "neck (torso anchor) = NECK[1]")
        for side, wrist_idx in (("right", _R_WRIST), ("left", _L_WRIST)):
            positive(points_norm[wrist_idx], f"{side}_wrist (arm extremity) = WRIST[{wrist_idx}]")
        for side, ankle_idx in (("right", _R_ANKLE), ("left", _L_ANKLE)):
            positive(points_norm[ankle_idx], f"{side}_ankle (leg extremity) = ANKLE[{ankle_idx}]")
        negative(4, 4, "corner_top_left")
        negative(panel_size - 4, 4, "corner_top_right")
        negative(4, panel_size - 4, "corner_bottom_left")
        negative(panel_size - 4, panel_size - 4, "corner_bottom_right")

    return records


def _sam3_model_loader() -> dict:
    return {
        "class_type": "UNETLoader",
        "inputs": {"unet_name": SAM3_UNET_CHECKPOINT, "weight_dtype": "default"},
    }


def _panel_crop(sheet: Image.Image, index: int) -> Image.Image:
    x0 = index * PANEL_SIZE
    return sheet.crop((x0, 0, x0 + PANEL_SIZE, PANEL_SIZE))


def _probe_sam3_availability(client: ComfyUIClient) -> tuple[dict, str | None]:
    """[FIX ROUND 1] Probes the real loader location -- `UNETLoader`'s own
    `unet_name` option list -- not `models/detection`, which `UNETLoader`
    never reads (see `char_gen.cutout_sam3`'s module docstring)."""
    try:
        detect_resp = client.session.get(f"{COMFY_BASE_URL}/object_info/SAM3_Detect", timeout=15)
        node_types = set(detect_resp.json().keys()) if detect_resp.ok else set()
        loader_resp = client.session.get(f"{COMFY_BASE_URL}/object_info/UNETLoader", timeout=15)
        unet_filenames: list[str] = []
        if loader_resp.ok:
            required = loader_resp.json().get("UNETLoader", {}).get("input", {}).get("required", {})
            options = required.get("unet_name")
            if options:
                unet_filenames = options[0]
    except Exception as exc:  # noqa: BLE001 -- evidence gathering, never fatal
        return {"nodes_present": None, "available": None, "reason": None}, str(exc)
    availability = evaluate_sam3_availability(node_types, unet_filenames)
    return {
        "nodes_present": availability.nodes_present,
        "available": availability.available,
        "reason": availability.reason,
        "model_files": list(availability.model_files),
    }, None


def _make_sam3_runner(
    client: ComfyUIClient, image_filename: str, prompt_records: list[dict], filename_prefix: str
):
    """[FIX ROUND 2] `prompt_records` is `panel_prompt_points`'s own output --
    a flat list of `{"x", "y", "polarity", "derivation"}` records, split here
    into the `positive_coords`/`negative_coords` lists `SAM3_Detect` actually
    takes (`derivation` is evidence-only, not part of the graph)."""
    positive_coords = [
        {"x": r["x"], "y": r["y"]} for r in prompt_records if r["polarity"] == "positive"
    ]
    negative_coords = [
        {"x": r["x"], "y": r["y"]} for r in prompt_records if r["polarity"] == "negative"
    ]

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


def _load_existing_comparison() -> dict | None:
    comparison_path = EVIDENCE_DIR / "comparison.json"
    if not comparison_path.exists():
        return None
    return json.loads(comparison_path.read_text())


def _write_comparison(comparison: dict) -> Path:
    comparison_path = EVIDENCE_DIR / "comparison.json"
    comparison_path.write_text(json.dumps(comparison, indent=2) + "\n")
    return comparison_path


def _run_one_panel(
    client: ComfyUIClient,
    sheet: Image.Image,
    index: int,
    key: str,
    palette_list: list[tuple[int, int, int]],
    run_id: str | None,
) -> dict:
    """[FIX ROUND 2] Runs exactly one panel's SAM3-vs-Oklab comparison and
    writes exactly that panel's evidence files -- split out of `main()` so a
    single GPU job can be foregrounded and its evidence committed before the
    next panel runs, per the card's own "one GPU job at a time... commit per
    panel" instruction, instead of batching all six into one commit."""
    from comfy_client.errors import UploadError
    from comfy_client.provenance_sidecar import write_provenance_sidecar

    crop = _panel_crop(sheet, index)
    points = rig.keypoints_for(key)
    prompts = panel_prompt_points(key, points, PANEL_SIZE)

    before_path = EVIDENCE_DIR / f"panel_{key}_before.png"
    crop.save(before_path)

    prompts_path = EVIDENCE_DIR / f"panel_{key}_prompts.json"
    prompts_path.write_text(json.dumps(prompts, indent=2) + "\n")

    image_filename = f"T0337_panel_{key}.png"
    try:
        client.upload_image(_png_bytes(crop), image_filename)
    except UploadError as exc:
        print(f"{key}: upload failed, SAM3 attempt will fail to submit: {exc}")

    runner = _make_sam3_runner(client, image_filename, prompts, f"T0337_sam3_{key}")
    mask, method = cut_master_sheet_part(
        crop,
        points,
        CUTOUT_OKLAB_TOLERANCE,
        BACKGROUND_MASK_MARGIN_FRAC,
        method="sam3",
        sam3_runner=runner,
    )

    oklab_mask = cutout_foreground_mask(
        crop, points, CUTOUT_OKLAB_TOLERANCE, BACKGROUND_MASK_MARGIN_FRAC
    )
    oklab_fg_px = int(oklab_mask.sum())

    oklab_after_arr = np.array(crop).copy()
    oklab_after_arr[~oklab_mask] = (255, 0, 255)  # magenta marks Oklab's own background call
    oklab_after_path = EVIDENCE_DIR / f"panel_{key}_oklab_after.png"
    Image.fromarray(oklab_after_arr).save(oklab_after_path)

    sam3_fg_px = None
    sam3_after_path = None
    sam3_degenerate = None
    if method == "sam3":
        sam3_fg_px = int(mask.sum())
        sam3_degenerate = is_degenerate_mask_fraction(sam3_fg_px, mask.size)
        sam3_after_arr = np.array(crop).copy()
        sam3_after_arr[~mask] = (255, 0, 255)  # magenta marks SAM3's own background call
        sam3_after_path = EVIDENCE_DIR / f"panel_{key}_sam3_after.png"
        Image.fromarray(sam3_after_arr).save(sam3_after_path)

    # Descend whichever mask cut_master_sheet_part actually used
    # (method-labelled) -- not hard-coded to Oklab, so the descended
    # evidence matches the primary path that really produced it.
    descended_path = EVIDENCE_DIR / f"panel_{key}_descended_32x64.png"
    descended = box_descend_part(crop, mask, palette_list, target_size=(32, 64), margin_px=4)
    save_sprite_sheet(descended, descended_path, palette=palette_list)
    write_provenance_sidecar(
        EVIDENCE_DIR / f"panel_{key}_descended_32x64.provenance.json",
        {
            "source_sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
            "panel": key,
            "cutout_method": method,
            "target_size": [32, 64],
            "palette": str(PALETTE_PATH.relative_to(REPO_ROOT)),
        },
        generator=GENERATOR_PATH,
        card="T-0337",
        note=(
            "Evidence/demonstration descent, not a curated final -- descends the "
            f"cutout produced by the {method} method (panel/part-aware prompts, "
            "[FIX ROUND 2]) for this panel; see docs/assets/evidence/T-0337/README.md."
        ),
        run_id=run_id,
    )

    result = {
        "panel": key,
        "method_used": method,
        "oklab_foreground_px": oklab_fg_px,
        "sam3_foreground_px": sam3_fg_px,
        "sam3_degenerate_mask": sam3_degenerate,
        "prompts": prompts,
        "before": str(before_path.relative_to(REPO_ROOT)),
        "oklab_after": str(oklab_after_path.relative_to(REPO_ROOT)),
        "sam3_after": str(sam3_after_path.relative_to(REPO_ROOT)) if sam3_after_path else None,
        "descended_part": str(descended_path.relative_to(REPO_ROOT)),
    }
    print(
        f"{key}: method_used={method} oklab_fg_px={oklab_fg_px} sam3_fg_px={sam3_fg_px} "
        f"sam3_degenerate={sam3_degenerate}"
    )
    return result


def main() -> None:
    import argparse

    from comfy_client.comfyui_client import ComfyUIClient
    from comfy_client.provenance_sidecar import resolve_run_id

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--panel",
        choices=PANEL_KEYS,
        default=None,
        help=(
            "[FIX ROUND 2] run exactly one panel and merge its result into the existing "
            "comparison.json, instead of all six -- lets each panel's live ComfyUI job be "
            "foregrounded and its evidence committed on its own, per the card's own "
            "'one GPU job at a time... commit per panel' instruction."
        ),
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
        # [FIX ROUND 1] SAM3's prerequisite is unmet on this host -- report
        # it and stop. Never substitute another model for SAM3_Detect's
        # required `model` input; there is nothing to compare.
        comparison = {
            "sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
            "sam3_availability": availability,
            "sam3_availability_probe_error": availability_error,
            "run_id": run_id,
            "panels": [],
            "note": (
                "SAM3 prerequisite unmet on this host -- no comparison performed. "
                f"reason={availability.get('reason')!r}"
            ),
        }
        comparison_path = _write_comparison(comparison)
        print(f"SAM3 unavailable ({availability.get('reason')}); wrote {comparison_path}")
        return

    existing = _load_existing_comparison() or {}
    existing_panels_by_key = {p["panel"]: p for p in existing.get("panels", [])}
    keys_to_run = [args.panel] if args.panel else PANEL_KEYS

    for key in keys_to_run:
        index = PANEL_KEYS.index(key)
        result = _run_one_panel(client, sheet, index, key, palette_list, run_id)
        existing_panels_by_key[key] = result

        # Write/merge comparison.json after every single panel -- not
        # batched at the end -- so a run that only does one panel this call
        # still leaves a consistent, committable comparison.json behind.
        comparison = {
            "sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
            "sam3_availability": availability,
            "sam3_availability_probe_error": availability_error,
            "run_id": run_id,
            "prompt_strategy": (
                "[FIX ROUND 2] panel/part-aware point prompts derived from "
                "pose_rig_master_sheet_T0351.keypoints_for(pose_key) -- see "
                "gen_master_sheet_cutout_compare_T0337.panel_prompt_points. Supersedes the "
                "single-fixed-neck-point query the withdrawn initial experiment used; see "
                "initial_single_point_experiment/ for that run's own archived record."
            ),
            "panels": [
                existing_panels_by_key[k] for k in PANEL_KEYS if k in existing_panels_by_key
            ],
        }
        comparison_path = _write_comparison(comparison)
        print(f"wrote {comparison_path}")


def _png_bytes(img: Image.Image) -> bytes:
    import io

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


if __name__ == "__main__":
    main()
