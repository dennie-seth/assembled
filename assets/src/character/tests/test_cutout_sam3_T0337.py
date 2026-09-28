"""SAM3 wired as the primary per-part cutout path for master-sheet parts
(T-0337), replacing the Oklab border-flood (`char_gen.cutout`) as PRIMARY --
Oklab is demoted to an explicit, selectable FALLBACK, unmodified, its own
tests (`test_cutout_T0272.py` et al.) untouched.

**[FIX ROUND 1] corrected loader diagnosis.** The prior finding here
(`models/detection` empty => no SAM3 loader exists) was wrong: `UNETLoader`
is the generic loader ComfyUI core already ships (`F:\\ComfyUI\\nodes.py:966-989`,
`comfy.sd.load_diffusion_model`, reading `diffusion_models`, not
`detection`), `comfy/model_detection.py:1060-1066` recognises SAM3/SAM3.1,
and `comfy/supported_models.py:2255-2302` registers both. The real
prerequisite was weights in `diffusion_models`, not a loader -- and they are
now installed (`sam3.1_multiplex_fp16.safetensors`, see
`docs/assets/evidence/T-0337/README.md`). `evaluate_sam3_availability` below
now probes `UNETLoader`'s own `unet_name` option list for a SAM3-compatible
entry, which is what `UNETLoader` actually reads, instead of the
never-consulted `models/detection` folder."""

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
    """[FIX ROUND 1] `evaluate_sam3_availability` probes the REAL loader
    location -- `UNETLoader`'s `unet_name` option list (`diffusion_models`,
    per `F:\\ComfyUI\\nodes.py:966-989`) -- not `models/detection`, which
    `UNETLoader` never reads and which stays empty regardless. Pinned both
    directions per the card: available when a SAM3-compatible entry is
    listed, unavailable when the list is empty, and unavailable when only a
    non-SAM3 entry is present -- an unrelated file dropped anywhere must not
    make this report available."""

    def test_missing_required_node_is_unavailable(self):
        result = evaluate_sam3_availability(object_info_node_types=set(), unet_loader_filenames=[])
        assert isinstance(result, Sam3Availability)
        assert result.nodes_present is False
        assert result.available is False
        assert "SAM3_Detect" in result.reason

    def test_nodes_present_but_no_unet_files_is_unavailable(self):
        result = evaluate_sam3_availability(
            object_info_node_types=set(SAM3_REQUIRED_NODE_TYPES),
            unet_loader_filenames=[],
        )
        assert result.nodes_present is True
        assert result.available is False
        assert "UNETLoader" in result.reason
        assert result.model_files == ()

    def test_nodes_present_but_only_non_sam3_unet_file_is_unavailable(self):
        # A file dropped anywhere in diffusion_models must not make this
        # report available -- it has to look SAM3-compatible.
        result = evaluate_sam3_availability(
            object_info_node_types=set(SAM3_REQUIRED_NODE_TYPES),
            unet_loader_filenames=["sd_xl_base_1.0.safetensors"],
        )
        assert result.nodes_present is True
        assert result.available is False
        assert result.model_files == ()

    def test_nodes_and_sam3_compatible_unet_file_present_is_available(self):
        result = evaluate_sam3_availability(
            object_info_node_types=set(SAM3_REQUIRED_NODE_TYPES),
            unet_loader_filenames=["sd_xl_base_1.0.safetensors", "sam3.1_multiplex_fp16.safetensors"],
        )
        assert result.nodes_present is True
        assert result.available is True
        assert result.model_files == ("sam3.1_multiplex_fp16.safetensors",)


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
