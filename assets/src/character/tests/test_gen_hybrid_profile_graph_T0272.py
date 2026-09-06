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

import pytest

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


# ---------------------------------------------------------------------------
# Round 3 (T-0272) -- the three isolations ARM_PROFILE_ATTEMPT_LOG_T0272.md's
# own round-2 finding recommends: Test A (prompt-token confound), Test B
# (IP-Adapter's front-facing image conditioning), Test D (a genuine
# side-profile IP-Adapter reference, stacked with the front concept sheet).
#
# RED state: build_graph does not yet accept include_pose_trigger_token /
# enable_ipadapter / secondary_concept_filename -> TypeError, every test in
# this section ERRORs.
# ---------------------------------------------------------------------------


def test_pose_trigger_token_can_be_omitted_from_the_encoded_prompt() -> None:
    """Test A's isolation: round 2 could not tell the pose LoRA's own learned
    weights apart from the fact that PROFILE_PROMPT always injects
    POSE_LORA_TRIGGER_TOKEN whenever the pose LoRA is stacked at all. This
    must be independently controllable."""
    graph = _graph(include_pose_trigger_token=False)
    positive_text = graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"]
    assert gen.POSE_LORA_TRIGGER_TOKEN not in positive_text
    assert gen.TRIGGER_TOKEN in positive_text  # costume token always present


def test_pose_trigger_token_present_by_default() -> None:
    graph = _graph()
    assert gen.POSE_LORA_TRIGGER_TOKEN in graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"]


def test_ipadapter_can_be_disabled_entirely() -> None:
    """Test B's isolation: IP-Adapter conditions on a front-facing concept-
    sheet crop on every attempt so far. Disabling it must remove the node
    from the graph (not merely zero its weight) and reroute the sampler's
    model input to the end of the LoRA chain directly."""
    graph = _graph(enable_ipadapter=False)
    assert gen.IPADAPTER_LOADER_NODE_ID not in graph
    assert gen.IPADAPTER_NODE_ID not in graph
    assert gen.CONCEPT_IMAGE_NODE_ID not in graph
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["model"] == [gen.POSE_LORA_NODE_ID, 0]


def test_ipadapter_enabled_by_default() -> None:
    graph = _graph()
    assert gen.IPADAPTER_LOADER_NODE_ID in graph
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["model"] == [gen.IPADAPTER_NODE_ID, 0]


def test_secondary_reference_image_chains_a_second_ipadapter_node() -> None:
    """Test D's isolation: stack a genuine side-profile reference alongside
    the front concept sheet, via a second IPAdapterAdvanced node chained
    after the first -- untested before this card (gen_hybrid_profile_T0272.py's
    own module comment)."""
    graph = _graph(secondary_concept_filename="profile_ref.png", secondary_ipadapter_weight=0.5)
    secondary = graph[gen.SECONDARY_IPADAPTER_NODE_ID]
    assert secondary["class_type"] == "IPAdapterAdvanced"
    assert secondary["inputs"]["model"] == [gen.IPADAPTER_NODE_ID, 0]
    assert secondary["inputs"]["image"] == [gen.SECONDARY_CONCEPT_IMAGE_NODE_ID, 0]
    assert secondary["inputs"]["weight"] == 0.5
    assert graph[gen.SECONDARY_CONCEPT_IMAGE_NODE_ID] == {
        "class_type": "LoadImage",
        "inputs": {"image": "profile_ref.png"},
    }
    assert graph[gen.SAMPLER_NODE_ID]["inputs"]["model"] == [gen.SECONDARY_IPADAPTER_NODE_ID, 0]


def test_no_secondary_reference_by_default() -> None:
    graph = _graph()
    assert gen.SECONDARY_IPADAPTER_NODE_ID not in graph
    assert gen.SECONDARY_CONCEPT_IMAGE_NODE_ID not in graph


def test_invert_reference_for_conditioning_flips_rgb_channels(tmp_path) -> None:
    """Test D's own follow-up: the T-0273 reference's off-white background
    bled into the generation and defeated cutout (round-3 attempt 12: only
    76 fg px survived). A pure RGB invert of the committed source, not a new
    reference, fixes the tone mismatch."""
    from PIL import Image

    src = tmp_path / "src.png"
    Image.new("RGB", (4, 4), color=(10, 20, 30)).save(src)
    dest = tmp_path / "dest.png"

    gen.invert_reference_for_conditioning(src, dest)

    out = Image.open(dest).convert("RGB")
    assert out.size == (4, 4)
    assert out.getpixel((0, 0)) == (245, 235, 225)


def test_append_attempt_log_row_matches_the_committed_header_column_count(
    tmp_path, monkeypatch
) -> None:
    """Discovered while writing up round 3: the committed attempt log's own
    header (`ARM_PROFILE_ATTEMPT_LOG_T0272.md`) has 11 columns including
    "Pose LoRA weight", but the row this function wrote for every round-3
    attempt (9-16) only ever had 10 cells -- pose_lora_weight was missing
    from the row entirely, silently shifting every later column (IP-Adapter
    weight, GPU seconds, gate, promoted) one slot left of its own header."""
    log_path = tmp_path / "ARM_PROFILE_ATTEMPT_LOG_T0272.md"
    monkeypatch.setattr(gen, "ATTEMPT_LOG_PATH", log_path)
    provenance = {
        "attempt": 99,
        "seed": 1,
        "controlnet_strength": 1.0,
        "controlnet_end_percent": 1.0,
        "style_lora_weight": 0.7,
        "identity_lora_weight": 0.5,
        "pose_lora_weight": 0.6,
        "ip_adapter_weight": 0.6,
        "gpu_seconds": 10.0,
        "mechanical_gate_passed": True,
    }
    gen.append_attempt_log(provenance, notes="x")
    header_line = next(
        line for line in log_path.read_text().splitlines() if line.startswith("| Attempt")
    )
    row_line = next(
        line
        for line in log_path.read_text().splitlines()
        if line.startswith("|") and line.split("|")[1].strip() == "99"
    )
    header_cols = [c.strip() for c in header_line.strip("|").split("|")]
    row_cols = [c.strip() for c in row_line.strip("|").split("|")]
    assert len(row_cols) == len(header_cols), (
        f"row has {len(row_cols)} cells, header has {len(header_cols)}: {row_cols!r}"
    )
    pose_lora_col = header_cols.index("Pose LoRA weight")
    assert row_cols[pose_lora_col] == "0.6"


def test_check_attempt_cap_allows_a_fresh_round_3_budget() -> None:
    """Round 3 gets its own fresh 8-attempt DL-21 budget on top of rounds
    1-2's spent 1..8 -- attempts 9..16, not a re-run of 1..8."""
    gen.check_attempt_cap(9)
    gen.check_attempt_cap(16)  # must not raise


def test_check_attempt_cap_allows_a_fresh_round_4_budget() -> None:
    """Round 4 gets its own fresh 8-attempt DL-21 budget on top of rounds
    1-3's spent 1..16 -- attempts 17..24, not a re-run of 1..16."""
    gen.check_attempt_cap(17)
    gen.check_attempt_cap(24)  # must not raise


def test_check_attempt_cap_allows_the_round_4_defect_fix_budget() -> None:
    """The round-4 reviewer FAIL required actually testing a costume-bearing
    secondary reference that round 4's own 17..24 budget never tried (defect
    2) -- a small, explicitly-scoped continuation budget, attempts 25..28,
    not a fresh 8-attempt round."""
    gen.check_attempt_cap(25)
    gen.check_attempt_cap(28)  # must not raise
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(29)


def test_prepare_secondary_reference_inverts_when_requested(tmp_path) -> None:
    """The default, unchanged behaviour for T-0273's dark-silhouette-on-light
    references (round 3 Test D)."""
    from PIL import Image

    src = tmp_path / "src.png"
    Image.new("RGB", (4, 4), color=(10, 20, 30)).save(src)
    dest = tmp_path / "dest.png"

    gen.prepare_secondary_reference(src, dest, needs_invert=True)

    out = Image.open(dest).convert("RGB")
    assert out.getpixel((0, 0)) == (245, 235, 225)


def test_prepare_secondary_reference_passes_through_when_already_toned(tmp_path) -> None:
    """T-0272's own derived style reference (derive_profile_style_reference_T0272.py)
    already forces its background to solid black -- the opposite tone problem
    T-0273's references had, so it must NOT be inverted a second time, or the
    correctly-black background would be flipped back to near-white and
    reintroduce exactly the bleed round 3's Test D fixed."""
    from PIL import Image

    src = tmp_path / "src.png"
    Image.new("RGB", (4, 4), color=(10, 20, 30)).save(src)
    dest = tmp_path / "dest.png"

    gen.prepare_secondary_reference(src, dest, needs_invert=False)

    out = Image.open(dest).convert("RGB")
    assert out.getpixel((0, 0)) == (10, 20, 30)
