"""Side-profile keyframe generation graph -- T-0272 round 2 (post-T-0274)
pure construction tests. No ComfyUI/network dependency.

T-0274 trained `player_identity_profile_v1.safetensors` -- a pose-only LoRA,
explicitly "meant to be stacked with player_identity_v2 at generation time via
two distinct trigger tokens" (its own provenance/training-config notes,
`assets/final/lora/player_identity_profile_v1.provenance.json`). T-0274's own
smoke check only ever *swapped* it in for player_identity_v2 (isolation, and
against the *front* rig) -- the stacked combination, on THIS card's
profile-topology rig, has never been attempted. This module makes that stack
checkable in-process: style LoRA -> identity LoRA (costume, v2) -> pose LoRA
(profile_v1, chained after), both trigger tokens present, IP-Adapter and the
sampler drawing MODEL/CLIP from the pose LoRA node (the end of the chain).

RED state: gen_hybrid_profile_T0272.build_graph does not yet accept a
pose_lora_weight/pose_lora_name parameter -> TypeError, every test ERRORs.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_hybrid_profile_T0272 as gen  # noqa: E402


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
        pose_lora_weight=0.60,
    )
    defaults.update(overrides)
    return gen.build_graph(**defaults)


def test_pose_lora_chained_after_identity_lora() -> None:
    graph = _graph(pose_lora_weight=0.6)
    pose_lora = graph[gen.POSE_LORA_NODE_ID]
    assert pose_lora["class_type"] == "LoraLoader"
    assert pose_lora["inputs"]["model"] == [gen.IDENTITY_LORA_NODE_ID, 0]
    assert pose_lora["inputs"]["clip"] == [gen.IDENTITY_LORA_NODE_ID, 1]
    assert pose_lora["inputs"]["lora_name"] == gen.POSE_LORA_NAME
    assert pose_lora["inputs"]["strength_model"] == 0.6
    assert pose_lora["inputs"]["strength_clip"] == 0.6


def test_prompt_encoders_draw_clip_from_the_pose_lora_not_the_identity_lora() -> None:
    graph = _graph()
    assert graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["clip"] == [gen.POSE_LORA_NODE_ID, 1]
    assert graph[gen.NEGATIVE_PROMPT_NODE_ID]["inputs"]["clip"] == [gen.POSE_LORA_NODE_ID, 1]


def test_ip_adapter_conditions_on_the_pose_lora_model_not_the_identity_lora() -> None:
    graph = _graph()
    ipadapter_loader = graph[gen.IPADAPTER_LOADER_NODE_ID]
    assert ipadapter_loader["inputs"]["model"] == [gen.POSE_LORA_NODE_ID, 0]


def test_both_trigger_tokens_present_in_the_prompt() -> None:
    """The pose LoRA's own training-config notes: "meant to be stacked with
    player_identity_v2 ... via two distinct trigger tokens" -- checkable, not
    just asserted in prose."""
    prompt_text = gen.PROFILE_PROMPT
    assert gen.TRIGGER_TOKEN in prompt_text
    assert gen.POSE_LORA_TRIGGER_TOKEN in prompt_text


def test_pose_lora_name_is_the_t0274_trained_artifact() -> None:
    assert gen.POSE_LORA_NAME == "player_identity_profile_v1.safetensors"


def test_pose_lora_trigger_token_matches_its_training_config() -> None:
    assert gen.POSE_LORA_TRIGGER_TOKEN == "sbrutalistprofilepose"
