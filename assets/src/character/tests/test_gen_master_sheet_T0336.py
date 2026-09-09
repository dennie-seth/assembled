"""Tier-1 master-sheet generation graph tests (T-0336).

Pure construction tests -- no ComfyUI/network dependency. This card
generates ONCE PER ENTITY at 1024px (docs/decision-log.md DL-30;
`asset-pipeline-review-2026-09-09.md`, approved 2026-09-09): style LoRA +
IP-Adapter on the approved concept sheet, explicitly NO ControlNet -- the
review's own finding is that the identity LoRAs were trained at 1024 and
every incoherent render in the repo was sampled at 384. These tests pin
that recipe mechanically (no ControlNet node ever appears, latent
dimensions never default to 384) and the entity-parameter surface future
enemy cards reuse unchanged (a new `EntitySpec` registered in `ENTITIES`,
never a change to `build_graph`/`run_attempt`).

RED state: gen_master_sheet_T0336 does not exist yet -> ModuleNotFoundError,
every test in this file ERRORs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_T0336 as gen  # noqa: E402


def _graph(**overrides) -> dict:
    defaults = dict(
        seed=31416,
        concept_filename="concept.png",
        positive_text="a prompt",
        negative_text="a negative prompt",
        style_lora_weight=0.70,
        ipadapter_weight=0.5,
        width=1024,
        height=1024,
    )
    defaults.update(overrides)
    return gen.build_graph(**defaults)


# ── Recipe guardrails: no ControlNet, never 384 ─────────────────────────────


def test_no_controlnet_node_anywhere() -> None:
    graph = _graph(identity_lora_name="player_identity_v2.safetensors", identity_lora_weight=0.5)
    assert all("ControlNet" not in node["class_type"] for node in graph.values())


def test_no_pose_skeleton_input_anywhere() -> None:
    graph = _graph()
    for node in graph.values():
        assert "pose" not in node["class_type"].lower()
        assert "skeleton" not in str(node["inputs"]).lower()


def test_latent_dimensions_are_1024_by_default() -> None:
    graph = _graph()
    latent = graph[gen.LATENT_NODE_ID]
    assert latent["inputs"]["width"] == 1024
    assert latent["inputs"]["height"] == 1024


def test_latent_dimensions_never_default_to_384() -> None:
    assert gen.DEFAULT_MASTER_SHEET_PX != 384
    assert gen.DEFAULT_MASTER_SHEET_PX == 1024


# ── Graph wiring ─────────────────────────────────────────────────────────


def test_style_lora_applied_to_checkpoint() -> None:
    graph = _graph()
    style = graph[gen.STYLE_LORA_NODE_ID]
    assert style["class_type"] == "LoraLoader"
    assert style["inputs"]["model"] == [gen.CHECKPOINT_NODE_ID, 0]
    assert style["inputs"]["lora_name"] == gen.LORA_NAME
    assert style["inputs"]["strength_model"] == 0.70
    assert style["inputs"]["strength_clip"] == 0.70


def test_identity_lora_omitted_by_default() -> None:
    graph = _graph()
    assert gen.IDENTITY_LORA_NODE_ID not in graph
    ipadapter_loader = graph[gen.IPADAPTER_LOADER_NODE_ID]
    assert ipadapter_loader["inputs"]["model"] == [gen.STYLE_LORA_NODE_ID, 0]


def test_identity_lora_when_provided_chains_after_style() -> None:
    graph = _graph(identity_lora_name="player_identity_v2.safetensors", identity_lora_weight=0.5)
    identity = graph[gen.IDENTITY_LORA_NODE_ID]
    assert identity["class_type"] == "LoraLoader"
    assert identity["inputs"]["model"] == [gen.STYLE_LORA_NODE_ID, 0]
    assert identity["inputs"]["clip"] == [gen.STYLE_LORA_NODE_ID, 1]
    assert identity["inputs"]["lora_name"] == "player_identity_v2.safetensors"
    assert identity["inputs"]["strength_model"] == 0.5
    ipadapter_loader = graph[gen.IPADAPTER_LOADER_NODE_ID]
    assert ipadapter_loader["inputs"]["model"] == [gen.IDENTITY_LORA_NODE_ID, 0]


def test_prompt_encoders_draw_clip_from_last_lora_in_chain() -> None:
    graph = _graph(identity_lora_name="x.safetensors", identity_lora_weight=0.4)
    assert graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["clip"] == [gen.IDENTITY_LORA_NODE_ID, 1]
    assert graph[gen.NEGATIVE_PROMPT_NODE_ID]["inputs"]["clip"] == [gen.IDENTITY_LORA_NODE_ID, 1]


def test_prompt_encoders_use_positive_and_negative_text() -> None:
    graph = _graph(positive_text="POS", negative_text="NEG")
    assert graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"] == "POS"
    assert graph[gen.NEGATIVE_PROMPT_NODE_ID]["inputs"]["text"] == "NEG"


def test_ipadapter_conditions_on_the_concept_image() -> None:
    graph = _graph(concept_filename="concept.png", ipadapter_weight=0.5)
    assert graph[gen.CONCEPT_IMAGE_NODE_ID] == {
        "class_type": "LoadImage",
        "inputs": {"image": "concept.png"},
    }
    ipadapter = graph[gen.IPADAPTER_NODE_ID]
    assert ipadapter["class_type"] == "IPAdapterAdvanced"
    assert ipadapter["inputs"]["image"] == [gen.CONCEPT_IMAGE_NODE_ID, 0]
    assert ipadapter["inputs"]["weight"] == 0.5


def test_sampler_draws_model_from_ipadapter_node_and_prompts_directly() -> None:
    """No ControlNet in this recipe -- the sampler's positive/negative come
    straight from the CLIPTextEncode nodes, not from a ControlNetApplyAdvanced
    pass-through."""
    graph = _graph()
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["model"] == [gen.IPADAPTER_NODE_ID, 0]
    assert sampler["inputs"]["positive"] == [gen.POSITIVE_PROMPT_NODE_ID, 0]
    assert sampler["inputs"]["negative"] == [gen.NEGATIVE_PROMPT_NODE_ID, 0]


def test_seed_threaded_into_sampler() -> None:
    graph = _graph(seed=99999)
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["seed"] == 99999


def test_vae_decode_and_save_wired_from_sampler() -> None:
    graph = _graph()
    decode = graph[gen.VAE_DECODE_NODE_ID]
    assert decode["inputs"]["samples"] == [gen.SAMPLER_NODE_ID, 0]
    save = graph[gen.MAIN_SAVE_NODE_ID]
    assert save["class_type"] == "SaveImage"
    assert save["inputs"]["images"] == [gen.VAE_DECODE_NODE_ID, 0]


# ── Entity parameterisation: enemy cards reuse this unchanged ──────────────


def test_player_entity_registered_with_t0209_concept_sheet() -> None:
    player = gen.ENTITIES["player"]
    assert player.name == "player"
    assert (
        player.concept_hash == "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"
    )
    assert player.identity_lora_name == "player_identity_v2.safetensors"
    assert player.trigger_token == "sbrutalistplayer"


def test_build_positive_prompt_includes_entity_trigger_token_and_costume() -> None:
    player = gen.ENTITIES["player"]
    prompt = gen.build_positive_prompt(player)
    assert player.trigger_token in prompt
    assert "institutional green coat" in prompt


def test_build_positive_prompt_requests_front_side_back_and_limb_parts() -> None:
    player = gen.ENTITIES["player"]
    prompt = gen.build_positive_prompt(player).lower()
    for term in (
        "front",
        "side",
        "back",
        "upper arm",
        "lower arm",
        "upper leg",
        "lower leg",
        "head",
        "torso",
    ):
        assert term in prompt, f"{term!r} missing from master-sheet prompt"


def test_build_negative_prompt_forbids_perspective_and_inconsistent_identity() -> None:
    negative = gen.build_negative_prompt()
    assert "perspective" in negative
    assert "inconsistent identity" in negative or "different costume" in negative


def test_build_positive_prompt_requests_a_visible_face_on_whole_figure_views() -> None:
    """T-0336 review round 2 shipped a promoted sheet with blank white
    mannequin heads on every whole-figure panel -- 'a real character, not a
    striped/circuit-board artefact' also means a head with an actual face,
    not a featureless void where one belongs."""
    player = gen.ENTITIES["player"]
    prompt = gen.build_positive_prompt(player).lower()
    assert "face" in prompt


def test_build_negative_prompt_forbids_blank_heads_and_armour_drift() -> None:
    """T-0336 review round 2's promoted sheet shipped headless mannequins in
    the top half and drifted to heavier armour plating in the bottom half --
    both defects a human reviewer caught by opening the file, neither one
    forbidden by the prompt at the time."""
    negative = gen.build_negative_prompt().lower()
    assert "faceless" in negative or "blank head" in negative
    assert "armor" in negative or "armour" in negative


def test_build_negative_prompt_forbids_cropped_heads_and_robotic_legs() -> None:
    """Round 3's own retry (a 'rigging reference sheet' framing) traded the
    blank-head defect for a head cropped out of frame and traded garment
    legs for robotic/mechanical ones -- lock both out explicitly rather than
    relying on wording that happened to avoid them this time."""
    negative = gen.build_negative_prompt().lower()
    assert "head cut off" in negative or "cropped head" in negative
    assert "robot" in negative or "mechanical legs" in negative


def test_registering_a_new_entity_requires_no_generator_code_change() -> None:
    """The card's own reuse requirement: an enemy card adds a new EntitySpec
    to ENTITIES (data), it never edits build_graph/run_attempt."""
    enemy = gen.EntitySpec(
        name="test_enemy",
        concept_sheet_path=Path("dummy.png"),
        concept_hash="deadbeef",
        identity_lora_name=None,
        identity_lora_path=None,
        identity_lora_provenance_path=None,
        identity_lora_weight=0.0,
        trigger_token="senemytoken",
        costume_description="chitin plating",
    )
    prompt = gen.build_positive_prompt(enemy)
    assert "senemytoken" in prompt
    assert "chitin plating" in prompt


def test_check_attempt_cap_allows_a_small_budget_not_a_sweep() -> None:
    """25-50 GPU-second budget: this is a small job, not an 84-attempt
    sweep (T-0272/T-0317's own failure mode). Cap stays low."""
    gen.check_attempt_cap(1)
    gen.check_attempt_cap(5)  # must not raise
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(6)


# ── Attempt log + promotion bookkeeping ─────────────────────────────────


def test_append_attempt_log_writes_header_then_row(tmp_path, monkeypatch) -> None:
    log_path = tmp_path / "ARM_MASTER_SHEET_ATTEMPT_LOG_T0336.md"
    monkeypatch.setattr(gen, "ATTEMPT_LOG_PATH", log_path)
    provenance = {
        "attempt": 1,
        "entity": "player",
        "seed": 31416,
        "style_lora_weight": 0.70,
        "identity_lora_weight": 0.50,
        "ip_adapter_weight": 0.5,
        "width": 1024,
        "height": 1024,
        "gpu_seconds": 30.0,
        "promoted": False,
    }
    gen.append_attempt_log(provenance, notes="first try")
    text = log_path.read_text()
    header_line = next(line for line in text.splitlines() if line.startswith("| Attempt"))
    row_line = next(
        line for line in text.splitlines() if line.startswith("|") and "player" in line
    )
    header_cols = [c.strip() for c in header_line.strip("|").split("|")]
    row_cols = [c.strip() for c in row_line.strip("|").split("|")]
    assert len(row_cols) == len(header_cols)


def test_promote_attempt_copies_sheet_and_provenance_into_assets_src(tmp_path, monkeypatch) -> None:
    """Master sheets are pipeline inputs, not game-scale finals -- committed
    under assets/src/, not assets/final/ (this card's own acceptance
    criterion, a deliberate departure from earlier keyframe cards)."""
    final_dir = tmp_path / "master_sheets"
    monkeypatch.setattr(gen, "MASTER_SHEETS_DIR", final_dir)

    out_dir = tmp_path / "attempt_1"
    out_dir.mkdir()
    (out_dir / "master_sheet_1024.png").write_bytes(b"fake-png-bytes")
    provenance = {"attempt": 1, "entity": "player"}

    gen.promote_attempt("player", out_dir, provenance)

    assert (final_dir / "player_master_sheet_T0336.png").read_bytes() == b"fake-png-bytes"
    written = (final_dir / "player_master_sheet_T0336.provenance.json").read_text()
    assert '"promoted": true' in written
