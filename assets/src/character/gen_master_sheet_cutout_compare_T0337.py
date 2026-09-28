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
from comfy_client.comfyui_client import ComfyUIClient  # noqa: E402
from comfy_client.errors import (  # noqa: E402
    ExecutionError,
    PollTimeoutError,
    SubmitError,
    UploadError,
)
from comfy_client.provenance_sidecar import resolve_run_id, write_provenance_sidecar  # noqa: E402

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
#: COCO/OpenPose joint index 1 = NECK, same numbering
#: `pose_rig_master_sheet_T0351.py` uses throughout.
_NECK_JOINT = 1


def _sam3_model_loader() -> dict:
    return {
        "class_type": "UNETLoader",
        "inputs": {"unet_name": SAM3_UNET_CHECKPOINT, "weight_dtype": "default"},
    }


def _panel_crop(sheet: Image.Image, index: int) -> Image.Image:
    x0 = index * PANEL_SIZE
    return sheet.crop((x0, 0, x0 + PANEL_SIZE, PANEL_SIZE))


def _neck_pixel(points_norm: dict[int, tuple[float, float]]) -> dict[str, int]:
    x, y = points_norm[_NECK_JOINT]
    return {"x": int(x * PANEL_SIZE), "y": int(y * PANEL_SIZE)}


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
    client: ComfyUIClient, image_filename: str, positive_point: dict, filename_prefix: str
):
    def _run() -> np.ndarray:
        workflow = build_sam3_part_workflow(
            image_filename,
            _sam3_model_loader(),
            positive_coords=[positive_point],
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


def main() -> None:
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
        comparison_path = EVIDENCE_DIR / "comparison.json"
        comparison_path.write_text(json.dumps(comparison, indent=2) + "\n")
        print(f"SAM3 unavailable ({availability.get('reason')}); wrote {comparison_path}")
        return

    panel_results = []
    for index, key in enumerate(PANEL_KEYS):
        crop = _panel_crop(sheet, index)
        points = rig.keypoints_for(key)

        before_path = EVIDENCE_DIR / f"panel_{key}_before.png"
        crop.save(before_path)

        image_filename = f"T0337_panel_{key}.png"
        try:
            client.upload_image(_png_bytes(crop), image_filename)
        except UploadError as exc:
            print(f"{key}: upload failed, SAM3 attempt will fail to submit: {exc}")

        runner = _make_sam3_runner(client, image_filename, _neck_pixel(points), f"T0337_sam3_{key}")
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
        if method == "sam3":
            sam3_fg_px = int(mask.sum())
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
                f"whole-figure cutout produced by the {method} method for this panel; "
                "see docs/assets/evidence/T-0337/README.md."
            ),
            run_id=run_id,
        )

        panel_results.append(
            {
                "panel": key,
                "method_used": method,
                "oklab_foreground_px": oklab_fg_px,
                "sam3_foreground_px": sam3_fg_px,
                "before": str(before_path.relative_to(REPO_ROOT)),
                "oklab_after": str(oklab_after_path.relative_to(REPO_ROOT)),
                "sam3_after": (
                    str(sam3_after_path.relative_to(REPO_ROOT)) if sam3_after_path else None
                ),
                "descended_part": str(descended_path.relative_to(REPO_ROOT)),
            }
        )
        print(f"{key}: method_used={method} oklab_fg_px={oklab_fg_px} sam3_fg_px={sam3_fg_px}")

    comparison = {
        "sheet": str(SHEET_PATH.relative_to(REPO_ROOT)),
        "sam3_availability": availability,
        "sam3_availability_probe_error": availability_error,
        "run_id": run_id,
        "panels": panel_results,
    }
    comparison_path = EVIDENCE_DIR / "comparison.json"
    comparison_path.write_text(json.dumps(comparison, indent=2) + "\n")
    print(f"wrote {comparison_path}")


def _png_bytes(img: Image.Image) -> bytes:
    import io

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


if __name__ == "__main__":
    main()
