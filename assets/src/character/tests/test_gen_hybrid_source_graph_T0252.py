"""Hybrid source-frame generation graph -- T-0252 (HANDOFF §24-e) pure
construction tests. No ComfyUI/network dependency: makes the acceptance
criterion "one frame generated through the full stack (style LoRA + identity
LoRA + IP-Adapter + ControlNet)" checkable by a test, not merely asserted in
prose or provenance JSON -- the graph is built in-process here and inspected.

RED state: gen_hybrid_source_idle_T0252.py does not exist -> import fails,
every test ERRORs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_hybrid_source_idle_T0252 as gen  # noqa: E402


def _graph(**overrides) -> dict:
    defaults = dict(
        seed=31416,
        concept_filename="concept.png",
        pose_skeleton_filename="pose_skeleton.png",
        controlnet_strength=1.0,
        controlnet_end=1.0,
        ipadapter_weight=0.6,
        style_lora_weight=0.70,
        identity_lora_weight=0.50,
    )
    defaults.update(overrides)
    return gen.build_graph(**defaults)


def test_generation_canvas_is_384_matching_x8_descent() -> None:
    graph = _graph()
    latent_inputs = graph[gen.LATENT_NODE_ID]["inputs"]
    assert latent_inputs["width"] == 384
    assert latent_inputs["height"] == 384
    assert 384 // gen.FINAL_CELL_PX == 8


def test_descent_node_targets_48px_single_cell() -> None:
    graph = _graph()
    descend_inputs = graph[gen.DESCENT_NODE_ID]["inputs"]
    assert descend_inputs["width"] == gen.FINAL_CELL_PX == 48
    assert descend_inputs["height"] == gen.FINAL_CELL_PX == 48


def test_single_generation_batch_size_one() -> None:
    """Acceptance: exactly one frame is generated -- no batch, no grid."""
    graph = _graph()
    assert graph[gen.LATENT_NODE_ID]["inputs"]["batch_size"] == 1


def test_style_and_identity_lora_both_chained() -> None:
    graph = _graph(style_lora_weight=0.7, identity_lora_weight=0.5)
    style = graph[gen.STYLE_LORA_NODE_ID]
    identity = graph[gen.IDENTITY_LORA_NODE_ID]
    assert style["inputs"]["model"] == [gen.CHECKPOINT_NODE_ID, 0]
    assert style["inputs"]["strength_model"] == 0.7
    assert identity["inputs"]["model"] == [gen.STYLE_LORA_NODE_ID, 0]
    assert identity["inputs"]["strength_model"] == 0.5
    assert identity["inputs"]["lora_name"] == gen.IDENTITY_LORA_NAME


def test_ip_adapter_conditions_on_concept_image_after_identity_lora() -> None:
    """The full-stack claim this card makes: style LoRA -> identity LoRA ->
    IP-Adapter -> ControlNet, all present in a single generation -- not just
    Arm A's IP-Adapter-only or Arm B's identity-LoRA-only mechanism."""
    graph = _graph()
    ipadapter_loader = graph[gen.IPADAPTER_LOADER_NODE_ID]
    ipadapter = graph[gen.IPADAPTER_NODE_ID]
    assert ipadapter_loader["inputs"]["model"] == [gen.IDENTITY_LORA_NODE_ID, 0]
    assert ipadapter["inputs"]["image"] == [gen.CONCEPT_IMAGE_NODE_ID, 0]
    assert ipadapter["class_type"] == "IPAdapterAdvanced"
    assert ipadapter["inputs"]["weight"] == 0.6


def test_sampler_conditions_on_ip_adapter_model_output() -> None:
    graph = _graph()
    sampler_inputs = graph[gen.SAMPLER_NODE_ID]["inputs"]
    assert sampler_inputs["model"] == [gen.IPADAPTER_NODE_ID, 0]
    assert sampler_inputs["seed"] == 31416


def test_controlnet_conditions_on_the_pose_image_node() -> None:
    graph = _graph()
    controlnet_inputs = graph[gen.CONTROLNET_NODE_ID]["inputs"]
    assert controlnet_inputs["image"] == [gen.POSE_IMAGE_NODE_ID, 0]


def test_prompt_has_no_grid_or_contact_sheet_language() -> None:
    """Single-frame prompt -- no "3x3 grid"/"contact sheet" language a
    multi-cell arm's prompt would need."""
    graph = _graph()
    prompt_text = graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"].lower()
    for banned in ("3 by 3", "3x3", "nine panels", "nine separate", "contact sheet", "grid"):
        assert banned not in prompt_text, f"single-frame prompt still asks for a grid: {banned!r}"


def test_identity_lora_defaults_to_v2() -> None:
    """Round 2 continues on top of §24-a's player_identity_v2 (T-0248), not
    v1 -- masking §24-a's contribution would teach round 2 nothing about
    which change did the work."""
    assert gen.IDENTITY_LORA_NAME == "player_identity_v2.safetensors"


def test_attempt_cap_of_8_enforced() -> None:
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(9)
    gen.check_attempt_cap(8)  # must not raise
    gen.check_attempt_cap(1)  # must not raise
