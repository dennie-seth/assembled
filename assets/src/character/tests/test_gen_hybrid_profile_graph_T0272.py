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
    not a fresh 8-attempt round. (Attempt 29 is no longer expected to raise
    here -- round 5 opens its own fresh budget starting there; see
    test_check_attempt_cap_allows_a_fresh_round_5_budget for that boundary.)"""
    gen.check_attempt_cap(25)
    gen.check_attempt_cap(28)  # must not raise


def test_green_emphasis_upweights_the_costume_colour_phrase() -> None:
    """Round 5 Lever 2 ("stronger green emphasis in the prompt"): a ComfyUI
    A1111-style attention weight on the costume-colour phrase, plus an extra
    explicit institutional-green descriptor, distinguishes this from the
    plain unweighted phrase every prior attempt used."""
    plain = gen.build_positive_prompt(emphasize_green=False)
    emphasized = gen.build_positive_prompt(emphasize_green=True)
    assert "(vivid saturated institutional green costume colour:1.4)" in emphasized
    assert "(vivid saturated institutional green costume colour:1.4)" not in plain
    assert "vivid saturated green costume colour" in plain


def test_green_emphasis_off_by_default() -> None:
    assert "(vivid saturated institutional green costume colour:1.4)" not in gen.PROFILE_PROMPT


def test_negative_prompt_gains_anti_olive_terms_when_green_emphasized() -> None:
    """The muted-olive failure mode (attempts 24-28) is a specific, nameable
    colour drift, not just generic desaturation -- the plain negative prompt
    already covers "washed out"/"pale"/"desaturated", so the emphasized
    negative adds terms that specifically push away from olive/khaki/grey-green."""
    plain = gen.build_negative_prompt(emphasize_green=False)
    emphasized = gen.build_negative_prompt(emphasize_green=True)
    assert plain == gen.PROFILE_NEGATIVE
    assert "olive" in emphasized and "khaki" in emphasized
    assert "olive" not in plain


def test_negative_prompt_gains_anti_outline_terms_when_green_emphasized() -> None:
    """Attempts 24 and 28-34 all show a distinct 'glow collapse' failure mode
    whenever colour signal increases: a hard black outline plus a neon rim
    light, rather than clean flat-shaded pixel art -- and this same heavy
    outline is what bridges to the plain background under the cutout's
    Oklab-tolerance flood, fragmenting attempt 28's silhouette. Naming it in
    the negative prompt is the cheapest lever to try before any cutout
    changes."""
    emphasized = gen.build_negative_prompt(emphasize_green=True)
    assert "black outline" in emphasized
    assert "rim light" in emphasized or "glow" in emphasized


def test_build_graph_threads_green_emphasis_into_both_prompt_nodes() -> None:
    graph = _graph(emphasize_green=True)
    assert "(vivid saturated institutional green costume colour:1.4)" in (
        graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"]
    )
    assert "olive" in graph[gen.NEGATIVE_PROMPT_NODE_ID]["inputs"]["text"]


def test_build_graph_green_emphasis_off_by_default() -> None:
    graph = _graph()
    assert "(vivid saturated institutional green costume colour:1.4)" not in (
        graph[gen.POSITIVE_PROMPT_NODE_ID]["inputs"]["text"]
    )


def test_check_attempt_cap_allows_a_fresh_round_5_budget() -> None:
    """Round 5 ("vivid green on the profile") gets its own fresh 8-attempt
    DL-21 budget on top of rounds 1-4's spent 1..24 plus the round-4
    defect-fix continuation's 25..28 -- attempts 29..36, not a re-run of
    anything already spent. (Attempt 37 is no longer expected to raise here --
    round 6 (T-0317) opens its own fresh budget starting there; see
    test_check_attempt_cap_allows_a_fresh_round_6_budget for that boundary.)"""
    gen.check_attempt_cap(29)
    gen.check_attempt_cap(36)  # must not raise


def test_check_attempt_cap_allows_a_fresh_round_6_budget() -> None:
    """Round 6 (T-0317: the generated green-costume side reference wired into
    the secondary IP-Adapter slot, replacing the pose-only T-0273 photograph
    and the colour-thin derived crop both tried in rounds 3-5) gets its own
    fresh 8-attempt DL-21 budget on top of rounds 1-5's spent 1..36 --
    attempts 37..44, not a re-run of anything already spent. (Attempt 45 is
    no longer expected to raise here -- round 7 opens its own fresh budget
    starting there; see test_check_attempt_cap_allows_a_fresh_round_7_budget
    for that boundary.)"""
    gen.check_attempt_cap(37)
    gen.check_attempt_cap(44)  # must not raise


def test_check_attempt_cap_allows_a_fresh_round_7_budget() -> None:
    """Round 7 (T-0317 continuation, the reviewer's named next steps: fine-step
    the secondary IP-Adapter weight between attempt 39's 0.1 (coherent visual,
    gate-fails on background) and attempt 41's 0.15-0.3 (gate-passes at a
    different seed, but incoherent) while HOLDING attempt 39's own seed 31416
    fixed -- round 6 varied seed and weight together and never isolated this
    -- alongside a strengthened black-background prompt term to fix the
    multi-toned-background render that starved attempt 39's cutout) gets its
    own fresh 8-attempt DL-21 budget on top of rounds 1-6's spent 1..44 --
    attempts 45..52, not a re-run of anything already spent."""
    gen.check_attempt_cap(45)
    gen.check_attempt_cap(52)  # must not raise
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(53)


def test_positive_prompt_forbids_grey_and_multitone_background() -> None:
    """Round 6's attempt 39 (seed 31416, secondary weight 0.1) was the
    round's best coherent, green-legible visual, but its own render came out
    with a multi-toned grey background rather than the prompt's existing
    "solid flat black background" phrase -- `border_flood_background_mask`
    warned at generation time that the frame's border colours spanned
    13-33x its own classification tolerance. This is untried in round 6
    (named in ARM_PROFILE_ATTEMPT_LOG_T0272.md's own "what a follow-up would
    need to try" note): name the failure mode directly, not just its
    opposite ("solid flat black")."""
    assert "no grey background" in gen.PROFILE_PROMPT
    assert "no multi-tone background" in gen.PROFILE_PROMPT


def test_negative_prompt_forbids_grey_and_multitone_background() -> None:
    """Companion to the positive-prompt phrase above, present unconditionally
    (not gated behind emphasize_green, since this is a composition defect,
    not a costume-colour one)."""
    plain = gen.build_negative_prompt(emphasize_green=False)
    emphasized = gen.build_negative_prompt(emphasize_green=True)
    for terms_prompt in (plain, emphasized):
        assert "grey background" in terms_prompt
        assert "multi-toned background" in terms_prompt


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
