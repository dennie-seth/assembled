"""T-0380 -- forward-limb ControlNet img2img generator, pure construction
tests. No ComfyUI/network dependency (mirrors
assets/src/concept/tests/test_gen_player_profile_costume_reference_T0317.py's
own no-network graph-construction pattern).

T-0355 falsified prompt-only pose control for this exact forward-limb
profile. This card's bet is structural, not a prompt tweak: img2img from
T-0317's own green side-profile base (VAE-encoded, not sampled from noise),
conditioned by an OpenPose ControlNet on the authored forward-limb skeleton
(`pose_rig_forward_limb_controlnet_T0380`). That is checkable directly on the
graph: it must contain a ControlNet node (T-0317's own graph deliberately
never did) and a VAEEncode node feeding the sampler (not EmptyLatentImage --
this is img2img, not txt2img).

RED state: gen_player_profile_forward_limb_controlnet_T0380 does not exist yet.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

import gen_player_profile_forward_limb_controlnet_T0380 as gen  # noqa: E402


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


# ── Graph structure: img2img + ControlNet, not T-0317's txt2img-only stack ──


def test_graph_has_a_controlnet_node():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert any("ControlNet" in ct for ct in class_types), (
        "this card's whole bet is pose-by-skeleton via ControlNet -- T-0317's own graph "
        "deliberately had none, but this is a structurally different card"
    )


def test_graph_has_a_vaeencode_node_not_an_empty_latent():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert "VAEEncode" in class_types, "img2img requires encoding the base image into the latent"
    assert "EmptyLatentImage" not in class_types, (
        "a fresh-noise latent would throw away the T-0317 base image entirely -- this must "
        "be img2img, not txt2img"
    )


def test_graph_denoise_is_threaded_through_and_less_than_one():
    graph = _graph(denoise=0.72)
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["denoise"] == 0.72
    assert sampler["inputs"]["denoise"] < 1.0, (
        "denoise=1.0 would discard the base image's own pixels entirely, same failure mode "
        "as a fresh EmptyLatentImage"
    )


def test_graph_controlnet_strength_and_end_percent_are_threaded_through():
    graph = _graph(controlnet_strength=1.55, controlnet_end=0.9)
    controlnet_node = graph[gen.CONTROLNET_APPLY_NODE_ID]
    assert controlnet_node["inputs"]["strength"] == 1.55
    assert controlnet_node["inputs"]["end_percent"] == 0.9


def test_graph_controlnet_conditions_on_the_skeleton_image_not_the_base():
    graph = _graph(skeleton_image_filename="my_skeleton.png", base_image_filename="my_base.png")
    skeleton_load = graph[gen.SKELETON_IMAGE_NODE_ID]
    base_load = graph[gen.BASE_IMAGE_NODE_ID]
    assert skeleton_load["inputs"]["image"] == "my_skeleton.png"
    assert base_load["inputs"]["image"] == "my_base.png"
    controlnet_node = graph[gen.CONTROLNET_APPLY_NODE_ID]
    assert controlnet_node["inputs"]["image"] == [gen.SKELETON_IMAGE_NODE_ID, 0]
    vae_encode = graph[gen.VAE_ENCODE_NODE_ID]
    assert vae_encode["inputs"]["pixels"] == [gen.BASE_IMAGE_NODE_ID, 0]


def test_graph_wires_style_then_identity_lora_chained():
    graph = _graph()
    style = graph[gen.STYLE_LORA_NODE_ID]
    identity = graph[gen.IDENTITY_LORA_NODE_ID]
    assert style["class_type"] == "LoraLoader"
    assert style["inputs"]["model"] == [gen.CHECKPOINT_NODE_ID, 0]
    assert identity["class_type"] == "LoraLoader"
    assert identity["inputs"]["model"] == [gen.STYLE_LORA_NODE_ID, 0]
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["model"] == [gen.IDENTITY_LORA_NODE_ID, 0]


def test_graph_is_1024_square():
    graph = _graph()
    assert graph[gen.SAMPLER_NODE_ID] is not None
    # 1024x1024 is the base-image canvas size feeding VAEEncode, not a
    # separate EmptyLatentImage -- assert on the module constant instead.
    assert gen.GEN_PX == 1024


def test_graph_seed_is_threaded_through():
    graph = _graph(seed=271828)
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["seed"] == 271828


def test_graph_has_no_ipadapter_node():
    """Deliberately no IP-Adapter: the base image is already the identity/
    costume/colour reference via img2img, and IP-Adapter's own structural
    conditioning competing with ControlNet's is exactly the kind of
    attention-budget fight T-0351's evidence blames for prior pose defects."""
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert not any("IPAdapter" in ct for ct in class_types)


# ── Prompt content ──────────────────────────────────────────────────────────


def test_positive_prompt_names_identity_elements():
    prompt = gen.build_positive_prompt().lower()
    for term in ("hood", "mask", "glove", "boot", "coat"):
        assert term in prompt, f"expected {term!r} in positive prompt"
    assert "past the knee" in prompt


def test_positive_prompt_asks_for_a_single_visible_arm_and_lens():
    prompt = gen.build_positive_prompt().lower()
    assert "single" in prompt
    assert "lens" in prompt


def test_positive_prompt_faces_right_not_left():
    prompt = gen.build_positive_prompt().lower()
    assert "facing right" in prompt or "faces right" in prompt
    assert "facing left" not in prompt and "faces left" not in prompt


def test_negative_prompt_forbids_three_quarter_and_double_visibility():
    negative = gen.build_negative_prompt().lower()
    for term in ("three-quarter", "both arms", "both eye"):
        assert term in negative, f"expected {term!r} in negative prompt"


def test_negative_prompt_does_not_ban_a_long_coat():
    """Unlike gen_master_sheet_T0336's mid-hip limb-pose negative prompt,
    this card's acceptance requires a coat reaching *past* the knee -- the
    negative prompt must not fight that."""
    negative = gen.build_negative_prompt().lower()
    assert "coat past the knee" not in negative
    assert "knee-length coat" not in negative


# ── Base-image compositing (T-0317 cutout -> 1024 black canvas) ────────────


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


# ── Measurement: reuse T-0317's green predicate + a border-blackness check ──


def test_measure_green_content_reuses_the_T0317_crop_convention():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    result = gen.measure_green_content(img)
    assert result["centred_crop_box"][2] - result["centred_crop_box"][0] == 187
    assert result["centred_crop_box"][3] - result["centred_crop_box"][1] == 200
    assert result["benchmark_green_band"] == [6000, 6900]


def test_measure_green_content_counts_a_known_green_patch():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    arr = np.array(img)
    arr[400:600, 400:600] = (10, 140, 10)  # squarely inside the centred crop, under the ceiling
    result = gen.measure_green_content(Image.fromarray(arr))
    assert result["centred_crop_green_pixels"] > 0


def test_measure_border_max_channel_is_zero_on_solid_black():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    assert gen.measure_border_max_channel(img, border=16) == 0


def test_measure_border_max_channel_flags_a_bright_border_pixel():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    arr = np.array(img)
    arr[5, 5] = (200, 0, 0)  # inside the 16px border band
    assert gen.measure_border_max_channel(Image.fromarray(arr), border=16) == 200


def test_measure_border_max_channel_ignores_a_bright_centre_pixel():
    img = Image.new("RGB", (1024, 1024), (0, 0, 0))
    arr = np.array(img)
    arr[512, 512] = (200, 0, 0)  # well inside the frame, outside the border band
    assert gen.measure_border_max_channel(Image.fromarray(arr), border=16) == 0
