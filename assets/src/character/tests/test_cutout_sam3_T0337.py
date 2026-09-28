"""RED: SAM3 wired as the primary per-part cutout path for master-sheet
parts (T-0337), replacing the Oklab border-flood (`char_gen.cutout`) as
PRIMARY -- Oklab is demoted to an explicit, selectable FALLBACK, unmodified,
its own tests (`test_cutout_T0272.py` et al.) untouched.

**Live-host finding this module encodes** (docs/assets/evidence/T-0337/README.md):
`SAM3_Detect`/`SAM3_VideoTrack`/`SAM3_TrackPreview`/`SAM3_TrackToMask` are
registered on the ComfyUI host (`172.18.192.1:8188`, confirming the card's
own premise), but no SAM3 model-loader node exists anywhere in that host's
node registry and `GET /models/detection` (the model folder type a SAM3
checkpoint would live in) is empty. Probed live 2026-09-28: wiring a
same-typed-but-wrong `MODEL` (the SDXL checkpoint already on the host) into
`SAM3_Detect`'s required `model` input does not fail validation (ComfyUI's
type system only checks the string type name), but crashes at execution
with `AttributeError: 'UNetModel' object has no attribute 'forward_segment'`
(`comfy_extras/nodes_sam3.py:187`) the moment a real query (`positive_coords`)
is given -- decisive evidence no node on this host can currently produce a
usable SAM3 model object. `evaluate_sam3_availability` below is the pure
decision logic over that finding; `cut_master_sheet_part`'s automatic
fallback is what keeps the Oklab flood primary IN PRACTICE today, exactly
per this card's own escape hatch ("If SAM3 cannot segment the parts cleanly,
... the Oklab path stays primary").
"""

from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image

from char_gen.cutout import cutout_foreground_mask
from char_gen.cutout_sam3 import (
    SAM3_REQUIRED_NODE_TYPES,
    Sam3Availability,
    Sam3SegmentationUnavailable,
    build_sam3_part_workflow,
    cut_master_sheet_part,
    evaluate_sam3_availability,
    mask_png_bytes_to_bool_array,
)

SIZE = 64
BACKGROUND_RGB = (0, 0, 0)
FIGURE_RGB = (0, 200, 90)


def _rect_image(x0: int, y0: int, x1: int, y1: int) -> Image.Image:
    arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    arr[:, :] = BACKGROUND_RGB
    arr[y0:y1, x0:x1] = FIGURE_RGB
    return Image.fromarray(arr, mode="RGB")


def _points_norm() -> dict[int, tuple[float, float]]:
    # Centered on the rect stamped by _rect_image(16, 16, 48, 48) below.
    return {0: (0.5, 0.5)}


class TestEvaluateSam3Availability:
    def test_missing_required_node_is_unavailable(self):
        result = evaluate_sam3_availability(object_info_node_types=set(), detection_model_files=[])
        assert isinstance(result, Sam3Availability)
        assert result.nodes_present is False
        assert result.available is False
        assert "SAM3_Detect" in result.reason

    def test_nodes_present_but_no_model_files_is_unavailable(self):
        result = evaluate_sam3_availability(
            object_info_node_types=set(SAM3_REQUIRED_NODE_TYPES),
            detection_model_files=[],
        )
        assert result.nodes_present is True
        assert result.available is False
        assert "detection" in result.reason
        assert result.model_files == ()

    def test_nodes_and_model_files_present_is_available(self):
        result = evaluate_sam3_availability(
            object_info_node_types=set(SAM3_REQUIRED_NODE_TYPES),
            detection_model_files=["sam3_hiera_large.safetensors"],
        )
        assert result.nodes_present is True
        assert result.available is True
        assert result.model_files == ("sam3_hiera_large.safetensors",)


class TestBuildSam3PartWorkflow:
    def test_graph_wires_model_loader_and_sam3_detect(self):
        model_loader = {"class_type": "FakeSam3Loader", "inputs": {"foo": "bar"}}
        graph = build_sam3_part_workflow(
            "panel_front_tpose.png",
            model_loader,
            positive_coords=[{"x": 512, "y": 500}],
            threshold=0.5,
            refine_iterations=2,
            filename_prefix="T0337_sam3_part",
        )
        assert graph["1"]["class_type"] == "LoadImage"
        assert graph["1"]["inputs"]["image"] == "panel_front_tpose.png"
        assert graph["2"] == model_loader
        sam3_node = graph["3"]
        assert sam3_node["class_type"] == "SAM3_Detect"
        assert sam3_node["inputs"]["model"] == ["2", 0]
        assert sam3_node["inputs"]["image"] == ["1", 0]
        assert sam3_node["inputs"]["individual_masks"] is False
        assert json.loads(sam3_node["inputs"]["positive_coords"]) == [{"x": 512, "y": 500}]
        assert graph["4"]["class_type"] == "MaskToImage"
        assert graph["4"]["inputs"]["mask"] == ["3", 0]
        assert graph["5"]["class_type"] == "SaveImage"
        assert graph["5"]["inputs"]["images"] == ["4", 0]
        assert graph["5"]["inputs"]["filename_prefix"] == "T0337_sam3_part"

    def test_graph_omits_coords_when_not_given(self):
        graph = build_sam3_part_workflow("x.png", {"class_type": "L", "inputs": {}})
        assert "positive_coords" not in graph["3"]["inputs"]
        assert "negative_coords" not in graph["3"]["inputs"]


class TestMaskPngBytesToBoolArray:
    def test_decodes_a_maskotoimage_style_png(self):
        arr = np.zeros((SIZE, SIZE), dtype=np.uint8)
        arr[16:48, 16:48] = 255
        png_bytes = _to_png_bytes(arr)
        mask = mask_png_bytes_to_bool_array(png_bytes)
        assert mask.shape == (SIZE, SIZE)
        assert mask[32, 32] == True  # noqa: E712
        assert mask[0, 0] == False  # noqa: E712


def _to_png_bytes(gray_arr: np.ndarray) -> bytes:
    import io

    buf = io.BytesIO()
    Image.fromarray(gray_arr, mode="L").save(buf, format="PNG")
    return buf.getvalue()


class TestCutMasterSheetPart:
    def _img(self) -> Image.Image:
        return _rect_image(16, 16, 48, 48)

    def test_method_sam3_uses_the_runner_when_it_succeeds(self):
        sam3_mask = np.zeros((SIZE, SIZE), dtype=bool)
        sam3_mask[16:48, 16:48] = True
        calls = []

        def runner():
            calls.append("called")
            return sam3_mask

        mask, method = cut_master_sheet_part(
            self._img(),
            _points_norm(),
            tolerance=0.03,
            bbox_margin_frac=0.14,
            method="sam3",
            sam3_runner=runner,
        )
        assert method == "sam3"
        assert np.array_equal(mask, sam3_mask)
        assert calls == ["called"]

    def test_method_sam3_falls_back_to_oklab_when_runner_reports_unavailable(self):
        def runner():
            raise Sam3SegmentationUnavailable("no SAM3 model loader on this host")

        img = self._img()
        points = _points_norm()
        mask, method = cut_master_sheet_part(
            img,
            points,
            tolerance=0.03,
            bbox_margin_frac=0.14,
            method="sam3",
            sam3_runner=runner,
        )
        expected = cutout_foreground_mask(img, points, 0.03, 0.14)
        assert method == "oklab"
        assert np.array_equal(mask, expected)

    def test_method_oklab_never_invokes_sam3_runner(self):
        def runner():
            raise AssertionError("sam3_runner must not be called for method='oklab'")

        img = self._img()
        points = _points_norm()
        mask, method = cut_master_sheet_part(
            img,
            points,
            tolerance=0.03,
            bbox_margin_frac=0.14,
            method="oklab",
            sam3_runner=runner,
        )
        expected = cutout_foreground_mask(img, points, 0.03, 0.14)
        assert method == "oklab"
        assert np.array_equal(mask, expected)

    def test_method_sam3_requires_a_runner(self):
        with pytest.raises(ValueError):
            cut_master_sheet_part(
                self._img(),
                _points_norm(),
                tolerance=0.03,
                bbox_margin_frac=0.14,
                method="sam3",
                sam3_runner=None,
            )

    def test_unknown_method_raises(self):
        with pytest.raises(ValueError):
            cut_master_sheet_part(
                self._img(),
                _points_norm(),
                tolerance=0.03,
                bbox_margin_frac=0.14,
                method="chroma_key",
            )
