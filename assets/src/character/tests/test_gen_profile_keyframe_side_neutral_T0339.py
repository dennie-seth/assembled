"""T-0339 RE-SCOPE (2026-09-11): generate the `side_neutral` master-sheet
panel, then descend it -- pure construction/string tests, no ComfyUI/network
dependency, same convention as `test_gen_master_sheet_T0351.py`.

The card's prior descent-only route (superseded, see ASSET_PROVENANCE.md) was
found to descend a 175x891 CROP, not a genuine square 1024 render, and
produced an illegible result. T-0351's own finding is that its `side_neutral`
panel -- a true 90-degree standing side profile, arms down -- converged
cleanly on three consecutive attempts (19, 20, 21) under its per-panel
reference-conditioning recipe. This card regenerates ONLY that one panel
(reusing `gen_master_sheet_T0336`/`pose_rig_master_sheet_T0351` unchanged --
no new prompt tuning, no seed sweep) and descends the accepted result through
the same `char_gen` cutout primitives every other keyframe in this pipeline
already uses.

RED state: `gen_profile_keyframe_side_neutral_T0339` does not exist yet ->
ModuleNotFoundError, all tests ERROR.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_T0336 as gen  # noqa: E402
import gen_profile_keyframe_side_neutral_T0339 as sn  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[4]


# ── Recipe constants: attempts 19-21's own values, unchanged ───────────────


def test_style_lora_weight_matches_t0351_recipe() -> None:
    assert sn.STYLE_LORA_WEIGHT == 0.70


def test_ipadapter_weight_matches_t0351_recipe() -> None:
    assert sn.IPADAPTER_WEIGHT == 0.35


def test_identity_lora_weight_matches_t0351_recipe() -> None:
    assert gen.ENTITIES[sn.ENTITY_NAME].identity_lora_weight == 0.5


def test_pose_key_is_side_neutral() -> None:
    assert sn.POSE_KEY == "side_neutral"


def test_default_px_is_1024() -> None:
    assert sn.DEFAULT_PX == 1024


# ── Attempt cap: THREE, hard, per the card's RE-SCOPE section ──────────────


def test_attempt_cap_is_three() -> None:
    assert sn.ATTEMPT_CAP == 3


def test_seed_for_attempt_returns_a_known_good_seed_for_each_allowed_attempt() -> None:
    seeds = [sn.seed_for_attempt(i) for i in (1, 2, 3)]
    assert len(set(seeds)) == 3, "each attempt must use a distinct seed"
    assert all(isinstance(s, int) for s in seeds)


def test_seed_for_attempt_refuses_a_fourth_attempt() -> None:
    import pytest

    with pytest.raises(SystemExit):
        sn.seed_for_attempt(4)


def test_known_good_seeds_are_t0351_side_neutral_seeds() -> None:
    """`side_neutral` is POSE_SPECS index 4; T-0351's own
    `run_five_pose_attempt` seeds each pose `base_seed + index`. Attempts 19,
    20, 21 logged base_seed 521365981 / 674839201 / 837462910, so
    `side_neutral`'s own seed each time was base_seed + 4."""
    pose_index = [p.key for p in gen.POSE_SPECS].index("side_neutral")
    assert pose_index == 4
    base_seeds_1920_21 = (521365981, 674839201, 837462910)
    expected = {b + pose_index for b in base_seeds_1920_21}
    assert set(sn.KNOWN_GOOD_SEEDS) == expected


# ── Pose/reference resolution: reused unchanged from gen_master_sheet_T0336 ─


def test_side_neutral_pose_resolves_the_shared_pose_spec() -> None:
    pose = sn.side_neutral_pose()
    assert pose.key == "side_neutral"
    assert pose is next(p for p in gen.POSE_SPECS if p.key == "side_neutral")


def test_side_neutral_references_the_committed_t0317_reference() -> None:
    """side_neutral must condition on the T-0317 profile reference (whole
    image, no crop) -- the same per-panel reference T-0351 registered, not a
    concept-sheet crop."""
    path, crop_box = gen.reference_image_for("T-0351", sn.ENTITY_NAME, "side_neutral")
    assert path == gen.PROFILE_REFERENCE_T0317_PATH
    assert crop_box is None


# ── Namespacing: this card gets its own out_dir/attempt-log/evidence paths ─


def test_out_dir_for_attempt_uses_this_cards_own_namespace() -> None:
    out_dir = sn.out_dir_for_attempt(1)
    assert out_dir == gen.out_dir_for("T-0339", sn.ENTITY_NAME, 1)
    assert "T0339" in str(out_dir)


def test_evidence_panel_path_is_under_this_cards_evidence_dir() -> None:
    path = sn.evidence_panel_path(2)
    assert path.parent == REPO_ROOT / "docs" / "assets" / "evidence" / "T-0339"
    assert path.name == "side_neutral_attempt_2_1024.png"


# ── Provenance construction: pure, given precomputed fields ────────────────


def _fake_generation_record(attempt: int = 1) -> dict:
    return {
        "attempt": attempt,
        "seed": sn.seed_for_attempt(attempt),
        "comfyui_prompt_id": "fake-prompt-id",
        "gpu_seconds": 42.0,
        "positive_prompt": "fake positive prompt",
        "negative_prompt": "fake negative prompt",
        "reference_path": gen.PROFILE_REFERENCE_T0317_PATH,
        "reference_hash": "f" * 64,
        "reference_square_padded": True,
        "style_lora_hash": "a" * 64,
        "identity_lora_hash": "b" * 64,
    }


def test_build_generation_provenance_records_the_full_diffusion_stack() -> None:
    record = sn.build_generation_provenance(_fake_generation_record())
    assert record["model_hash"]
    assert record["style_lora_weight"] == 0.70
    assert record["style_lora_hash"] == "a" * 64
    assert record["identity_lora_name"] == gen.ENTITIES[sn.ENTITY_NAME].identity_lora_name
    assert record["identity_lora_weight"] == 0.5
    assert record["ip_adapter_weight"] == 0.35
    assert record["controlnet"]
    assert record["controlnet_strength"] == gen.CONTROLNET_STRENGTH
    assert record["pose_key"] == "side_neutral"
    assert record["attempt_cap"] == 3


def test_build_generation_provenance_records_reference_conditioning_chain() -> None:
    record = sn.build_generation_provenance(_fake_generation_record())
    ref = record["reference_conditioning"]
    assert ref["card"] == "T-0317"
    assert ref["path"] == str(gen.PROFILE_REFERENCE_T0317_PATH.relative_to(REPO_ROOT))
    assert ref["sha256"] == "f" * 64
    assert ref["square_padded_for_upload"] is True


def test_build_final_provenance_route_is_generated_and_descended() -> None:
    generation_record = sn.build_generation_provenance(_fake_generation_record())
    descent_info = {"source_bbox_on_panel": [10, 20, 30, 400]}
    final = sn.build_final_provenance(generation_record, descent_info)
    assert final["route"] == "generated_and_descended"
    assert final["gpu_call_required"] is True
    assert final["card"] == "T-0339"
