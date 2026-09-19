"""T-0387 -- forward-limb ControlNet img2img generator, pure construction
tests. No ComfyUI/network dependency (mirrors
test_gen_player_profile_forward_limb_controlnet_T0380.py's own pattern).

T-0387 continues T-0382's stop-and-report (`docs/assets/evidence/T-0382/README.md`)
by holding the fixed recipe -- denoise 0.87, ControlNet 1.5/1.0, style/identity
LoRA 0.70/0.50, no IP-Adapter, 1024 -- and moving only the skeleton
(`pose_rig_forward_limb_controlnet_T0387`) and the prompt text. These tests
pin the graph structure is unchanged from T-0380/T-0382 (same recipe, only
the pose/prompt inputs move) and that the prompt text was actually
strengthened for the two measured defects: the goggle lens (attempt 1: no
lens visible at all; attempt 3: a strap-like band, not a legible lens) and
the raised near leg (attempt 1 "legs flat"; attempt 3 "both feet together
at rest").

RED state: gen_player_profile_forward_limb_controlnet_T0387 does not exist yet.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

import gen_player_profile_forward_limb_controlnet_T0380 as _t0382_gen  # noqa: E402
import gen_player_profile_forward_limb_controlnet_T0387 as gen  # noqa: E402
import pose_rig_forward_limb_controlnet_T0387 as pose_rig  # noqa: E402


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


# ── Fixed recipe: never lowered, never re-derived (T-0387's own "Do not") ───


def test_default_denoise_is_never_below_0_87():
    """T-0387's own 'Do not lower denoise below 0.87' -- this is the
    hard-held constant, not a per-attempt argument default that could
    silently drift."""
    assert gen.DEFAULT_DENOISE == 0.87


def test_pose_rig_module_is_this_cards_own_T0387_rig():
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
    """This card's own pre-registered hard cap."""
    import argparse
    import io
    import contextlib

    parser = argparse.ArgumentParser()
    # main() enforces the cap at runtime; assert the constant it checks against
    # directly instead of invoking argv-parsing/network code here.
    assert gen.MAX_ATTEMPTS == 3


# ── Prompt content: the two measured defects this card targets ─────────────


def test_positive_prompt_strengthens_the_goggle_lens_beyond_T0382():
    """Attempt 1 showed no lens at all; attempt 3 showed a strap-like band
    instead of a legible lens. The prompt must now explicitly rule out a
    strap/blindfold reading and describe the lens as a distinct circular
    object, not just repeat T-0382's own weaker 'a single dark round
    goggle lens' clause verbatim."""
    prompt = gen.build_positive_prompt().lower()
    old_prompt = _t0382_gen.build_positive_prompt().lower()
    assert prompt != old_prompt
    assert "lens" in prompt
    assert "circular" in prompt or "convex" in prompt
    negative = gen.build_negative_prompt().lower()
    assert "blindfold" in negative or "strap" in negative


def test_positive_prompt_strengthens_the_raised_leg_beyond_T0382():
    """Attempt 1 'legs flat'; attempt 3 'both feet together at rest, no
    lifted hem'. The prompt must explicitly describe the foot as clear of
    the ground, not just repeat T-0382's weaker hem-only clause."""
    prompt = gen.build_positive_prompt().lower()
    old_prompt = _t0382_gen.build_positive_prompt().lower()
    assert prompt != old_prompt
    assert "clear of the" in prompt or "off the ground" in prompt or "mid-air" in prompt
    negative = gen.build_negative_prompt().lower()
    assert "feet together" in negative or "both feet planted" in negative or "idle stance" in negative


def test_positive_prompt_reinforces_solid_black_background():
    """T-0382 attempt 1 measured border max channel 45, over the 16
    ceiling -- reinforcing 'pure black, no vignette/glow' is this card's
    only lever on that check besides the skeleton."""
    prompt = gen.build_positive_prompt().lower()
    assert "vignette" in prompt or "glow" in prompt
    negative = gen.build_negative_prompt().lower()
    assert "vignette" in negative or "glow" in negative


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


def test_negative_prompt_does_not_ban_a_long_coat():
    negative = gen.build_negative_prompt().lower()
    assert "coat past the knee" not in negative
    assert "knee-length coat" not in negative


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


# ── This card's own deliverable path (same final filename T-0382 targeted) ─


def test_final_path_matches_T0382s_own_target_filename():
    """T-0382 never promoted anything; this card continues aiming at the
    same committed filename its own acceptance text names."""
    assert gen.FINAL_PATH.name == "player_profile_forward_limb_reference_controlnet.png"
    assert gen.FINAL_PROVENANCE_PATH.name == (
        "player_profile_forward_limb_reference_controlnet.provenance.json"
    )


def test_attempt_log_path_is_this_cards_own_not_T0382s():
    assert gen.ATTEMPT_LOG_PATH.name == "ARM_FORWARD_LIMB_REFERENCE_CONTROLNET_ATTEMPT_LOG_T0387.md"
    assert gen.ATTEMPT_LOG_PATH != _t0382_gen.ATTEMPT_LOG_PATH


def test_skeleton_paths_are_this_cards_own_not_T0382s():
    assert gen.SKELETON_PATH.name == "player_profile_forward_limb_skeleton_T0387.png"
    assert gen.SKELETON_KEYPOINTS_PATH.name == "player_profile_forward_limb_skeleton_T0387.json"
