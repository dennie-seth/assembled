"""SAM3 wired as the PRIMARY per-part cutout path for master-sheet parts
(T-0337), replacing `cutout.py`'s Oklab border-flood as primary -- the flood
itself is untouched here and stays available as the documented fallback
(seven tuning rounds are embodied in it; this card exists to stop retuning
it, not to retune it further).

**Live-host finding this module encodes** (full evidence:
`docs/assets/evidence/T-0337/README.md`). Probed 2026-09-28 against the real
ComfyUI host (`172.18.192.1:8188`, `GET /system_stats` confirms it's the
same RTX 3070 Ti host every other generator in this package targets):

- `GET /object_info/SAM3_Detect`, `.../SAM3_VideoTrack`, `.../SAM3_TrackPreview`,
  `.../SAM3_TrackToMask` all resolve -- the card's own premise ("SAM3 nodes are
  already installed... never tried") is correct, these four node types really
  are registered.
- No loader node anywhere in this host's `/object_info` registry can produce
  a SAM3 `MODEL` -- `python_module: "comfy_extras.nodes_sam3"` accounts for
  exactly those four node types and nothing else, and no other node's name
  contains "sam" (case-insensitively) besides the unrelated `Sampler*`
  family. `GET /models/detection` (the model-folder type a SAM3 checkpoint
  would live in -- ComfyUI's `/models` endpoint lists it as a registered
  folder type, but no "sam3"-named folder type exists at all) returns `[]`:
  empty.
- Wiring a same-typed-but-wrong `MODEL` into `SAM3_Detect`'s required `model`
  input (ComfyUI's graph validator only checks the string type name `MODEL`,
  not what produced it) does not fail at submission. With no query given at
  all (no `positive_coords`/`negative_coords`/`conditioning`) it runs to
  "success" and silently produces an all-zero mask -- SAM3_Detect's own
  no-op-if-nothing-to-detect behaviour, not evidence either way. Given a real
  query (`positive_coords=[{"x": 512, "y": 500}]`) it crashes:
  `AttributeError: 'UNetModel' object has no attribute 'forward_segment'`
  at `comfy_extras/nodes_sam3.py:187` (`sam3_model.forward_segment(...)`).

That crash is the decisive evidence: `SAM3_Detect`'s own code expects its
`model` input to be a real SAM3 model wrapper object exposing
`forward_segment`, and nothing on this host can currently produce one. This
is not a segmentation-quality problem (the card's own escape hatch, "SAM3
cannot segment the parts cleanly") -- it is a total inability to construct a
runnable graph, which the escape hatch's spirit still covers: an honest
negative result, reported with evidence, Oklab stays primary in practice.

`evaluate_sam3_availability` is the pure decision logic over that finding
(never makes an HTTP call itself -- a caller fetches `/object_info` and
`/models/detection` and hands the results in, so this stays testable without
a live host). `cut_master_sheet_part` is what keeps SAM3 wired as the
attempted-first PRIMARY path while still resulting in the Oklab flood being
used today: it always tries `sam3_runner` first when `method="sam3"`, and
only ever falls back to the flood when that raises
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

#: The ComfyUI `/models` folder type a SAM3 checkpoint would need to live in
#: to be loadable at all -- confirmed against the live host's own
#: `GET /models` folder-type listing; no "sam3"-named folder type exists.
SAM3_MODEL_FOLDER = "detection"


class Sam3SegmentationUnavailable(RuntimeError):
    """Raised whenever the SAM3 path cannot produce a usable mask -- a
    missing required node type, an empty model folder, or a runtime
    execution error surfaced by ComfyUI itself (this card's own live-host
    finding: `'UNetModel' object has no attribute 'forward_segment'`, see
    this module's docstring). Callers are expected to catch this and fall
    back to the Oklab flood; it is never meant to propagate as fatal."""


@dataclass(frozen=True)
class Sam3Availability:
    nodes_present: bool
    model_files: tuple[str, ...]
    available: bool
    reason: str


def evaluate_sam3_availability(
    object_info_node_types: set[str],
    detection_model_files: list[str] | tuple[str, ...],
) -> Sam3Availability:
    """Pure decision logic over already-fetched ComfyUI state -- never makes
    an HTTP call itself, so it's testable without a live host.
    `object_info_node_types` is (a subset of) `GET /object_info`'s own top-
    level keys; `detection_model_files` is `GET /models/detection`'s file
    list."""
    missing_nodes = [n for n in SAM3_REQUIRED_NODE_TYPES if n not in object_info_node_types]
    if missing_nodes:
        return Sam3Availability(
            nodes_present=False,
            model_files=tuple(detection_model_files),
            available=False,
            reason=(
                f"required SAM3 node type(s) not registered on this ComfyUI host: "
                f"{missing_nodes}"
            ),
        )
    if not detection_model_files:
        return Sam3Availability(
            nodes_present=True,
            model_files=(),
            available=False,
            reason=(
                "SAM3_Detect is registered but models/detection is empty -- no SAM3 "
                "checkpoint is loadable, so SAM3_Detect's required `model` input cannot "
                "be satisfied by any node on this host (verified 2026-09-28: feeding it a "
                "same-typed-but-wrong model crashes at comfy_extras/nodes_sam3.py:187 with "
                "\"AttributeError: 'UNetModel' object has no attribute 'forward_segment'\" "
                "the moment a real query is given -- see this module's own docstring and "
                "docs/assets/evidence/T-0337/README.md)"
            ),
        )
    return Sam3Availability(
        nodes_present=True,
        model_files=tuple(detection_model_files),
        available=True,
        reason="SAM3_Detect is registered and at least one detection-folder model file exists",
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
    since no SAM3 loader node exists on the host today (this module's own
    finding); a caller supplies whatever loader a fixed host eventually
    exposes, once one does."""
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
