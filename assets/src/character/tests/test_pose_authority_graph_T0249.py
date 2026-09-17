"""Pose-authority generation graph -- T-0249 (HANDOFF §24.4) pure
construction tests. No ComfyUI/network dependency: makes the acceptance
criterion "seed, initial latent and prompt are provably identical across all
frames" checkable by a test, not merely asserted in prose or provenance
JSON -- every frame's ComfyUI graph is built in-process here and compared.

RED state: gen_pose_authority_idle_T0249.py does not exist -> import fails,
every test ERRORs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_pose_authority_idle_T0249 as gen  # noqa: E402


def _graphs_for_all_frames(seed: int = 31416, frame_count: int = 9) -> list[dict]:
    return [
        gen.build_graph(
            seed=seed,
            pose_skeleton_filename=f"frame_{i}_pose_skeleton.png",
            controlnet_strength=1.3,
            controlnet_end=1.0,
            style_lora_weight=0.70,
            identity_lora_weight=0.50,
        )
        for i in range(frame_count)
    ]


def test_generation_canvas_is_384_matching_x8_descent() -> None:
    graph = _graphs_for_all_frames()[0]
    latent_inputs = graph[gen.LATENT_NODE_ID]["inputs"]
    assert latent_inputs["width"] == 384
    assert latent_inputs["height"] == 384
    assert 384 // gen.FINAL_CELL_PX == 8


def test_descent_node_targets_48px_cell_same_ratio_as_grid_path() -> None:
    graph = _graphs_for_all_frames()[0]
    descend_inputs = graph[gen.DESCENT_NODE_ID]["inputs"]
    assert descend_inputs["width"] == gen.FINAL_CELL_PX
    assert descend_inputs["height"] == gen.FINAL_CELL_PX
    assert gen.FINAL_CELL_PX == 48


def test_seed_latent_and_prompt_identical_across_all_frames() -> None:
    graphs = _graphs_for_all_frames()
    seeds = {g[gen.SAMPLER_NODE_ID]["inputs"]["seed"] for g in graphs}
    widths = {g[gen.LATENT_NODE_ID]["inputs"]["width"] for g in graphs}
    heights = {g[gen.LATENT_NODE_ID]["inputs"]["height"] for g in graphs}
    prompts = {g[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"] for g in graphs}
    negatives = {g[gen.NEGATIVE_PROMPT_NODE_ID]["inputs"]["text"] for g in graphs}
    samplers = {g[gen.SAMPLER_NODE_ID]["inputs"]["sampler_name"] for g in graphs}
    steps = {g[gen.SAMPLER_NODE_ID]["inputs"]["steps"] for g in graphs}
    cfgs = {g[gen.SAMPLER_NODE_ID]["inputs"]["cfg"] for g in graphs}

    assert len(seeds) == 1, "seed must be identical across every frame"
    assert len(widths) == 1 and len(heights) == 1, "initial latent size must be identical"
    assert len(prompts) == 1, "positive prompt must be identical across every frame"
    assert len(negatives) == 1, "negative prompt must be identical across every frame"
    assert len(samplers) == 1
    assert len(steps) == 1
    assert len(cfgs) == 1


def test_each_frame_conditions_on_its_own_distinct_pose_skeleton() -> None:
    """The only thing allowed to vary between frames."""
    graphs = _graphs_for_all_frames()
    filenames = {g[gen.POSE_IMAGE_NODE_ID]["inputs"]["image"] for g in graphs}
    assert len(filenames) == 9, "each frame must load its own emitted pose skeleton image"


def test_controlnet_conditions_on_the_pose_image_node() -> None:
    graph = _graphs_for_all_frames()[0]
    controlnet_inputs = graph[gen.CONTROLNET_NODE_ID]["inputs"]
    assert controlnet_inputs["image"] == [gen.POSE_IMAGE_NODE_ID, 0]


def test_identity_lora_defaults_to_v2_not_v1() -> None:
    """Limit 2: this card runs on top of T-0248 using player_identity_v2, not
    player_identity_v1 -- masking §24-a's contribution would teach round 2
    nothing about which change did the work."""
    assert gen.IDENTITY_LORA_NAME == "player_identity_v2.safetensors"


def test_prompt_has_no_grid_or_contact_sheet_language() -> None:
    """Each frame is its own 384x384 image, not a cell of a 3x3 contact-sheet
    grid (Arm A/B's approach) -- the prompt must not ask for one."""
    graph = _graphs_for_all_frames()[0]
    prompt_text = graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"].lower()
    for banned in ("3 by 3", "3x3", "nine panels", "nine separate", "contact sheet"):
        assert banned not in prompt_text, f"single-frame prompt still asks for a grid: {banned!r}"


def test_attempt_cap_of_8_enforced() -> None:
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(9)
    gen.check_attempt_cap(8)  # must not raise
    gen.check_attempt_cap(1)  # must not raise
