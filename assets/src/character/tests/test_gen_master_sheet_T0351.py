"""Tier-1 master-sheet REGEN in limb-separating poses (T-0351).

Successor to T-0336 (PR #365): same recipe (1024px, style LoRA 0.70,
identity LoRA 0.5, IP-Adapter 0.35 on the cropped clean concept block, no
ControlNet) -- pose is the only variable. #365's relaxed turnaround left
arms against the torso and a mid-calf coat closed over the thighs, so
`upper_leg` could never be cropped and its own side panel was a
three-quarter view, not a true profile. Per the 2026-09-10 spec change
(@DennieSeth), this card asks for FIVE panels: front T-pose, back T-pose,
side-left-forward, side-right-forward, and side-neutral (a true 90-degree
profile, arms down, standing -- the profile-keyframe anchor T-0339 now
sources). The coat must fall no lower than mid-hip in every panel so
`upper_leg` stays separable.

Pure construction/string tests -- no ComfyUI/network dependency, same as
`test_gen_master_sheet_T0336.py`. RED state: `build_limb_pose_prompt`,
`out_dir_for`, and `attempt_log_path_for` do not exist yet -> AttributeError.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_T0336 as gen  # noqa: E402

# ── Card-parametrised paths: T-0336's own filenames must stay unchanged ────


def test_out_dir_for_defaults_to_t0336_layout_unchanged() -> None:
    out_dir = gen.out_dir_for("T-0336", "player", 1)
    assert out_dir == gen.REPO_ROOT / "assets" / "out" / "master_sheet_T0336" / "player" / (
        "attempt_1"
    )


def test_out_dir_for_t0351_uses_its_own_card_directory() -> None:
    out_dir = gen.out_dir_for("T-0351", "player", 1)
    assert out_dir == gen.REPO_ROOT / "assets" / "out" / "master_sheet_T0351" / "player" / (
        "attempt_1"
    )
    assert out_dir != gen.out_dir_for("T-0336", "player", 1)


def test_attempt_log_path_for_defaults_to_t0336_log_unchanged() -> None:
    assert gen.attempt_log_path_for("T-0336") == gen.ATTEMPT_LOG_PATH


def test_attempt_log_path_for_t0351_is_its_own_file() -> None:
    path = gen.attempt_log_path_for("T-0351")
    assert path.name == "ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md"
    assert path != gen.ATTEMPT_LOG_PATH


# ── The T-0351 positive prompt: five named panels, pose is the only change ─


def test_build_limb_pose_prompt_reuses_entity_trigger_token_and_costume() -> None:
    player = gen.ENTITIES["player"]
    prompt = gen.build_limb_pose_prompt(player)
    assert player.trigger_token in prompt
    assert "institutional green coat" in prompt


def test_build_limb_pose_prompt_requests_front_and_back_t_pose_panels() -> None:
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "t-pose" in prompt
    assert "front" in prompt
    assert "back" in prompt
    assert "arms" in prompt and "horizontal" in prompt
    assert "legs spread" in prompt or "legs apart" in prompt


def test_build_limb_pose_prompt_requests_two_distinct_true_side_panels() -> None:
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "left arm" in prompt and "left leg" in prompt
    assert "right arm" in prompt and "right leg" in prompt
    assert "forward" in prompt
    assert "90-degree" in prompt or "ninety-degree" in prompt
    assert "not a three-quarter view" in prompt


def test_build_limb_pose_prompt_asks_limbs_clear_of_torso() -> None:
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "clear of the torso" in prompt


def test_build_limb_pose_prompt_requests_five_panels() -> None:
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "five separate whole-figure panels" in prompt


def test_build_limb_pose_prompt_requests_side_neutral_profile_panel() -> None:
    """Panel 5 (2026-09-10 spec change): a true 90-degree side profile,
    arms down, standing -- the profile-keyframe anchor T-0339 sources.
    Distinct from panels 3/4, which are walking poses (forward-extended
    limbs), not a neutral standing anchor."""
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "panel five" in prompt
    assert "arms down" in prompt or "arms at the sides" in prompt or "arms hanging" in prompt
    assert "standing" in prompt
    assert prompt.count("90-degree side profile") >= 3


def test_build_limb_pose_prompt_requests_mid_hip_coat_length() -> None:
    """@DennieSeth settled the coat-length question 2026-09-10: mid-hip
    maximum, so the thigh stays exposed and `upper_leg` is separable."""
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "mid-hip" in prompt
    assert "thigh" in prompt


def test_build_limb_pose_prompt_keeps_the_hooded_mask_head_marker() -> None:
    """#365's own fix for the blank-head defect (round 5, T-0336) must carry
    over unchanged -- pose is the only variable."""
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "eye lenses" in prompt
    assert "hooded mask" in prompt


def test_build_limb_pose_prompt_requests_five_independent_full_body_poses() -> None:
    """Attempt 1's own failure mode (see ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md):
    two near-duplicate standing figures plus small floating accessory insets
    -- not five distinct full-body poses in a row. Strengthen the framing so
    the model can't mistake this for a garment-callout sheet."""
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "single horizontal row" in prompt
    assert "full-body" in prompt or "full body" in prompt


# ── The T-0351 negative prompt: attempt-1 failure modes, on top of #365's ──


def test_build_limb_pose_negative_prompt_includes_t0336_fixes() -> None:
    """#365's own fixes (blank heads, armour drift, cropped heads, robotic
    legs) must still apply -- this card only adds to that baseline."""
    negative = gen.build_limb_pose_negative_prompt().lower()
    assert "blank head" in negative
    assert "armor plating" in negative
    assert "robotic legs" in negative


def test_build_limb_pose_negative_prompt_forbids_duplicate_poses_and_insets() -> None:
    """Attempt 1's actual defect: two near-identical standing figures plus
    small floating accessory/equipment inset panels instead of five
    distinct full-body poses."""
    negative = gen.build_limb_pose_negative_prompt().lower()
    assert "duplicate pose" in negative
    assert "inset" in negative


def test_build_limb_pose_negative_prompt_forbids_long_coat() -> None:
    """Attempt 1's coat fell well past mid-hip despite the positive
    prompt's mid-hip wording -- reinforce from the negative side too."""
    negative = gen.build_limb_pose_negative_prompt().lower()
    assert "long coat" in negative or "floor-length coat" in negative
    assert "coat" in negative and ("knee" in negative or "calf" in negative)


def test_build_limb_pose_negative_prompt_forbids_grid_layout_and_six_figures() -> None:
    """Attempt 2's own defect (strengthened wording, still wrong): six
    figures in a two-row grid, none in the requested pose, instead of five
    in a single row."""
    negative = gen.build_limb_pose_negative_prompt().lower()
    assert "grid" in negative
    assert "six" in negative


def test_build_limb_pose_prompt_frontloads_pose_before_costume() -> None:
    """Attempt 2's own defect: a ~300-word single-blob prompt buried the
    five-panel pose spec well after the costume text, and the model
    reproduced costume/silhouette faithfully while ignoring pose almost
    entirely. Put the panel/pose instructions ahead of the costume
    description so they carry more positional weight."""
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"])
    assert prompt.index("panel one") < prompt.index(gen.ENTITIES["player"].costume_description)


def test_build_limb_pose_prompt_emphasises_pose_and_coat_clauses() -> None:
    """Uses ComfyUI's native CLIPTextEncode emphasis syntax (`(text:weight)`)
    to push weight toward the panel/pose and mid-hip clauses without
    touching IP-Adapter/LoRA node weights -- pose stays a prompt-only
    lever, per this card's own constraint."""
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"])
    assert ":1." in prompt
    assert prompt.count("(") == prompt.count(")")


def test_build_limb_pose_prompt_requests_no_text_no_ui_no_watermark() -> None:
    prompt = gen.build_limb_pose_prompt(gen.ENTITIES["player"]).lower()
    assert "no text" in prompt
    assert "watermark" in prompt


def test_build_limb_pose_prompt_does_not_add_any_new_entity_field() -> None:
    """This card's own scope: pose is the only variable, so it must not need
    a new EntitySpec field -- the existing 'player' entry, unchanged, is
    enough to build the new prompt."""
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
    prompt = gen.build_limb_pose_prompt(enemy)
    assert "senemytoken" in prompt
    assert "chitin plating" in prompt


# ── run_attempt/append_attempt_log/promote_attempt: card-parametrised, but
# every existing T-0336 call site (no card/log_path/dest_stem given) must
# still resolve to exactly its old behaviour. ──────────────────────────────


def test_append_attempt_log_writes_to_explicit_log_path_when_given(tmp_path) -> None:
    log_path = tmp_path / "ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md"
    provenance = {
        "attempt": 1,
        "entity": "player",
        "seed": 1,
        "style_lora_weight": 0.70,
        "identity_lora_weight": 0.50,
        "ip_adapter_weight": 0.35,
        "width": 1024,
        "height": 1024,
        "gpu_seconds": 30.0,
        "promoted": False,
    }
    gen.append_attempt_log(provenance, notes="T-0351 attempt 1", log_path=log_path)
    assert log_path.exists()
    assert "T-0351 attempt 1" in log_path.read_text()


def test_promote_attempt_uses_explicit_dest_stem_and_limb_crop_boxes(tmp_path, monkeypatch) -> None:
    from PIL import Image

    final_dir = tmp_path / "master_sheets"
    monkeypatch.setattr(gen, "MASTER_SHEETS_DIR", final_dir)

    out_dir = tmp_path / "attempt_1"
    out_dir.mkdir()
    Image.new("RGB", (20, 10), (128, 128, 128)).save(out_dir / "master_sheet_1024.png")
    provenance = {"attempt": 1, "entity": "player"}
    crop_boxes = {"upper_leg": (0, 0, 10, 10)}

    gen.promote_attempt(
        "player",
        out_dir,
        provenance,
        dest_stem="player_master_sheet_T0351",
        limb_crop_boxes=crop_boxes,
    )

    assert (final_dir / "player_master_sheet_T0351.png").exists()
    written = (final_dir / "player_master_sheet_T0351.provenance.json").read_text()
    assert '"upper_leg"' in written
    # T-0336's own default filenames must not also appear -- no accidental
    # cross-write when an explicit stem is given.
    assert not (final_dir / "player_master_sheet_T0336.png").exists()


def test_promote_attempt_default_stem_still_matches_t0336_unchanged(tmp_path, monkeypatch) -> None:
    """Guards against a card-parametrisation regression breaking #365's own
    already-promoted filenames."""
    final_dir = tmp_path / "master_sheets"
    monkeypatch.setattr(gen, "MASTER_SHEETS_DIR", final_dir)
    monkeypatch.setitem(
        gen.ENTITIES,
        "player",
        gen.ENTITIES["player"].__class__(
            **{**gen.ENTITIES["player"].__dict__, "limb_crop_boxes": None}
        ),
    )

    out_dir = tmp_path / "attempt_1"
    out_dir.mkdir()
    (out_dir / "master_sheet_1024.png").write_bytes(b"fake-png-bytes")
    provenance = {"attempt": 1, "entity": "player"}

    gen.promote_attempt("player", out_dir, provenance)

    assert (final_dir / "player_master_sheet_T0336.png").exists()
