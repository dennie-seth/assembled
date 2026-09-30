"""Rig-driven v2 regeneration graph -- T-0419 pure construction tests.

No ComfyUI/network dependency: makes this card's own claim ("each of the 6
Group-A sheets carries genuine `frame_generation` rig evidence, recovered
or regenerated through a rig-driven path") checkable for the regenerated
half (crouch-hide/die/move v2) by inspecting the ComfyUI graph and the
per-sheet frame/layout bookkeeping `gen_states_v2_rig_regen_T0419.py`
builds, in-process, mirroring the established pattern
`test_gen_hybrid_source_graph_T0252.py`/`test_gen_hybrid_profile_graph_T0272.py`
already use for this package's other per-frame generator scripts.

RED state: gen_states_v2_rig_regen_T0419.py does not exist -> import fails,
every test ERRORs.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_states_v2_rig_regen_T0419 as gen  # noqa: E402


def _graph(**overrides) -> dict:
    defaults = dict(
        seed=31420,
        concept_filename="concept.png",
        pose_skeleton_filename="pose_skeleton.png",
        prompt="a test prompt",
        negative="a test negative",
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
    """Every frame is its own independent generation -- no batch, no grid."""
    graph = _graph()
    assert graph[gen.LATENT_NODE_ID]["inputs"]["batch_size"] == 1


def test_denoise_is_always_1_no_chaining() -> None:
    """No img2img chain in this script -- see module docstring for why
    (no loop seam for crouch-hide/die, move's own rig is distinct from the
    walk's). Every frame samples fresh from EmptyLatentImage."""
    graph = _graph()
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["denoise"] == 1.0
    assert gen.LATENT_NODE_ID in graph
    assert graph[gen.LATENT_NODE_ID]["class_type"] == "EmptyLatentImage"


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
    assert sampler_inputs["seed"] == 31420


def test_controlnet_conditions_on_the_pose_image_node() -> None:
    """The genuine-rig claim, checkable in the graph itself: ControlNet is
    wired to POSE_IMAGE_NODE_ID, which _generate_one_frame renders from this
    sheet's own keypoints_fn output -- not a static or shared skeleton."""
    graph = _graph()
    controlnet_inputs = graph[gen.CONTROLNET_NODE_ID]["inputs"]
    assert controlnet_inputs["image"] == [gen.POSE_IMAGE_NODE_ID, 0]


def test_prompt_and_negative_are_parametrised_not_hardcoded() -> None:
    """Unlike gen_hybrid_walk_T0259.build_graph (one hardcoded WALK_PROMPT),
    this script drives 3 distinct sheets from one graph builder -- the
    prompt/negative must be genuinely per-call, not a module constant."""
    graph_a = _graph(prompt="prompt A", negative="negative A")
    graph_b = _graph(prompt="prompt B", negative="negative B")
    assert graph_a[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"] == "prompt A"
    assert graph_b[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"] == "prompt B"
    assert graph_a[gen.NEGATIVE_PROMPT_NODE_ID]["inputs"]["text"] == "negative A"


def test_identity_lora_defaults_to_v2() -> None:
    assert gen.IDENTITY_LORA_NAME == "player_identity_v2.safetensors"


# ---------------------------------------------------------------------------
# SHEET_CONFIGS / SheetConfig -- per-sheet frame/layout bookkeeping
# ---------------------------------------------------------------------------


def test_three_sheets_configured() -> None:
    assert set(gen.SHEET_CONFIGS) == {"crouch_hide", "die", "move"}


def test_crouch_hide_and_die_are_9_frame_3x3_no_spares() -> None:
    for key in ("crouch_hide", "die"):
        cfg = gen.SHEET_CONFIGS[key]
        assert (cfg.cols, cfg.rows, cfg.frame_count) == (3, 3, 9)
        assert cfg.real_frame_count == 9
        assert all(cfg.is_real_frame(i) for i in range(9))


def test_move_is_12_cell_3x4_with_2_spares() -> None:
    cfg = gen.SHEET_CONFIGS["move"]
    assert (cfg.cols, cfg.rows, cfg.frame_count) == (3, 4, 12)
    assert cfg.real_frame_count == 10
    assert all(cfg.is_real_frame(i) for i in range(10))
    assert not cfg.is_real_frame(10)
    assert not cfg.is_real_frame(11)


def test_frame_cells_are_row_major_matching_existing_v2_layout() -> None:
    """Matches the row-major (r, c) convention the OLD v2 provenance's own
    `layout.frame_cells` already used (T-0213), so this regeneration's
    layout is a like-for-like replacement, not a silent reshuffle."""
    crouch = gen.SHEET_CONFIGS["crouch_hide"]
    assert crouch.frame_cells == [
        (0, 0), (0, 1), (0, 2),
        (1, 0), (1, 1), (1, 2),
        (2, 0), (2, 1), (2, 2),
    ]
    move = gen.SHEET_CONFIGS["move"]
    assert move.frame_cells[:10] == [
        (0, 0), (0, 1), (0, 2),
        (1, 0), (1, 1), (1, 2),
        (2, 0), (2, 1), (2, 2),
        (3, 0),
    ]
    assert move.frame_cells[10:] == [(3, 1), (3, 2)]


def test_each_sheet_keypoints_fn_reuses_the_already_recovered_v1_rig() -> None:
    """The pose is not authored fresh for this card -- it is the SAME
    function T-0419's own v1 recovery already used and had reviewed."""
    from char_gen.rig_recovery_T0419 import (
        crouch_hide_frame_keypoints,
        die_frame_keypoints,
        move_frame_keypoints,
    )

    assert gen.SHEET_CONFIGS["crouch_hide"].keypoints_fn is crouch_hide_frame_keypoints
    assert gen.SHEET_CONFIGS["die"].keypoints_fn is die_frame_keypoints
    assert gen.SHEET_CONFIGS["move"].keypoints_fn is move_frame_keypoints


def test_final_name_matches_the_real_committed_asset_path() -> None:
    assert gen.SHEET_CONFIGS["crouch_hide"].final_name == "player_crouch_hide_sheet_v2"
    assert gen.SHEET_CONFIGS["die"].final_name == "player_die_sheet_v2"
    assert gen.SHEET_CONFIGS["move"].final_name == "player_move_sheet_v2"
