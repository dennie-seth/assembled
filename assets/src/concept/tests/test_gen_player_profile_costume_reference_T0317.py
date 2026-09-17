"""T-0317 -- green-costume side-profile reference generator, pure construction
tests. No ComfyUI/network dependency (mirrors
assets/src/character/tests/test_gen_hybrid_profile_graph_T0272.py's own
no-network graph-construction pattern).

Why a *different* stack from T-0272's own §24-e (ControlNet + IP-Adapter +
identity/pose LoRA): T-0272's own round 3 finding is that ControlNet's
structural conditioning dominates the text prompt's camera-angle request,
which is exactly why 36 attempts across 5 rounds never produced a
side-facing, green-legible keyframe. This generator has neither ControlNet
nor IP-Adapter -- plain txt2img + the style LoRA only, the same stack T-0209
itself used (`player_character_concept_sheet_v1.recipe.json`) -- so prompt
steering has authority here it never had under §24-e. That is the whole bet
this card is making, and it is checkable structurally: this graph must not
contain a ControlNet or IP-Adapter node at all.

RED state: gen_player_profile_costume_reference_T0317 does not exist yet.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_CONCEPT_DIR = Path(__file__).resolve().parents[1]
if str(_CONCEPT_DIR) not in sys.path:
    sys.path.insert(0, str(_CONCEPT_DIR))

import gen_player_profile_costume_reference_T0317 as gen  # noqa: E402


def _graph(**overrides) -> dict:
    defaults = dict(seed=31700)
    defaults.update(overrides)
    return gen.build_graph(**defaults)


def test_graph_has_no_controlnet_node():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert not any("ControlNet" in ct for ct in class_types), (
        "this generator's whole premise is that it carries neither ControlNet nor "
        "IP-Adapter, unlike T-0272's own §24-e stack -- a ControlNet node here would "
        "silently reintroduce the exact structural override T-0272 round 3 blamed "
        "for 36 failed attempts"
    )


def test_graph_has_no_ipadapter_node():
    graph = _graph()
    class_types = {node["class_type"] for node in graph.values()}
    assert not any("IPAdapter" in ct for ct in class_types)


def test_graph_wires_style_lora_between_checkpoint_and_sampler():
    graph = _graph()
    lora = graph[gen.STYLE_LORA_NODE_ID]
    assert lora["class_type"] == "LoraLoader"
    assert lora["inputs"]["model"] == [gen.CHECKPOINT_NODE_ID, 0]
    assert lora["inputs"]["lora_name"] == gen.LORA_NAME
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["model"] == [gen.STYLE_LORA_NODE_ID, 0]


def test_graph_is_1024_square_matching_the_t0209_recipe():
    graph = _graph()
    latent = graph[gen.LATENT_NODE_ID]
    assert latent["inputs"]["width"] == 1024
    assert latent["inputs"]["height"] == 1024


def test_graph_seed_is_threaded_through():
    graph = _graph(seed=99999)
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["seed"] == 99999


def test_positive_prompt_names_the_green_cloth_coat_not_the_tactical_tier():
    prompt = gen.build_positive_prompt()
    assert "green" in prompt.lower()
    assert "coat" in prompt.lower()
    assert "tactical" not in prompt.lower()
    assert not re.search(r"\btan\b", prompt.lower())


def test_positive_prompt_asks_for_a_genuine_side_view():
    prompt = gen.build_positive_prompt()
    assert "side" in prompt.lower()
    assert "front" not in prompt.lower()


def test_negative_prompt_forbids_front_facing_and_tactical_costume_drift():
    negative = gen.build_negative_prompt()
    lowered = negative.lower()
    for term in ("front view", "grey tactical", "tan tactical", "khaki"):
        assert term in lowered, f"expected {term!r} in negative prompt"
