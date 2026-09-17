"""Enemy redesign concept-art generation graph -- T-0275 pure construction
tests. No ComfyUI/network dependency: builds each enemy's ComfyUI workflow
graph in-process and inspects it, so "three concept sheets realizing the
decided owl-head/robot/spider designs" is checkable by a test rather than
asserted only in prose or a provenance JSON.

Design direction (card body, "designs landed" comment):
  - watcher   (sight cone)   -> humanoid with an OWL HEAD
  - sound     (sound radius) -> a ROBOT, non-human, no face
  - still_air (proximity)    -> an EYELESS SPIDER, no eyes anywhere

Stealth-obstacle framing (GDD 07-items-economy.md, no combat): every enemy's
prompt/negative pair must exclude weapon/combat language.

RED state: gen_enemy_concept_T0275.py does not exist -> import fails, every
test ERRORs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_enemy_concept_T0275 as gen  # noqa: E402

EXPECTED_ENEMIES = {"watcher", "sound", "still_air"}

WEAPON_TERMS = ("weapon", "gun", "sword", "blade", "knife", "rifle", "armor", "armour")


def test_roster_is_exactly_the_three_named_sensor_roles() -> None:
    """Do not re-derive the roster -- GDD names exactly these three."""
    assert set(gen.ENEMY_SPECS.keys()) == EXPECTED_ENEMIES


@pytest.mark.parametrize("enemy", sorted(EXPECTED_ENEMIES))
def test_graph_is_pure_txt2img_no_control_or_init_image(enemy: str) -> None:
    """Concept art is a fresh design study -- no img2img/ControlNet conditioning."""
    graph = gen.build_graph(gen.ENEMY_SPECS[enemy])
    class_types = {node["class_type"] for node in graph.values()}
    assert "EmptyLatentImage" in class_types
    assert "LoadImage" not in class_types
    assert "ControlNetApply" not in class_types
    assert "VAEEncode" not in class_types


@pytest.mark.parametrize("enemy", sorted(EXPECTED_ENEMIES))
def test_graph_generates_single_1024_square_image(enemy: str) -> None:
    graph = gen.build_graph(gen.ENEMY_SPECS[enemy])
    latent = graph[gen.LATENT_NODE_ID]["inputs"]
    assert latent["width"] == 1024
    assert latent["height"] == 1024
    assert latent["batch_size"] == 1


@pytest.mark.parametrize("enemy", sorted(EXPECTED_ENEMIES))
def test_style_lora_applied_at_locked_weight(enemy: str) -> None:
    graph = gen.build_graph(gen.ENEMY_SPECS[enemy])
    lora = graph[gen.LORA_NODE_ID]
    assert lora["class_type"] == "LoraLoader"
    assert lora["inputs"]["lora_name"] == "soviet_brutalism_style_v1.safetensors"
    assert lora["inputs"]["strength_model"] == 0.70
    assert lora["inputs"]["model"] == [gen.CHECKPOINT_NODE_ID, 0]


@pytest.mark.parametrize("enemy", sorted(EXPECTED_ENEMIES))
def test_checkpoint_is_the_allowlisted_sdxl_base(enemy: str) -> None:
    graph = gen.build_graph(gen.ENEMY_SPECS[enemy])
    ckpt = graph[gen.CHECKPOINT_NODE_ID]
    assert ckpt["class_type"] == "CheckpointLoaderSimple"
    assert ckpt["inputs"]["ckpt_name"] == "sd_xl_base_1.0.safetensors"


@pytest.mark.parametrize("enemy", sorted(EXPECTED_ENEMIES))
def test_seeds_are_distinct_per_enemy(enemy: str) -> None:
    seeds = {name: spec["seed"] for name, spec in gen.ENEMY_SPECS.items()}
    assert len(set(seeds.values())) == len(seeds), f"duplicate seed: {seeds}"


@pytest.mark.parametrize("enemy", sorted(EXPECTED_ENEMIES))
def test_no_weapon_or_combat_language_in_prompt_or_negative(enemy: str) -> None:
    """Stealth obstacle, not a combatant -- GDD 07-items-economy.md: no combat."""
    spec = gen.ENEMY_SPECS[enemy]
    positive = spec["prompt"].lower()
    for term in WEAPON_TERMS:
        assert term not in positive, f"{enemy} prompt smuggles combat language: {term!r}"


def test_watcher_prompt_carries_owl_head_on_humanoid_body() -> None:
    prompt = gen.ENEMY_SPECS["watcher"]["prompt"].lower()
    assert "owl" in prompt
    assert "humanoid" in prompt or "human" in prompt
    assert "eye" in prompt  # acute-vision sensor role must read visually


def test_sound_prompt_is_non_human_and_faceless() -> None:
    spec = gen.ENEMY_SPECS["sound"]
    prompt = spec["prompt"].lower()
    negative = spec["negative_prompt"].lower()
    assert "robot" in prompt or "mechanical" in prompt
    assert "no face" in prompt or "no eyes" in prompt
    # The robot must not read as a character with a face -- inverting its
    # own sensor role is the one thing this design cannot do.
    assert "face" in negative
    assert "eyes" in negative


def test_still_air_prompt_and_negative_both_forbid_eyes() -> None:
    """The spider has NO eyes -- this is the design, not a stylistic option."""
    spec = gen.ENEMY_SPECS["still_air"]
    prompt = spec["prompt"].lower()
    negative = spec["negative_prompt"].lower()
    assert "spider" in prompt
    assert "no eyes" in prompt or "eyeless" in prompt
    assert "eye" in negative


def test_build_provenance_records_non_null_model_hash_and_resolvable_generator() -> None:
    record = gen.build_provenance(
        spec=gen.ENEMY_SPECS["watcher"],
        model_hash="deadbeef",
        workflow_hash_value="abc123",
        prompt_id="fake-prompt-id",
        concept_hash_value="fake-concept-hash",
    )
    assert record["model_hash"] == "deadbeef"
    assert record["model_hash"] is not None
    assert record["generator"] == gen.GENERATOR_ID
    assert record["concept_hash"] == "fake-concept-hash"
    assert record["seed"] == gen.ENEMY_SPECS["watcher"]["seed"]


def test_generator_id_is_a_bare_repo_relative_path() -> None:
    """P-7 resolvability: `generator` is a bare repo path, not free-text prose."""
    assert gen.GENERATOR_ID == "assets/src/character/gen_enemy_concept_T0275.py"
    assert not gen.GENERATOR_ID.startswith("/")
