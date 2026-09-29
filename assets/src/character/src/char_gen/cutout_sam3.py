"""SAM3 wired as the PRIMARY per-part cutout path for master-sheet parts
(T-0337), replacing `cutout.py`'s Oklab border-flood as primary -- the flood
itself is untouched here and stays available as the documented fallback
(seven tuning rounds are embodied in it; this card exists to stop retuning
it, not to retune it further).

**[FIX ROUND 1] Corrected loader diagnosis.** An earlier version of this
module claimed "no SAM3 loader exists on this host" -- that claim was false,
and the installed ComfyUI source itself proves it: `F:\\ComfyUI\\nodes.py:966-989`
is the generic **`UNETLoader`**, which loads from the **`diffusion_models`**
model folder via `comfy.sd.load_diffusion_model` (never from `detection`,
which is what the earlier, wrong diagnosis probed). `comfy/model_detection.py:1060-1066`
recognises SAM3/SAM3.1 checkpoints by their state-dict shape;
`comfy/supported_models.py:2255-2295` registers `SAM3` and (`:2302`) `SAM31`,
both listed at `:2466-2467`; `comfy/model_base.py:2570-2572` instantiates
`comfy.ldm.sam3.detector.SAM3Model` for them, and that module's files exist
on this host. The real prerequisite was never a missing loader -- it was
**weights in `diffusion_models`**, and they are now installed:
`sam3.1_multiplex_fp16.safetensors` (`Comfy-Org/sam3.1`, sha256
`9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03`; full
verification, including the three `model_detection.py` state-dict gates
this file was confirmed to satisfy, in `docs/assets/evidence/T-0337/README.md`).
`GET /object_info/UNETLoader` on the live host now lists it in `unet_name`'s
option list (was empty before the weights landed).

`SAM3_Detect`'s required inputs are `model` + `image` + `threshold` +
`refine_iterations` + `individual_masks`; `positive_coords` (this module's
point-prompt path) is optional and needs only the `MODEL` input -- so
`UNETLoader` alone is sufficient here, no CLIP/checkpoint loader required.

`evaluate_sam3_availability` is the pure decision logic over already-fetched
ComfyUI state (never makes an HTTP call itself -- a caller fetches
`/object_info/SAM3_Detect` and `/object_info/UNETLoader` and hands the
results in, so this stays testable without a live host). It probes
`UNETLoader`'s own `unet_name` option list -- the location `UNETLoader`
actually reads -- for an entry that looks SAM3-compatible, not merely "some
file exists somewhere"; an unrelated checkpoint dropped into
`diffusion_models` must not make this report available.
`cut_master_sheet_part` is what keeps SAM3 wired as the attempted-first
PRIMARY path: it always tries `sam3_runner` first when `method="sam3"`, and
only ever falls back to the Oklab flood when that raises
`Sam3SegmentationUnavailable` -- never a silent default, always visible in
the returned `method` string.
"""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from char_gen.cutout import cutout_foreground_mask

#: The only SAM3 node type this module's graph actually needs. `SAM3_Detect`
#: alone already returns a `MASK` output directly for a still image; the
#: card's other named node, `SAM3_TrackToMask`, only consumes
#: `SAM3_TRACK_DATA` from `SAM3_VideoTrack` (video frame-to-frame tracking),
#: which a single static master-sheet panel never produces -- this is the
#: "minimal equivalent" the card's own scope explicitly allows in place of
#: `SAM3_Detect -> SAM3_TrackToMask`.
SAM3_REQUIRED_NODE_TYPES: tuple[str, ...] = ("SAM3_Detect",)

#: The generic ComfyUI-core loader node that actually produces SAM3's
#: `model` input -- confirmed against the live host's own
#: `GET /object_info/UNETLoader`, whose `unet_name` option list reads the
#: `diffusion_models` model folder via `comfy.sd.load_diffusion_model`
#: [FIX ROUND 1]. There is no SAM3-specific loader node; this is it.
SAM3_UNET_LOADER_NODE_TYPE = "UNETLoader"

#: Case-insensitive substring a `UNETLoader` `unet_name` entry must contain
#: to be treated as a SAM3-compatible checkpoint -- deliberately a substring
#: match, not one hard-coded filename, so a future SAM3 checkpoint rename or
#: quantization variant (e.g. a differently-suffixed multiplex build) still
#: counts, while an unrelated diffusion checkpoint (SDXL, a LoRA base, etc.)
#: still doesn't.
SAM3_CHECKPOINT_SUBSTRING = "sam3"


def _is_sam3_compatible_filename(filename: str) -> bool:
    return SAM3_CHECKPOINT_SUBSTRING in filename.lower()


class Sam3SegmentationUnavailable(RuntimeError):
    """Raised whenever the SAM3 path cannot produce a usable mask -- a
    missing required node type, no SAM3-compatible entry in `UNETLoader`'s
    own option list, or a runtime execution error surfaced by ComfyUI
    itself. Callers are expected to catch this and fall back to the Oklab
    flood; it is never meant to propagate as fatal."""


@dataclass(frozen=True)
class Sam3Availability:
    nodes_present: bool
    model_files: tuple[str, ...]
    available: bool
    reason: str


def evaluate_sam3_availability(
    object_info_node_types: set[str],
    unet_loader_filenames: list[str] | tuple[str, ...],
) -> Sam3Availability:
    """Pure decision logic over already-fetched ComfyUI state -- never makes
    an HTTP call itself, so it's testable without a live host.
    `object_info_node_types` is (a subset of) `GET /object_info`'s own top-
    level keys; `unet_loader_filenames` is `GET /object_info/UNETLoader`'s
    own `unet_name` option list [FIX ROUND 1] -- the location `UNETLoader`
    actually reads (`diffusion_models`), not the never-consulted
    `models/detection` folder an earlier version of this function probed."""
    missing_nodes = [n for n in SAM3_REQUIRED_NODE_TYPES if n not in object_info_node_types]
    if missing_nodes:
        return Sam3Availability(
            nodes_present=False,
            model_files=(),
            available=False,
            reason=(
                f"required SAM3 node type(s) not registered on this ComfyUI host: "
                f"{missing_nodes}"
            ),
        )
    sam3_files = tuple(f for f in unet_loader_filenames if _is_sam3_compatible_filename(f))
    if not sam3_files:
        return Sam3Availability(
            nodes_present=True,
            model_files=(),
            available=False,
            reason=(
                "SAM3_Detect is registered but UNETLoader's own unet_name option list has no "
                f"entry containing {SAM3_CHECKPOINT_SUBSTRING!r} -- no SAM3-compatible "
                "diffusion_models checkpoint is loadable, so SAM3_Detect's required `model` "
                "input cannot be satisfied by any node on this host"
            ),
        )
    return Sam3Availability(
        nodes_present=True,
        model_files=sam3_files,
        available=True,
        reason=(
            "SAM3_Detect is registered and UNETLoader lists a SAM3-compatible diffusion_models "
            f"checkpoint: {sam3_files!r}"
        ),
    )


def build_sam3_part_workflow(
    image_filename: str,
    model_loader: dict[str, Any],
    *,
    positive_coords: list[dict[str, int]] | None = None,
    negative_coords: list[dict[str, int]] | None = None,
    threshold: float = 0.5,
    refine_iterations: int = 2,
    filename_prefix: str = "sam3_part",
) -> dict[str, Any]:
    """API-format ComfyUI graph: `LoadImage -> SAM3_Detect -> MaskToImage ->
    SaveImage` (a mask has no `/view`-able output node of its own; converting
    it to a greyscale image is how a client fetches it over HTTP, the same
    pattern this pipeline already uses for every other intermediate mask).

    `model_loader` is an injected node dict (`class_type` + `inputs`)
    providing `SAM3_Detect`'s `model` input -- deliberately not hard-coded,
    so this module stays free of any specific checkpoint filename or the
    live host's own `UNETLoader` wiring. [FIX ROUND 1] The real loader is
    `UNETLoader` naming `sam3.1_multiplex_fp16.safetensors` (see this
    module's own docstring); a caller (e.g.
    `gen_master_sheet_cutout_compare_T0337.py`'s `_sam3_model_loader`)
    supplies that node dict here."""
    sam3_inputs: dict[str, Any] = {
        "model": ["2", 0],
        "image": ["1", 0],
        "threshold": threshold,
        "refine_iterations": refine_iterations,
        "individual_masks": False,
    }
    if positive_coords is not None:
        sam3_inputs["positive_coords"] = json.dumps(positive_coords)
    if negative_coords is not None:
        sam3_inputs["negative_coords"] = json.dumps(negative_coords)

    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
        "2": dict(model_loader),
        "3": {"class_type": "SAM3_Detect", "inputs": sam3_inputs},
        "4": {"class_type": "MaskToImage", "inputs": {"mask": ["3", 0]}},
        "5": {
            "class_type": "SaveImage",
            "inputs": {"images": ["4", 0], "filename_prefix": filename_prefix},
        },
    }


def mask_png_bytes_to_bool_array(png_bytes: bytes, threshold: int = 128) -> np.ndarray:
    """Decode a `MaskToImage`-produced PNG (greyscale-as-luminance) into a
    boolean HxW mask, matching `cutout.downscale_mask`'s own >=50%
    thresholding convention."""
    img = Image.open(io.BytesIO(png_bytes)).convert("L")
    return np.array(img) >= threshold


def cut_master_sheet_part(
    img: Image.Image,
    points_norm: dict[int, tuple[float, float]],
    tolerance: float,
    bbox_margin_frac: float,
    *,
    method: str = "sam3",
    sam3_runner: Callable[[], np.ndarray] | None = None,
) -> tuple[np.ndarray, str]:
    """Cut one master-sheet part's foreground mask.

    `method="sam3"` (the default -- SAM3 wired as PRIMARY) always tries
    `sam3_runner` first; any `Sam3SegmentationUnavailable` it raises is
    caught here and falls back to the unmodified Oklab flood
    (`cutout.cutout_foreground_mask`), which stays available as the
    documented fallback the acceptance criteria require. `method="oklab"`
    skips SAM3 entirely (`sam3_runner`, if given, is never called) and
    always uses the flood.

    Returns `(mask, method_actually_used)` so a caller can record, per part,
    which path actually produced it -- never silently swallowed."""
    if method == "oklab":
        return cutout_foreground_mask(img, points_norm, tolerance, bbox_margin_frac), "oklab"
    if method != "sam3":
        raise ValueError(f"unknown cutout method: {method!r}")
    if sam3_runner is None:
        raise ValueError("method='sam3' requires a sam3_runner callable")
    try:
        return sam3_runner(), "sam3"
    except Sam3SegmentationUnavailable:
        return cutout_foreground_mask(img, points_norm, tolerance, bbox_margin_frac), "oklab"
