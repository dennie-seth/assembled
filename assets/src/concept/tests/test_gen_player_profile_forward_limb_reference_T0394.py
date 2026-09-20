"""T-0394 -- forward-limb reference generator, pure construction tests.
No ComfyUI/network dependency (mirrors
test_gen_player_profile_forward_limb_controlnet_T0387.py's own pattern).

Two structural changes from T-0387/T-0382/T-0380's own generator, per this
card's pre-registered experiment:

1. The near leg is resting (`pose_rig_forward_limb_controlnet_T0394`), not
   raised -- see that module's own tests.
2. The goggle lens comes from a **second pass**, scoped by a mask to the
   head bounding box only -- `compute_head_bbox` / `build_head_mask` /
   `composite_head_detail` are pure, GPU-free functions asserting the
   card's own "must not touch the arm, torso or leg outside its mask"
   requirement structurally, not by eye.

The full-frame pose pass itself (graph shape, denoise floor, ControlNet
strength/end, LoRA chain, 1024) is unchanged from T-0387/T-0382/T-0380 --
this card's own "Do not lower the full-frame pose pass below denoise 0.87"
and "Do not re-derive the far-arm collapse... or the LoRA stack".

RED state: gen_player_profile_forward_limb_reference_T0394 does not exist yet.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

import gen_player_profile_forward_limb_controlnet_T0387 as _t0387_gen  # noqa: E402
import gen_player_profile_forward_limb_reference_T0394 as gen  # noqa: E402
import pose_rig_forward_limb_controlnet_T0394 as pose_rig  # noqa: E402


def _graph(**overrides) -> dict:
    defaults = dict(
        seed=1,
        base_image_filename="base.png",
        skeleton_image_filename="skeleton.png",
        denoise=0.8,
        controlnet_strength=1.4,
        controlnet_end=1.0,
    )
    defaults.update(overrides)
    return gen.build_graph(**defaults)


# ── Fixed recipe: full-frame pose pass never moves (T-0394's own "Do not") ──


def test_default_denoise_is_never_below_0_87():
    assert gen.DEFAULT_DENOISE == 0.87


def test_pose_rig_module_is_this_cards_own_T0394_rig():
    assert gen.pose_rig is pose_rig


def test_graph_has_a_controlnet_node():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert any("ControlNet" in ct for ct in class_types)


def test_graph_has_a_vaeencode_node_not_an_empty_latent():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert "VAEEncode" in class_types
    assert "EmptyLatentImage" not in class_types


def test_graph_denoise_is_threaded_through_and_less_than_one():
    graph = _graph(denoise=0.87)
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["denoise"] == 0.87
    assert sampler["inputs"]["denoise"] < 1.0


def test_graph_controlnet_strength_and_end_percent_are_threaded_through():
    graph = _graph(controlnet_strength=1.5, controlnet_end=1.0)
    controlnet_node = graph[gen.CONTROLNET_APPLY_NODE_ID]
    assert controlnet_node["inputs"]["strength"] == 1.5
    assert controlnet_node["inputs"]["end_percent"] == 1.0


def test_graph_has_no_ipadapter_node():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert not any("IPAdapter" in ct for ct in class_types)


def test_graph_wires_style_then_identity_lora_chained():
    graph = _graph()
    style = graph[gen.STYLE_LORA_NODE_ID]
    identity = graph[gen.IDENTITY_LORA_NODE_ID]
    assert style["inputs"]["model"] == [gen.CHECKPOINT_NODE_ID, 0]
    assert identity["inputs"]["model"] == [gen.STYLE_LORA_NODE_ID, 0]


def test_graph_is_1024_square():
    assert gen.GEN_PX == 1024


def test_style_and_identity_lora_weights_match_the_fixed_recipe():
    assert gen.STYLE_LORA_WEIGHT == 0.70
    assert gen.IDENTITY_LORA_WEIGHT == 0.5


def test_attempt_cap_is_3():
    assert gen.MAX_ATTEMPTS == 3


def test_run_attempt_refuses_a_pose_pass_denoise_below_0_87():
    import pytest

    with pytest.raises(SystemExit):
        gen.run_attempt(attempt=1, seed=1, denoise=0.80)


# ── Prompt content: resting leg, no raised-leg language ─────────────────────


def test_positive_prompt_leg_clause_is_resting_not_raised():
    prompt = gen.build_positive_prompt().lower()
    assert "raised near leg" not in prompt
    assert "swept up" not in prompt
    assert "resting" in prompt


def test_positive_prompt_arm_clause_is_reverted_verbatim_to_T0382_baseline():
    """The single-arm fix is solved and must not be re-derived -- reuse the
    exact working clause verbatim, the same discipline T-0387 itself
    applied to the leg clause it wasn't touching."""
    arm_clause = (
        "(a single gloved hand reaching forward, pale light grey glove clearly lighter than the "
        "coat, fingers visible:1.2)"
    )
    assert arm_clause in gen.build_positive_prompt()


def test_negative_prompt_forbids_a_raised_or_lifted_leg():
    negative = gen.build_negative_prompt().lower()
    assert "raised leg" in negative or "lifted leg" in negative
    assert "hem swept up" in negative or "hem lifted" in negative or "kick" in negative


def test_positive_prompt_still_names_identity_elements():
    prompt = gen.build_positive_prompt().lower()
    for term in ("hood", "mask", "glove", "boot", "coat"):
        assert term in prompt
    assert "past the knee" in prompt


def test_positive_prompt_faces_right_not_left():
    prompt = gen.build_positive_prompt().lower()
    assert "facing right" in prompt or "faces right" in prompt
    assert "facing left" not in prompt and "faces left" not in prompt


def test_negative_prompt_still_forbids_three_quarter_and_double_visibility():
    negative = gen.build_negative_prompt().lower()
    for term in ("three-quarter", "both arms", "both eye"):
        assert term in negative


def test_positive_prompt_keeps_the_background_wording_unchanged():
    prompt = gen.build_positive_prompt().lower()
    assert "solid flat black background only" in prompt


# ── Detail pass: head bbox, mask, compositing (pure, GPU-free) ──────────────


def test_compute_head_bbox_is_within_canvas_and_above_the_neck():
    points = pose_rig.keypoints()
    left, top, right, bottom = gen.compute_head_bbox(points, canvas_size=1024)
    assert 0 <= left < right <= 1024
    assert 0 <= top < bottom <= 1024
    neck_y_px = points[1][1] * 1024
    assert bottom <= neck_y_px + 60, "head bbox should not extend far past the neck"


def test_compute_head_bbox_is_centred_on_the_head_cluster():
    points = pose_rig.keypoints()
    left, top, right, bottom = gen.compute_head_bbox(points, canvas_size=1024)
    nose_x_px = points[0][0] * 1024
    assert left < nose_x_px < right


def test_build_head_mask_is_zero_at_the_bbox_corners():
    """The mask must not reach the bbox rectangle's own edges -- this is
    what makes 'outside the mask' a real, unblended region rather than a
    soft-feathered edge that still touches the boundary."""
    mask = gen.build_head_mask((200, 220))
    arr = np.array(mask)
    assert arr[0, 0] == 0
    assert arr[0, -1] == 0
    assert arr[-1, 0] == 0
    assert arr[-1, -1] == 0


def test_build_head_mask_is_nonzero_at_the_centre():
    mask = gen.build_head_mask((200, 220))
    arr = np.array(mask)
    assert arr[110, 100] > 0


def test_build_head_mask_size_matches_request():
    mask = gen.build_head_mask((200, 220))
    assert mask.size == (200, 220)


def test_composite_head_detail_leaves_pixels_outside_the_bbox_untouched():
    base = Image.new("RGB", (1024, 1024), (0, 0, 0))
    base_arr = np.array(base)
    base_arr[300:900, 300:900] = (0, 180, 0)
    base = Image.fromarray(base_arr)

    bbox = (400, 0, 600, 200)
    detail_crop = Image.new("RGB", (200, 200), (255, 0, 0))
    mask = gen.build_head_mask((200, 200))

    result = gen.composite_head_detail(base, detail_crop, bbox, mask)
    result_arr = np.array(result)

    # Untouched outside the bbox entirely.
    assert tuple(result_arr[950, 950]) == (0, 180, 0)
    assert tuple(result_arr[10, 10]) == (0, 0, 0)
    # Untouched at the bbox's own corner, where the mask is zero.
    assert tuple(result_arr[0, 400]) == (0, 0, 0)


def test_composite_head_detail_blends_at_the_mask_centre():
    base = Image.new("RGB", (1024, 1024), (0, 0, 0))
    bbox = (400, 0, 600, 200)
    detail_crop = Image.new("RGB", (200, 200), (255, 0, 0))
    mask = gen.build_head_mask((200, 200))

    result = gen.composite_head_detail(base, detail_crop, bbox, mask)
    result_arr = np.array(result)
    centre = result_arr[100, 500]
    assert centre[0] > 0, "the mask centre should pick up the detail crop's red channel"


def test_composite_head_detail_output_size_matches_base():
    base = Image.new("RGB", (1024, 1024), (0, 0, 0))
    bbox = (400, 0, 600, 200)
    detail_crop = Image.new("RGB", (200, 200), (255, 0, 0))
    mask = gen.build_head_mask((200, 200))
    result = gen.composite_head_detail(base, detail_crop, bbox, mask)
    assert result.size == (1024, 1024)


def test_detail_pass_denoise_is_its_own_constant_not_the_pose_pass_denoise():
    """This card's own precise rule: the full-frame pose pass stays 0.87; a
    head-masked detail pass may use its own recorded strength. These must
    be distinct named constants, not the same value reused by accident."""
    assert gen.DETAIL_DENOISE != gen.DEFAULT_DENOISE
    assert 0.0 < gen.DETAIL_DENOISE < 1.0


def test_build_detail_graph_has_no_controlnet_node():
    """The detail pass is a texture-only mechanism -- no pose conditioning,
    it only needs the head region's existing shape plus a lens-focused
    prompt."""
    graph = gen.build_detail_graph(
        seed=1,
        crop_image_filename="crop.png",
        denoise=0.5,
    )
    class_types = {node["class_type"] for node in graph.values()}
    assert not any("ControlNet" in ct for ct in class_types)


def test_build_detail_graph_has_a_vaeencode_node():
    graph = gen.build_detail_graph(seed=1, crop_image_filename="crop.png", denoise=0.5)
    class_types = {node["class_type"] for node in graph.values()}
    assert "VAEEncode" in class_types


def test_build_detail_positive_prompt_mentions_a_single_lens():
    prompt = gen.build_detail_positive_prompt().lower()
    assert "lens" in prompt
    assert "circular" in prompt or "round" in prompt or "convex" in prompt


def test_build_detail_negative_prompt_forbids_two_lenses():
    negative = gen.build_detail_negative_prompt().lower()
    assert "two" in negative or "both" in negative or "second" in negative


# ── Base-image compositing (T-0317 cutout -> 1024 black canvas), reused ─────


def test_compose_base_on_canvas_produces_the_requested_square_size():
    base = Image.new("RGB", (175, 891), (0, 200, 0))
    canvas, offset_x, offset_y = gen.compose_base_on_canvas(base, canvas_size=1024)
    assert canvas.size == (1024, 1024)


def test_compose_base_on_canvas_centers_and_records_the_offset():
    base = Image.new("RGB", (100, 400), (0, 200, 0))
    canvas, offset_x, offset_y = gen.compose_base_on_canvas(base, canvas_size=1024)
    assert offset_x == (1024 - 100) // 2
    assert offset_y == (1024 - 400) // 2


def test_compose_base_on_canvas_preserves_base_pixels_and_blackens_the_rest():
    base = Image.new("RGB", (10, 20), (0, 255, 0))
    canvas, offset_x, offset_y = gen.compose_base_on_canvas(base, canvas_size=64)
    arr = np.array(canvas)
    assert tuple(arr[offset_y, offset_x]) == (0, 255, 0)
    assert tuple(arr[0, 0]) == (0, 0, 0)
    assert tuple(arr[-1, -1]) == (0, 0, 0)


# ── Measurement: reuse T-0317/T-0382's green + border predicates ───────────


def test_measure_green_content_reuses_the_T0317_crop_convention():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    result = gen.measure_green_content(img)
    assert result["centred_crop_box"][2] - result["centred_crop_box"][0] == 187
    assert result["centred_crop_box"][3] - result["centred_crop_box"][1] == 200
    assert result["benchmark_green_band"] == [6000, 6900]


def test_measure_border_max_channel_is_zero_on_solid_black():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    assert gen.measure_border_max_channel(img, border=16) == 0


def test_measure_border_max_channel_flags_a_bright_border_pixel():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    arr = np.array(img)
    arr[5, 5] = (200, 0, 0)
    assert gen.measure_border_max_channel(Image.fromarray(arr), border=16) == 200


# ── This card's own deliverable path (same final filename T-0382/T-0387 targeted) ─


def test_final_path_matches_T0382s_own_target_filename():
    assert gen.FINAL_PATH.name == "player_profile_forward_limb_reference_controlnet.png"
    assert gen.FINAL_PROVENANCE_PATH.name == (
        "player_profile_forward_limb_reference_controlnet.provenance.json"
    )
    assert gen.FINAL_PATH == _t0387_gen.FINAL_PATH
    assert gen.FINAL_PROVENANCE_PATH == _t0387_gen.FINAL_PROVENANCE_PATH


def test_attempt_log_path_is_this_cards_own_not_T0387s():
    assert gen.ATTEMPT_LOG_PATH.name == "ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0394.md"
    assert gen.ATTEMPT_LOG_PATH != _t0387_gen.ATTEMPT_LOG_PATH


def test_skeleton_paths_are_this_cards_own_not_T0387s():
    assert gen.SKELETON_PATH.name == "player_profile_forward_limb_skeleton_T0394.png"
    assert gen.SKELETON_KEYPOINTS_PATH.name == "player_profile_forward_limb_skeleton_T0394.json"


def test_mask_path_helper_is_this_cards_own_per_attempt():
    path = gen.mask_path_for_attempt(1)
    assert path.name == "player_profile_forward_limb_head_mask_T0394_attempt_1.png"
