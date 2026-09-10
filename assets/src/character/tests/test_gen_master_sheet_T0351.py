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
sources). The 2026-09-10 dedicated-legs-panel amendment adds a SIXTH panel,
"legs" (lower body only, trousers and boots, no coat) and REVOKES the
mid-hip coat requirement on panels 1-5: the canonical long coat is now
correct there, and `upper_leg`/`lower_leg` instead come from the dedicated
sixth panel.

Pure construction/string tests -- no ComfyUI/network dependency, same as
`test_gen_master_sheet_T0336.py`. RED state: `build_limb_pose_prompt`,
`out_dir_for`, and `attempt_log_path_for` do not exist yet -> AttributeError.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

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


def test_build_limb_pose_negative_prompt_forbids_heels_and_split_leg_row() -> None:
    """Attempt 3's own defect (CLIP-emphasis-weighted panels): blank/
    cropped heads, high heels instead of boots, and legs isolated into
    their own cropped row instead of staying attached to a whole figure."""
    negative = gen.build_limb_pose_negative_prompt().lower()
    assert "heel" in negative
    assert "leg" in negative and "row" in negative


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


# ── Lever 2 (run-1 reviewer verdict): five separate single-pose generations
# composited by script, replacing the single-shot five-panel-in-one-image
# approach that failed all 5 of this card's first-round attempts. Root
# cause per the reviewer: MAIN_NEGATIVE (imported from T-0249) forbids
# "grid, panels, contact sheet, multiple frames" and "two figures, duplicate
# figure" -- exactly what a five-panel-in-a-row image needs. Generating one
# pose per KSampler call sidesteps that conflict entirely instead of fighting
# it, and matches the card's own standing guardrail ("motion composited by
# script") and docs/assets/evidence/T-0351/README.md's own recommendation. ──


def test_pose_specs_has_six_entries_in_acceptance_criteria_order() -> None:
    """2026-09-10 dedicated-legs-panel amendment: a sixth 'legs' panel
    (lower body only, no coat) is now part of the acceptance spec."""
    keys = [pose.key for pose in gen.POSE_SPECS]
    assert keys == [
        "front_tpose",
        "back_tpose",
        "side_left_forward",
        "side_right_forward",
        "side_neutral",
        "legs",
    ]
    assert [pose.no_coat for pose in gen.POSE_SPECS] == [
        False,
        False,
        False,
        False,
        False,
        True,
    ]


def test_build_single_pose_positive_prompt_front_tpose() -> None:
    player = gen.ENTITIES["player"]
    pose = gen.POSE_SPECS[0]
    prompt = gen.build_single_pose_positive_prompt(player, pose).lower()
    assert player.trigger_token in prompt
    assert "t-pose" in prompt
    assert "front" in prompt
    assert "horizontal" in prompt
    assert "legs spread" in prompt or "legs apart" in prompt
    assert "institutional green coat" in prompt
    # 2026-09-10 dedicated-legs-panel amendment: the mid-hip coat clause is
    # REVOKED for whole-figure panels -- the canonical long coat is now
    # correct, not a defect to fight, so no coat-length instruction at all.
    assert "mid-hip" not in prompt
    assert "hooded mask" in prompt and "eye lenses" in prompt
    # single-pose generation must not ask for a multi-panel layout -- that
    # is exactly the instruction that fought MAIN_NEGATIVE in attempts 1-5.
    assert "panel" not in prompt
    assert "single full-body figure" in prompt


def test_build_single_pose_positive_prompt_back_tpose() -> None:
    player = gen.ENTITIES["player"]
    pose = gen.POSE_SPECS[1]
    prompt = gen.build_single_pose_positive_prompt(player, pose).lower()
    assert "t-pose" in prompt
    assert "back" in prompt
    assert "horizontal" in prompt


def test_build_single_pose_positive_prompt_back_tpose_does_not_ask_for_visible_face() -> None:
    """Attempt 15 (seed 264575131, docs/assets/evidence/T-0351/) proved the
    shared hooded-mask-with-visible-eye-lenses clause every other panel
    uses actively fights 'back view' when interpolated unchanged into the
    back_tpose prompt: the panel rendered the mask facing the camera, not
    the back of the hood, because the emphasized eye-lenses clause
    out-competed the pose clause's 'back view' wording, and the mirrored
    ControlNet skeleton is bilaterally symmetric for a T-pose so it carries
    no facing-direction signal either (see pose_rig_master_sheet_T0351.py's
    own docstring). back_tpose needs its own head wording that describes
    the back of the hood instead of the eye lenses."""
    player = gen.ENTITIES["player"]
    pose = gen.POSE_SPECS[1]
    prompt = gen.build_single_pose_positive_prompt(player, pose).lower()
    assert "visible eye lenses" not in prompt
    assert "no eye lenses" in prompt
    assert "back of the hood" in prompt or "back of hood" in prompt
    assert "no face" in prompt


def test_build_single_pose_positive_prompt_front_tpose_still_asks_for_visible_face() -> None:
    """The back_tpose head-wording fix must be scoped to back_tpose only --
    every other panel still needs the visible hooded-mask/eye-lenses
    identity marker."""
    player = gen.ENTITIES["player"]
    pose = gen.POSE_SPECS[0]
    prompt = gen.build_single_pose_positive_prompt(player, pose).lower()
    assert "eye lenses" in prompt


def test_build_single_pose_negative_prompt_back_tpose_bans_visible_face_markers() -> None:
    pose = gen.POSE_SPECS[1]
    negative = gen.build_single_pose_negative_prompt(pose).lower()
    assert "eye lenses" in negative or "goggles" in negative


def test_build_single_pose_negative_prompt_no_pose_arg_still_works() -> None:
    """Backward-compat: existing callers with no pose argument (and the
    front/side panels, which have no negative_extra) must not regress."""
    negative = gen.build_single_pose_negative_prompt()
    assert "blank head" in negative.lower()


def test_build_single_pose_negative_prompt_forbids_weapons_and_action_poses() -> None:
    """Attempt 15's side_left_forward rendered a pistol and a mid-kick
    action pose despite the spec's plain forward-limb-extension wording --
    neither a weapon nor a kicking/running/combat motion was ever named in
    this shared negative prompt."""
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "weapon" in negative or "gun" in negative or "pistol" in negative
    assert "kick" in negative or "martial arts" in negative or "combat stance" in negative


def test_build_single_pose_negative_prompt_forbids_held_tools_and_canisters() -> None:
    """Attempt 17's side_left_forward still rendered a held cylindrical
    tool/flashlight-like prop in the extended hand despite the existing
    weapon ban -- a flashlight/torch/canister is not a weapon and was
    never named."""
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "flashlight" in negative or "torch" in negative or "canister" in negative


def test_build_single_pose_positive_prompt_requests_empty_hands() -> None:
    """Banning every possible prop by name in the negative prompt is an
    unbounded list (attempt 17 found a flashlight-like prop the existing
    weapon ban never named); an affirmative 'empty hands' requirement in
    the *positive* prompt is the complementary, bounded fix -- note this
    must NOT also appear in the negative prompt, where banning 'empty
    hand' would tell the model to avoid empty hands, the opposite of
    intent."""
    prompt = gen.build_single_pose_positive_prompt(
        gen.ENTITIES["player"], gen.POSE_SPECS[2]
    ).lower()
    assert "empty hand" in prompt or "open palm" in prompt or "nothing held" in prompt


def test_build_single_pose_positive_prompt_side_left_forward() -> None:
    player = gen.ENTITIES["player"]
    pose = gen.POSE_SPECS[2]
    prompt = gen.build_single_pose_positive_prompt(player, pose).lower()
    assert "left arm" in prompt and "left leg" in prompt
    assert "right arm" in prompt and "right leg" in prompt
    assert "forward" in prompt
    assert "90-degree" in prompt
    assert "not a three-quarter view" in prompt


def test_build_single_pose_positive_prompt_side_right_forward() -> None:
    player = gen.ENTITIES["player"]
    pose = gen.POSE_SPECS[3]
    prompt = gen.build_single_pose_positive_prompt(player, pose).lower()
    assert "right arm" in prompt and "right leg" in prompt
    assert "left arm" in prompt and "left leg" in prompt
    assert "forward" in prompt
    assert "90-degree" in prompt
    assert "not a three-quarter view" in prompt


def test_build_single_pose_positive_prompt_side_neutral() -> None:
    player = gen.ENTITIES["player"]
    pose = gen.POSE_SPECS[4]
    prompt = gen.build_single_pose_positive_prompt(player, pose).lower()
    assert "90-degree" in prompt
    assert "not a three-quarter view" in prompt
    assert "arms down" in prompt or "arms hanging" in prompt or "hanging straight down" in prompt
    assert "standing" in prompt


def test_side_neutral_pose_clause_emphasizes_true_profile() -> None:
    """Attempt 17 (docs/assets/evidence/T-0351/): side_neutral had been the
    first panel this card ever produced a genuine true-90-degree profile
    on (attempt 16), but regressed to front-facing with a blown-out
    head/mask once the concept_crop_box override (attempt-17's own fix,
    a single front-view reference figure) removed whatever incidental
    profile signal the old multi-panel-grid crop happened to carry.
    side_neutral's own pose clause gets CLIP emphasis on the profile
    framing -- a lever never tried on this specific clause before, and
    distinct from the closed coat-length-weight axis -- to compensate."""
    pose = next(p for p in gen.POSE_SPECS if p.key == "side_neutral")
    assert ":1.3)" in pose.pose_clause or ":1.4)" in pose.pose_clause


def test_build_single_pose_positive_prompt_does_not_add_any_new_entity_field() -> None:
    """Same scope guarantee as build_limb_pose_prompt: pose is the only
    variable, no new EntitySpec field required."""
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
    prompt = gen.build_single_pose_positive_prompt(enemy, gen.POSE_SPECS[0])
    assert "senemytoken" in prompt
    assert "chitin plating" in prompt


def test_build_single_pose_negative_prompt_includes_t0336_fixes() -> None:
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "blank head" in negative
    assert "armor plating" in negative
    assert "robotic legs" in negative


def test_build_single_pose_negative_prompt_forbids_heels() -> None:
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "heel" in negative


def test_build_single_pose_negative_prompt_no_longer_forbids_long_coat() -> None:
    """2026-09-10 dedicated-legs-panel amendment: the long coat is now
    canonical and correct on every whole-figure panel -- banning it here
    would ask the model for the opposite of what this card wants. The
    dedicated 'legs' panel is the only place a coat is actually banned
    (build_legs_panel_negative_prompt)."""
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "long coat" not in negative
    assert "floor-length coat" not in negative
    assert "coat below the hip" not in negative


def test_build_legs_panel_positive_prompt_asks_for_no_coat_trousers_and_boots() -> None:
    player = gen.ENTITIES["player"]
    prompt = gen.build_legs_panel_positive_prompt(player).lower()
    assert player.trigger_token in prompt
    assert "trousers" in prompt
    assert "boots" in prompt
    assert "no coat" in prompt
    assert "thigh" in prompt
    # This panel exists specifically because the costume description
    # names the coat this panel must omit -- it must not be interpolated.
    assert "institutional green coat" not in prompt


def test_build_legs_panel_positive_prompt_has_no_head_or_hood_wording() -> None:
    """Attempt-17 redesign (docs/assets/evidence/T-0351/README.md
    'DIRECTION' section): the old legs-panel prompt kept the same
    hooded-mask head clause every whole-figure panel uses, for identity
    continuity -- but that is a full-figure framing clause competing
    directly against this panel's own no-coat instruction, and both real
    executions of it (attempts 15-16) rendered a complete hooded, coated
    figure instead of a legs-only crop. The legs panel is now a waist-down
    close-up crop with no head in frame at all (see
    pose_rig_master_sheet_T0351's matching skeleton redesign), so its
    prompt must not ask for a head, hood or mask."""
    prompt = gen.build_legs_panel_positive_prompt(gen.ENTITIES["player"]).lower()
    assert "hood" not in prompt
    assert "mask" not in prompt
    assert "head" not in prompt


def test_build_legs_panel_positive_prompt_states_waist_down_close_up_framing() -> None:
    prompt = gen.build_legs_panel_positive_prompt(gen.ENTITIES["player"]).lower()
    assert "waist" in prompt
    assert "crop" in prompt


def test_build_legs_panel_positive_prompt_framing_clause_emphasis_raised_after_attempt_17() -> (
    None
):
    """Attempt 17 (docs/assets/evidence/T-0351/): the waist-down close-up
    framing clause at 1.4 emphasis was not enough to stop the sampler
    rendering a full coated torso down to the hips -- the legs panel came
    back closer-cropped than any prior attempt (real progress) but still
    showed shoulders, collar and a full coat. Raises the *framing* clause
    specifically (not the no-coat clause, which stays at attempt 17's 1.5
    -- coat-length emphasis is the closed axis, camera framing is not) to
    1.6."""
    prompt = gen.build_legs_panel_positive_prompt(gen.ENTITIES["player"])
    assert "close-up crop from the waist down" in prompt
    assert ":1.6)" in prompt


def test_build_legs_panel_negative_prompt_bans_coat_and_jacket() -> None:
    negative = gen.build_legs_panel_negative_prompt().lower()
    assert "coat" in negative
    assert "jacket" in negative


def test_build_legs_panel_negative_prompt_bans_cape() -> None:
    """Attempt 15 (docs/assets/evidence/T-0351/) rendered a short hooded
    cape/poncho covering both thighs on the legs panel despite an explicit
    'no cloak' ban -- a cape is a materially different garment silhouette
    from a cloak and was never named."""
    negative = gen.build_legs_panel_negative_prompt().lower()
    assert "cape" in negative


def test_build_legs_panel_positive_prompt_no_coat_emphasis_reverted_after_regression() -> None:
    """Attempt 16 raised this clause to 1.8 and the legs panel regressed to
    a full elaborate armoured cape -- worse than attempt 15's partial cape
    leak (docs/assets/evidence/T-0351/README.md: 'Do not raise this weight
    further next attempt'). Attempt 17 does not escalate the weight again;
    the new waist-down close-up framing plus the matching legs-only
    ControlNet skeleton (pose_rig_master_sheet_T0351) are the structural
    fix, and this clause reverts to a moderate 1.5 -- the README's own
    recommended next lever ('revert the legs panel's emphasis to 1.5, keep
    the cape term')."""
    prompt = gen.build_legs_panel_positive_prompt(gen.ENTITIES["player"])
    assert "no cape" in prompt.lower() or ", cape" in prompt.lower()
    assert ":1.5)" in prompt
    assert ":1.8)" not in prompt
    assert ":1.9)" not in prompt


def test_build_legs_panel_negative_prompt_bans_head_and_torso_content() -> None:
    """The waist-down close-up redesign (attempt 17) needs the negative
    prompt to actively suppress any head/hood/torso content bleeding into
    frame, not rely on the framing instruction alone -- attempts 15-16
    both rendered a full head/hood despite no such content being asked for
    in the (then whole-figure) positive prompt."""
    negative = gen.build_legs_panel_negative_prompt().lower()
    assert "head" in negative
    assert "hood" in negative
    assert "torso" in negative


def test_build_legs_panel_negative_prompt_includes_single_pose_negative_baseline() -> None:
    """Reuses build_single_pose_negative_prompt (footwear, ghosting,
    reference-sheet, face/hair bans) rather than duplicating it."""
    negative = gen.build_legs_panel_negative_prompt().lower()
    assert "heel" in negative
    assert "ghost" in negative or "ghosting" in negative


def test_build_single_pose_positive_prompt_does_not_negate_text_in_positive() -> None:
    """Attempt 6 (see ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md,
    docs/assets/evidence/T-0351/README.md) rendered stray pseudo-text/UI
    labels despite the positive prompt's own "no text, no UI, no watermark"
    tail -- negating a concept in the *positive* prompt is a known
    anti-pattern (CLIP has no real negation), and MAIN_NEGATIVE already
    forbids "text, watermark" in the negative prompt where such a ban
    belongs. Attempt 7 drops the redundant positive-prompt negation."""
    prompt = gen.build_single_pose_positive_prompt(
        gen.ENTITIES["player"], gen.POSE_SPECS[0]
    ).lower()
    assert "no text" not in prompt
    assert "no ui" not in prompt
    assert "no watermark" not in prompt


def test_build_single_pose_positive_prompt_emphasizes_isolation_and_coat() -> None:
    """Attempt 6's five generations all reproduced a multi-inset fashion
    tech-pack/reference-sheet composition despite an unemphasized "single
    full-body figure alone in frame" instruction; attempt 7 emphasized both
    isolation and pose at 1.3 (still prompt-only, pre-ControlNet).

    Attempt 8 (first ControlNet execution, see
    ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md) proved the skeleton forces real
    T-pose/profile geometry in 4 of 5 panels without any text help -- CLIP
    emphasis on the pose clause is no longer pulling weight the skeleton
    doesn't already supply, and it was competing for prompt "attention
    budget" against coat-length emphasis, which is the plausible reason
    attempt 8's coats came back mid-calf-or-longer in every panel (worse
    than attempts 3/5's plain-1.3-coat-only prompt-only result). Attempt 9
    drops pose-clause emphasis entirely (ControlNet -- build_graph's
    pose_skeleton_filename -- is the pose lever now) and raises isolation
    to 1.4 and coat-length to 1.6.

    Attempt 9 ran exactly that and regressed badly: "cropped ... jacket"
    wording (replacing "coat") pulled the whole generation toward an
    unrelated fashion-lookbook archetype -- lost hooded-mask identity in 4
    of 5 panels, and panels 3/4 got WORSE (two and three figures,
    respectively, versus attempt 8's single multi-figure regression).
    Attempt 10 isolates the variables attempt 9 conflated: reverts the
    coat clause to attempt 8's own "coat"-not-"jacket" wording (which had
    clean single-figure results in 4/5 panels and no identity drift),
    keeps isolation at attempt 8's proven-safe 1.3 (reverting attempt 9's
    1.4), and changes only the coat-length weight, 1.3 -> 1.5 -- the one
    axis not yet tested in isolation.

    Attempt 11 is this card's first real execution of attempt 10's exact
    recipe (seed 356237921, 444.7 total GPU-seconds, all 5 ComfyUI calls
    succeeded, see ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md and
    docs/assets/evidence/T-0351/attempt_11_*). Opening the five panels
    confirmed real progress -- front_tpose and back_tpose are genuine,
    clean single-figure T-poses (arms horizontal, legs apart, no ghosting),
    and side_neutral is a genuine clean true-90-degree profile with arms
    down and zero ghosting -- ControlNet is reliably forcing the skeleton's
    pose and single-figure count on 3 of 5 panels now, a first for this
    card. But two defects persist on every panel: (1) the coat still runs
    well past mid-hip (to the knee on front_tpose, past the knee on
    back_tpose and side_neutral) even at 1.5 emphasis, worse than attempts
    3/5's plain-1.3 prompt-only result; (2) side_left_forward and
    side_right_forward both still regress to multiple overlapping/ghosted
    figures despite 1.3-weighted multi-figure negative terms. Attempt 12
    raises the coat-length weight again, 1.5 -> 1.8 (isolation stays at
    1.3, unchanged -- it is not implicated in either persisting defect).

    Attempt 12 (seed 382682312, 393.5 total GPU-seconds) is a mixed result:
    front_tpose's coat is genuinely shorter, and 3 of 5 panels (front_tpose,
    back_tpose, side_neutral) show zero ghosting -- but 4 of 5 panels lost
    the hooded-mask identity entirely (visible human face and hair instead
    of the hood/eye-lens mask), front_tpose gained several patches of
    legible garment-label text ("THE HIP", "COAT TRIST"), and
    side_right_forward still regressed to three figures. This matches the
    pattern already on record from attempts 3/4/9: pushing CLIP emphasis
    higher destabilises whatever clause is NOT being emphasized, not just
    the one that is. Attempt 13 pulls back both weights partway (coat
    1.8 -> 1.6, still above attempt 11's insufficient 1.5; isolation stays
    untouched at 1.3) and, for the first time, adds its own emphasis to the
    hood/mask clause itself (1.3) -- the identity element that just
    regressed and has never before been given any weight of its own.

    Attempt 13 (seed 411721095, 429.5 total GPU-seconds) confirms the
    hood/mask emphasis genuinely works -- all 5 panels show a fully
    covered, legible hood/mask with zero visible face or hair, a first for
    this card. But it came at a cost: side_left_forward exploded to FOUR
    figures (worse than any prior attempt), side_right_forward stayed at
    three, side_neutral lost its true-profile framing entirely (rendered
    near-front-facing), the reference-sheet/tech-pack diagram-panel defect
    (last seen attempt 6/7) came back on front_tpose, high heels reappeared
    despite an explicit ban, and coat length regressed to floor-length on
    two panels. Adding a fourth emphasized clause evidently over-saturated
    this prompt's attention budget entirely. Attempt 14 reverts coat and
    multi-figure weight to attempt 11's baseline (coat 1.6 -> 1.5,
    multi-figure 1.4 -> 1.3 in the negative prompt) -- the best-behaved
    values so far -- keeps the hood/mask emphasis (1.3, proven), and moves
    to an untried, non-prompt lever for the persistent side-panel
    multi-figure defect: raising `CONTROLNET_STRENGTH` itself (1.3 -> 1.6),
    since every previous fix attempt competed for the same CLIP attention
    budget and each one that helped one defect worsened another.

    **2026-09-10 dedicated-legs-panel amendment**: the coat-length clause
    this docstring's history spent attempts 8-14 tuning (1.3 -> 1.6 -> 1.8
    -> 1.6 -> 1.5) is now gone entirely, not just re-tuned -- the canonical
    long coat is correct on this panel, so there is nothing left to weight.
    Only the isolation clause keeps its own emphasis now."""
    pose = gen.POSE_SPECS[0]
    prompt = gen.build_single_pose_positive_prompt(gen.ENTITIES["player"], pose)
    assert "exactly one pose" in prompt.lower()
    assert "exactly one" in prompt.lower() and "view" in prompt.lower()
    assert ":1.3)" in prompt, "isolation clause must stay at attempt 8's proven-safe 1.3"
    assert ":1.5)" not in prompt, "the coat-length clause is revoked, not just re-tuned"
    assert ":1.6)" not in prompt, "attempt 13's 1.6 coat weight must be fully replaced"
    assert ":1.8)" not in prompt, "attempt 12's 1.8 coat weight must be fully replaced"
    assert "mid-hip" not in prompt.lower(), "the mid-hip coat clause is revoked entirely"
    assert "jacket" not in prompt.lower(), (
        "attempt 9's 'jacket' reframing is implicated in its identity drift -- revert to 'coat'"
    )
    assert pose.pose_clause in prompt, "pose text itself must still be present"
    assert f"({pose.pose_clause}:1.3)" not in prompt, (
        "pose clause must no longer be CLIP-emphasized -- ControlNet forces it now"
    )


def test_build_single_pose_positive_prompt_emphasizes_hood_mask_after_attempt_12() -> None:
    """Attempt 12 lost the hooded-mask identity entirely in 4 of 5 panels
    (visible human face and hair rendered instead) -- the coat-length and
    multi-figure-ban weight increases evidently pulled attention budget
    away from the hood/mask clause, which had never itself been given any
    emphasis. Attempt 13 gives it its own weight (1.3, this pipeline's
    established safe starting point) plus explicit face/hair-suppression
    wording, rather than just hoping a plain unweighted mention holds up
    against two other emphasized clauses."""
    pose = gen.POSE_SPECS[0]
    prompt = gen.build_single_pose_positive_prompt(gen.ENTITIES["player"], pose)
    assert "hooded mask" in prompt.lower()
    assert ":1.3)" in prompt
    hood_start = prompt.lower().index("hooded mask")
    preceding_open_paren = prompt.rfind("(", 0, hood_start)
    assert preceding_open_paren != -1, "hood/mask clause must be wrapped in its own emphasis"
    clause = prompt[preceding_open_paren:]
    assert "no visible hair" in clause.lower() or "no visible face" in clause.lower()


def test_build_single_pose_negative_prompt_forbids_reference_sheet_composition() -> None:
    """Attempt 6's own new failure mode (see README/attempt log): a
    multi-inset fashion tech-pack/reference-sheet composition, not the
    single isolated figure the prompt asked for -- MAIN_NEGATIVE's existing
    "grid, panels, contact sheet, multiple frames" wording did not suppress
    this variant."""
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "reference sheet" in negative or "tech pack" in negative
    assert "multiple views" in negative


def test_build_single_pose_negative_prompt_does_not_re_add_panel_bans() -> None:
    """MAIN_NEGATIVE (via build_negative_prompt) already forbids grid/panel/
    multi-figure compositions -- exactly what a single-pose generation
    wants, so this must not duplicate build_limb_pose_negative_prompt's own
    extra anti-panel clauses (six figures, two rows, etc.), which belonged
    to the single-shot five-panel approach this lever replaces."""
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "six figures" not in negative
    assert "six panels" not in negative


def test_build_single_pose_negative_prompt_emphasizes_single_figure_after_attempt_8() -> None:
    """Attempt 8 (first ControlNet execution) still regressed to a
    three-figure composition on the side_right_forward panel despite
    MAIN_NEGATIVE's own unemphasized "two figures, duplicate figure, ...
    group of people" ban -- the same emphasis lever that fixed coat length
    in attempts 3/5 gets applied here too, on this card's own negative
    prompt (MAIN_NEGATIVE itself stays untouched, since it's shared across
    every card in this pipeline).

    Attempt 11 (this card's first real ControlNet execution, see
    `test_build_single_pose_positive_prompt_isolates_coat_weight_after_attempt_9`'s
    docstring) proved the 1.3-weighted ban still is not enough: opening
    side_left_forward and side_right_forward showed a faded, translucent
    second/third figure overlapping the main one -- a ghosting defect
    distinct from attempt 8's opaque three-figure regression, and one none
    of the existing terms name. Attempt 12 raises the weight 1.3 -> 1.6 and
    adds terms for the specific defect observed (ghost figure, faded
    duplicate, translucent overlay, afterimage, double exposure).

    Attempt 12 fixed ghosting on 3 of 5 panels but side_right_forward still
    regressed to three opaque (not translucent) figures, and the higher
    weight is implicated (alongside the coat-weight increase) in that
    attempt's new identity-drift and stray-text regressions -- see
    `test_build_single_pose_positive_prompt_emphasizes_isolation_and_coat`'s
    docstring. Attempt 13 pulls the weight back partway, 1.6 -> 1.4 (still
    above attempt 11's insufficient 1.3), and adds explicit
    face/hair-visibility and legible-text terms to the negative prompt --
    the two new defects this round surfaced, neither named before now.

    Attempt 13 made the multi-figure defect WORSE, not better -- adding a
    fourth emphasized positive-prompt clause (hood/mask) over-saturated the
    prompt's attention budget and side_left_forward exploded to four
    figures. Attempt 14 reverts this weight fully to attempt 11's original
    1.3 (the best-behaved value on record: 3 of 5 panels clean) and moves
    the actual fix attempt to a non-prompt lever, `CONTROLNET_STRENGTH`
    (see `test_build_single_pose_positive_prompt_isolates_coat_weight_after_attempt_9`'s
    docstring) -- every text-side lever tried so far has traded one
    defect for another because they all draw from the same attention
    budget."""
    negative = gen.build_single_pose_negative_prompt()
    assert ":1.3)" in negative, "multi-figure ban must revert to attempt 11's 1.3 (attempt 14)"
    assert ":1.4)" not in negative, "attempt 13's 1.4 multi-figure weight must be replaced"
    assert ":1.6)" not in negative, "attempt 12's 1.6 multi-figure weight must be replaced"
    assert "figures" in negative.lower()
    assert "ghost figure" in negative.lower() or "ghosting" in negative.lower()
    assert "faded duplicate" in negative.lower() or "translucent" in negative.lower()
    assert "double exposure" in negative.lower() or "afterimage" in negative.lower()
    assert "visible face" in negative.lower() or "exposed face" in negative.lower()
    assert "visible hair" in negative.lower()
    assert "readable text" in negative.lower() or "legible words" in negative.lower()


def test_controlnet_strength_raised_after_attempt_13() -> None:
    """Every text-side lever tried on this card's persistent side-panel
    multi-figure defect (attempts 8, 11, 12, 13 -- see
    `test_build_single_pose_negative_prompt_emphasizes_single_figure_after_attempt_8`'s
    docstring) traded one defect for another, because CLIP emphasis on any
    one clause competes for the same finite attention budget as every
    other clause in the same prompt. `CONTROLNET_STRENGTH` is a genuinely
    different axis -- it governs how rigidly the sampler follows the
    authored OpenPose skeleton, not text attention -- and has been left at
    its original value (1.3, ARM_POSE_AUTHORITY_ATTEMPT_LOG_T0249.md
    attempt 3's proven single-figure value) through every prompt-side
    iteration on this card. Attempt 14 raises it to 1.6 to test whether
    stronger structural conditioning suppresses the extraneous
    figures/content a weaker skeleton pin leaves the sampler free to add
    -- still pose-conditioning-only, per the 2026-09-10 amendment's own
    scope (it does not touch the style/identity LoRA or IP-Adapter
    chain)."""
    assert gen.CONTROLNET_STRENGTH == 1.6
    assert gen.CONTROLNET_END_PERCENT == 1.0


def test_compose_pose_row_stitches_images_side_by_side(tmp_path) -> None:
    from PIL import Image

    paths = []
    colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
    for i, color in enumerate(colors):
        im = Image.new("RGB", (40, 40), color)
        p = tmp_path / f"pose_{i}.png"
        im.save(p)
        paths.append(p)
    out_path = tmp_path / "row.png"

    gen.compose_pose_row(paths, out_path)

    composed = Image.open(out_path)
    assert composed.size == (120, 40)
    assert composed.getpixel((10, 10)) == (255, 0, 0)
    assert composed.getpixel((50, 10)) == (0, 255, 0)
    assert composed.getpixel((90, 10)) == (0, 0, 255)


def test_compose_pose_row_scales_to_common_height_without_stretch(tmp_path) -> None:
    from PIL import Image

    tall = Image.new("RGB", (40, 80), (255, 0, 0))
    short = Image.new("RGB", (40, 40), (0, 255, 0))
    tall_path = tmp_path / "tall.png"
    short_path = tmp_path / "short.png"
    tall.save(tall_path)
    short.save(short_path)
    out_path = tmp_path / "row.png"

    gen.compose_pose_row([tall_path, short_path], out_path)

    composed = Image.open(out_path)
    # common height is the smaller of the two; the tall image is scaled down
    # preserving its aspect ratio (half as tall -> half as wide), never
    # stretched to match the short image's width.
    assert composed.height == 40
    assert composed.width == 20 + 40


def test_run_five_pose_attempt_is_registered_for_this_cards_generation_mode() -> None:
    """`main()`'s --five-pose flag must resolve to this function for T-0351
    -- a smoke check that the CLI wiring points at the right callable."""
    assert callable(gen.run_five_pose_attempt)


# ── Run-2 reviewer verdict: two concrete blockers, both fixed here ─────────
# (1) check_attempt_cap was still hard-capped at 5 for every card, inherited
# unmodified from T-0336's own ~25-50 GPU-second budget -- lever 2 needs a
# 6th+ attempt (five separate generations per attempt, not one), and this
# card's own text imposes no attempt cap of its own. (2) main()'s
# --promote-attempt branch threaded no limb_crop_boxes, so promotion always
# fell back to PLAYER_LIMB_CROP_BOXES -- #365's hand-tuned single-frame boxes,
# which have "No upper_leg key" by their own comment and are measured against
# a single 1024x1024 image, not this card's 5120x1024 five-panel row.


def test_check_attempt_cap_default_card_still_caps_at_five() -> None:
    """Backward compatibility: an un-carded call (T-0336's own call sites)
    keeps its original ~25-50 GPU-second, 5-attempt budget unchanged."""
    gen.check_attempt_cap(1)
    gen.check_attempt_cap(5)  # must not raise
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(6)


def test_check_attempt_cap_t0336_explicit_card_still_caps_at_five() -> None:
    gen.check_attempt_cap(5, card="T-0336")
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(6, card="T-0336")


def test_check_attempt_cap_t0351_allows_a_sixth_attempt() -> None:
    """T-0351's own card text states this card imposes no attempt cap of its
    own (run-2 reviewer verdict) -- lever 2 (five separate generations per
    attempt) needs to keep going past the T-0336-inherited cap of 5."""
    gen.check_attempt_cap(6, card="T-0351")  # must not raise


def test_check_attempt_cap_t0351_still_has_a_runaway_backstop() -> None:
    """No attempt cap of *this card's own* doesn't mean no cap at all --
    conduct.md's "a small job, not a sweep" spirit still applies generically
    to any card without its own stated budget."""
    gen.check_attempt_cap(gen.DEFAULT_ATTEMPT_CAP, card="T-0351")  # must not raise
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(gen.DEFAULT_ATTEMPT_CAP + 1, card="T-0351")


def test_concept_crop_box_for_t0336_defaults_to_entity_registered_box() -> None:
    """Unchanged from #365: no card-specific override registered for
    T-0336, so generation falls back to the entity's own crop box."""
    assert (
        gen.concept_crop_box_for("T-0336", "player") == gen.ENTITIES["player"].concept_crop_box
    )


def test_concept_crop_box_for_t0351_is_registered_and_differs_from_entity_default() -> None:
    """Attempt 17 (docs/assets/evidence/T-0351/README.md 'DIRECTION'
    section): #365's own concept_crop_box (0, 0, 615, 615) is itself a
    multi-panel grid, not an isolated single figure -- the root cause this
    card's own evidence identified
    (root_cause_concept_crop_box_is_itself_a_multi_panel_grid.png) for 16
    attempts of persistent multi-figure/wrong-facing/inconsistent-
    background output, worst on exactly the two panels (side_left_forward,
    side_right_forward) ControlNet's skeleton alone never fully overrode.
    This card gets its own narrower, genuinely single-figure crop box, the
    same CROP_BOXES_BY_CARD pattern limb_crop_boxes_for already
    establishes."""
    box = gen.concept_crop_box_for("T-0351", "player")
    assert box is not None
    assert box != gen.ENTITIES["player"].concept_crop_box


def test_concept_crop_box_for_t0351_box_is_within_the_concept_sheet_bounds() -> None:
    """The concept sheet is 1024x1024 -- a box that overruns it would crop
    garbage or raise deep inside ComfyUI's ImageCrop node instead of
    failing this test with a clear message."""
    x, y, width, height = gen.concept_crop_box_for("T-0351", "player")
    assert 0 <= x
    assert 0 <= y
    assert x + width <= 1024
    assert y + height <= 1024


def test_concept_crop_box_for_t0351_box_is_meaningfully_smaller_than_the_old_multi_panel_grid() -> (
    None
):
    """The old (0, 0, 615, 615) box is 615x615px and is itself a
    multi-panel grid (docs/assets/evidence/T-0351/
    root_cause_concept_crop_box_is_itself_a_multi_panel_grid.png) -- a
    genuinely isolated single figure on this concept sheet is necessarily
    much smaller than a 615x615 block containing three garment panels, a
    swatch row, and part of a whole-figure row."""
    _x, _y, width, height = gen.concept_crop_box_for("T-0351", "player")
    assert width * height < (615 * 615) / 4


def test_limb_crop_boxes_for_t0336_defaults_to_entity_registered_boxes() -> None:
    """Unchanged from #365: no card-specific override registered for
    T-0336, so promotion falls back to the entity's own hand-tuned boxes."""
    assert gen.limb_crop_boxes_for("T-0336", "player") == gen.PLAYER_LIMB_CROP_BOXES


def test_limb_crop_boxes_for_t0351_is_registered_and_includes_upper_leg() -> None:
    """The specific gap #365 could not fill -- see PLAYER_LIMB_CROP_BOXES's
    own comment, "No upper_leg key". This card's mid-hip coat cap exists to
    make upper_leg separable, so its own crop-box registry must include it,
    measured against the actual 5120x1024 five-panel composited row (not
    #365's single 1024x1024 frame)."""
    boxes = gen.limb_crop_boxes_for("T-0351", "player")
    assert boxes is not None
    assert "upper_leg" in boxes
    assert boxes != gen.PLAYER_LIMB_CROP_BOXES


def test_limb_crop_boxes_for_t0351_boxes_fit_within_the_six_panel_row() -> None:
    """Each box must resolve to real pixels inside a 6144x1024 row (six
    1024x1024 panels side by side, in POSE_SPECS order, since the
    2026-09-10 dedicated-legs-panel amendment added a sixth panel) -- a box
    that overruns the row would silently crop garbage or raise deep inside
    PIL instead of failing this test with a clear message."""
    boxes = gen.limb_crop_boxes_for("T-0351", "player")
    for name, (left, top, right, bottom) in boxes.items():
        assert 0 <= left < right <= 6144, name
        assert 0 <= top < bottom <= 1024, name


def test_limb_crop_boxes_for_t0351_upper_leg_sources_from_the_legs_panel() -> None:
    """2026-09-10 dedicated-legs-panel amendment: upper_leg/lower_leg_boot
    must crop from panel 5 (the dedicated 'legs' panel, x offset
    5*1024=5120), not panel 0 -- panels 1-5 keep the canonical long coat
    and no longer expose the thigh."""
    boxes = gen.limb_crop_boxes_for("T-0351", "player")
    assert boxes["upper_leg"][0] >= 5120
    assert boxes["lower_leg_boot"][0] >= 5120


# ── 2026-09-10 amendment: ControlNet/OpenPose permitted for pose ───────────
# conditioning only, after 7 prompt-only attempts never achieved pose
# compliance (ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md,
# docs/assets/evidence/T-0351/README.md's "Root cause" section). Narrow
# scope: pose conditioning only, style/identity LoRA and IP-Adapter weights
# stay exactly as #365 set them (build_graph's existing default-call
# behaviour, pinned by test_gen_master_sheet_T0336.py's own
# test_no_controlnet_node_anywhere, must not change).


def _graph(**overrides) -> dict:
    defaults = dict(
        seed=31416,
        concept_filename="concept.png",
        positive_text="a prompt",
        negative_text="a negative prompt",
        style_lora_weight=0.70,
        ipadapter_weight=0.35,
        width=1024,
        height=1024,
    )
    defaults.update(overrides)
    return gen.build_graph(**defaults)


def test_build_graph_without_pose_skeleton_has_no_controlnet_node() -> None:
    """T-0336's own call sites (pose_skeleton_filename omitted) must keep
    building exactly the graph they always have -- this is the same
    guardrail test_gen_master_sheet_T0336.test_no_controlnet_node_anywhere
    pins, restated here since this card is what could regress it."""
    graph = _graph()
    assert all("ControlNet" not in node["class_type"] for node in graph.values())


def test_build_graph_with_pose_skeleton_adds_controlnet_loader_and_apply() -> None:
    graph = _graph(
        pose_skeleton_filename="skeleton.png",
        controlnet_strength=1.3,
        controlnet_end=1.0,
    )
    loader = graph[gen.CONTROLNET_LOADER_NODE_ID]
    assert loader["class_type"] == "ControlNetLoader"
    assert loader["inputs"]["control_net_name"] == gen.CONTROLNET_NAME

    apply_node = graph[gen.CONTROLNET_NODE_ID]
    assert apply_node["class_type"] == "ControlNetApplyAdvanced"
    assert apply_node["inputs"]["control_net"] == [gen.CONTROLNET_LOADER_NODE_ID, 0]
    assert apply_node["inputs"]["strength"] == 1.3
    assert apply_node["inputs"]["end_percent"] == 1.0
    assert apply_node["inputs"]["start_percent"] == 0.0


def test_build_graph_controlnet_image_is_the_uploaded_skeleton() -> None:
    graph = _graph(
        pose_skeleton_filename="skeleton.png", controlnet_strength=1.3, controlnet_end=1.0
    )
    pose_image_node = graph[gen.POSE_IMAGE_NODE_ID]
    assert pose_image_node == {"class_type": "LoadImage", "inputs": {"image": "skeleton.png"}}
    apply_node = graph[gen.CONTROLNET_NODE_ID]
    assert apply_node["inputs"]["image"] == [gen.POSE_IMAGE_NODE_ID, 0]


def test_build_graph_ksampler_conditioning_is_sourced_from_controlnet_when_present() -> None:
    graph = _graph(
        pose_skeleton_filename="skeleton.png", controlnet_strength=1.3, controlnet_end=1.0
    )
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["positive"] == [gen.CONTROLNET_NODE_ID, 0]
    assert sampler["inputs"]["negative"] == [gen.CONTROLNET_NODE_ID, 1]


def test_build_graph_ksampler_conditioning_unchanged_without_pose_skeleton() -> None:
    graph = _graph()
    sampler = graph[gen.SAMPLER_NODE_ID]
    assert sampler["inputs"]["positive"] == [gen.POSITIVE_PROMPT_NODE_ID, 0]
    assert sampler["inputs"]["negative"] == [gen.NEGATIVE_PROMPT_NODE_ID, 0]


def test_build_graph_ipadapter_and_style_identity_lora_unaffected_by_controlnet() -> None:
    """Narrow scope: ControlNet conditions the prompt pair only -- it must
    not touch the model chain IP-Adapter/LoRA build on, and IP-Adapter's own
    weight/image source stay exactly as #365 set them."""
    no_cn = _graph(identity_lora_name="player_identity_v2.safetensors", identity_lora_weight=0.5)
    with_cn = _graph(
        identity_lora_name="player_identity_v2.safetensors",
        identity_lora_weight=0.5,
        pose_skeleton_filename="skeleton.png",
        controlnet_strength=1.3,
        controlnet_end=1.0,
    )
    for node_id in (
        gen.STYLE_LORA_NODE_ID,
        gen.IDENTITY_LORA_NODE_ID,
        gen.IPADAPTER_LOADER_NODE_ID,
        gen.IPADAPTER_NODE_ID,
    ):
        assert no_cn[node_id] == with_cn[node_id], node_id


# ── Attempt 20 (RE-SCOPE follow-up): attempt 19 (the first real run under ──
# per-panel reference conditioning) showed side_neutral converging cleanly
# against the T-0317 reference (whose own pose -- arms straight down --
# matches side_neutral's target pose) while side_left_forward/
# side_right_forward, whose ControlNet skeleton demands a forward-extended
# limb the reference doesn't show, came back malformed (split costume
# colours, ragged torn edges, a held prop). Narrowing IPAdapterAdvanced's
# `end_at` for just those two panels lets IP-Adapter establish identity
# early and ControlNet's own already-correct skeleton resolve limb geometry
# alone in the later steps, without changing the `weight` this card's Do
# Not section protects.


def test_build_graph_ipadapter_end_at_defaults_to_the_whole_sampling_range() -> None:
    """Every call site before attempt 20 -- and every pose but the two
    forward-extended side panels -- must keep IP-Adapter applied across the
    entire 0.0-1.0 range, unchanged."""
    graph = _graph()
    assert graph[gen.IPADAPTER_NODE_ID]["inputs"]["end_at"] == 1.0
    assert graph[gen.IPADAPTER_NODE_ID]["inputs"]["start_at"] == 0.0


def test_build_graph_ipadapter_end_at_is_configurable_without_touching_weight() -> None:
    """The new parameter narrows *when* IP-Adapter conditioning applies,
    never its `weight` -- this card's own 'do not change the IP-Adapter
    weight' rule is about the weight value, not the sampling window."""
    graph = _graph(ipadapter_weight=0.35, ipadapter_end_at=0.5)
    assert graph[gen.IPADAPTER_NODE_ID]["inputs"]["end_at"] == 0.5
    assert graph[gen.IPADAPTER_NODE_ID]["inputs"]["weight"] == 0.35


def test_pose_specs_no_longer_narrow_ipadapter_end_at_on_side_panels() -> None:
    """Attempt 20 tried ipadapter_end_at=0.5 on side_left_forward/
    side_right_forward and it made both panels WORSE (coat identity drift,
    invented anatomy) -- see POSE_SPECS's own comment. Reverted: every pose
    keeps the full 0.0-1.0 IP-Adapter sampling range."""
    for pose in gen.POSE_SPECS:
        assert pose.ipadapter_end_at == 1.0, pose.key


def test_run_five_pose_attempt_wires_each_poses_own_ipadapter_end_at(monkeypatch) -> None:
    import shutil

    from PIL import Image

    test_out_dir = gen.REPO_ROOT / "assets" / "out" / "_test_scratch_T0351_ipadapter_end_at"
    test_out_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(gen, "out_dir_for", lambda card, entity, attempt: test_out_dir)

    captured_graphs = []

    def fake_upload_image(path):
        return path.name

    def fake_submit_prompt(graph):
        captured_graphs.append(graph)
        return f"prompt-{len(captured_graphs)}"

    def fake_wait_for_completion(prompt_id, timeout_s=300):
        return {"outputs": {gen.MAIN_SAVE_NODE_ID: {"images": [{"filename": "x.png"}]}}}

    def fake_fetch_save_image(info, node_id):
        from io import BytesIO

        buf = BytesIO()
        Image.new("RGB", (16, 16), (10, 20, 30)).save(buf, format="PNG")
        return buf.getvalue()

    monkeypatch.setattr(gen, "upload_image", fake_upload_image)
    monkeypatch.setattr(gen, "submit_prompt", fake_submit_prompt)
    monkeypatch.setattr(gen, "wait_for_completion", fake_wait_for_completion)
    monkeypatch.setattr(gen, "fetch_save_image", fake_fetch_save_image)

    try:
        provenance = gen.run_five_pose_attempt(
            entity_name="player", attempt=20, base_seed=4000, width=64, height=64, card="T-0351"
        )
        for i, pose in enumerate(gen.POSE_SPECS):
            graph = captured_graphs[i]
            assert graph[gen.IPADAPTER_NODE_ID]["inputs"]["end_at"] == pose.ipadapter_end_at
        for record in provenance["poses"]:
            by_key = {pose.key: pose for pose in gen.POSE_SPECS}
            assert record["ipadapter_end_at"] == by_key[record["key"]].ipadapter_end_at
    finally:
        shutil.rmtree(test_out_dir, ignore_errors=True)


def test_concept_crop_box_for_t0351_still_resolves_as_the_generic_fallback() -> None:
    """concept_crop_box_for keeps existing behaviour -- reference_image_for
    (RE-SCOPE, below) falls back to it for any (card, pose_key) combination
    that isn't explicitly registered in POSE_REFERENCES_BY_CARD."""
    box = gen.concept_crop_box_for("T-0351", "player")
    assert box == gen.CONCEPT_CROP_BOX_BY_CARD["T-0351"]


# ── RE-SCOPE (2026-09-10, "PER-PANEL REFERENCE CONDITIONING") -- eighteen ──
# attempts under one shared front-view crop for all six panels never
# converged: the concept sheet was opened and read panel by panel and found
# to carry almost no green-costume SIDE material at all (its side/profile
# figures belong to a different, tan/tactical costume tier). Conditioning
# every panel on one front crop asks IP-Adapter for a side view having shown
# it only a front view -- a missing-reference problem, not a prompt-weight
# one. reference_image_for resolves each pose's own (image, crop) pair
# instead of reusing concept_crop_box_for's single shared box for every
# panel.


def test_reference_image_for_front_and_legs_use_the_concept_sheet_front_crop() -> None:
    """front_tpose and legs both still condition on attempt 17's own clean
    front-view crop -- no dedicated legs-only reference exists on the
    concept sheet (verified), so legs relies on the torso-free ControlNet
    skeleton, not a different reference image, to suppress the coat."""
    front_path, front_box = gen.reference_image_for("T-0351", "player", "front_tpose")
    legs_path, legs_box = gen.reference_image_for("T-0351", "player", "legs")
    assert front_path == gen.CONCEPT_SHEET_PATH
    assert legs_path == gen.CONCEPT_SHEET_PATH
    assert front_box == legs_box == gen.CONCEPT_CROP_BOX_BY_CARD["T-0351"]


def test_reference_image_for_back_tpose_uses_a_distinct_concept_sheet_crop() -> None:
    """back_tpose gets its own crop -- a genuine green BACK view measured
    off the concept sheet (row 4, column 4), not front_tpose's front crop.
    Attempts 15-16 both rendered a front-facing mask on this panel because
    nothing ever conditioned it on a back view at all."""
    path, box = gen.reference_image_for("T-0351", "player", "back_tpose")
    assert path == gen.CONCEPT_SHEET_PATH
    front_box = gen.reference_image_for("T-0351", "player", "front_tpose")[1]
    assert box != front_box
    x, y, width, height = box
    assert 0 <= x and 0 <= y
    assert x + width <= 1024
    assert y + height <= 1024


def test_reference_image_for_side_panels_use_the_t0317_profile_reference() -> None:
    """The three side panels (side_left_forward, side_right_forward,
    side_neutral) condition on the committed T-0317 green side-profile
    reference, not any concept-sheet crop -- the concept sheet has no green
    side view at all, which is why these three panels never once produced
    a compliant true-profile result across 18 attempts of prompt/ControlNet
    tuning against a front-view-only reference."""
    for pose_key in ("side_left_forward", "side_right_forward", "side_neutral"):
        path, box = gen.reference_image_for("T-0351", "player", pose_key)
        assert path == gen.PROFILE_REFERENCE_T0317_PATH, pose_key
        assert box is None, pose_key


def test_reference_image_for_t0317_reference_file_exists_and_is_a_raster_image() -> None:
    """A reference the generator cannot produce is sourced, never faked
    (.claude/rules/assets.md) -- this asserts the committed file this card
    now depends on is actually present, not just referenced in code."""
    path = gen.PROFILE_REFERENCE_T0317_PATH
    assert path.exists(), path
    from PIL import Image

    with Image.open(path) as im:
        assert im.size[0] > 0
        assert im.size[1] > 0


def test_reference_image_for_unregistered_pose_falls_back_to_concept_crop_box_for() -> None:
    """Any (card, pose_key) combination with no explicit override -- e.g. a
    T-0336 call, which never calls this function, or a made-up pose key on
    T-0351 -- resolves to the old single-shared-crop behaviour, not a
    KeyError."""
    path, box = gen.reference_image_for("T-0336", "player", "front_tpose")
    assert path == gen.ENTITIES["player"].concept_sheet_path
    assert box == gen.concept_crop_box_for("T-0336", "player")


def test_run_five_pose_attempt_uses_a_different_reference_per_panel(monkeypatch) -> None:
    """The actual behaviour change under test: run_five_pose_attempt must
    call reference_image_for per pose, not resolve one shared crop/image
    for the whole run -- otherwise reference_image_for is dead code and
    every panel keeps conditioning on the same front crop attempt 17 used,
    exactly the defect RE-SCOPE exists to fix."""
    import shutil

    from PIL import Image

    test_out_dir = gen.REPO_ROOT / "assets" / "out" / "_test_scratch_T0351_perpanel_ref"
    test_out_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(gen, "out_dir_for", lambda card, entity, attempt: test_out_dir)

    uploaded_paths = []

    def fake_upload_image(path):
        uploaded_paths.append(path)
        return path.name

    captured_graphs = []

    def fake_submit_prompt(graph):
        captured_graphs.append(graph)
        return f"prompt-{len(captured_graphs)}"

    def fake_wait_for_completion(prompt_id, timeout_s=300):
        return {"outputs": {gen.MAIN_SAVE_NODE_ID: {"images": [{"filename": "x.png"}]}}}

    def fake_fetch_save_image(info, node_id):
        from io import BytesIO

        buf = BytesIO()
        Image.new("RGB", (16, 16), (10, 20, 30)).save(buf, format="PNG")
        return buf.getvalue()

    monkeypatch.setattr(gen, "upload_image", fake_upload_image)
    monkeypatch.setattr(gen, "submit_prompt", fake_submit_prompt)
    monkeypatch.setattr(gen, "wait_for_completion", fake_wait_for_completion)
    monkeypatch.setattr(gen, "fetch_save_image", fake_fetch_save_image)

    try:
        provenance = gen.run_five_pose_attempt(
            entity_name="player", attempt=19, base_seed=3000, width=64, height=64, card="T-0351"
        )

        # The concept sheet is uploaded once (shared by front/back/legs, not
        # re-uploaded per pose), and the T-0317 reference's square-padded
        # copy (attempt 21's prepare_reference_for_upload) is uploaded once
        # (shared by the three side panels) -- exactly two distinct upload
        # targets across six panels, not six identical uploads and not six
        # independent ones either.
        expected_side_upload = gen.prepare_reference_for_upload(
            gen.PROFILE_REFERENCE_T0317_PATH, test_out_dir
        )
        assert set(uploaded_paths).issuperset({gen.CONCEPT_SHEET_PATH, expected_side_upload})
        concept_sheet_uploads = [p for p in uploaded_paths if p == gen.CONCEPT_SHEET_PATH]
        side_uploads = [p for p in uploaded_paths if p == expected_side_upload]
        assert len(concept_sheet_uploads) == 1
        assert len(side_uploads) == 1

        # Each pose's graph carries its own resolved reference, not a
        # single shared one.
        for i, pose in enumerate(gen.POSE_SPECS):
            expected_path, expected_box = gen.reference_image_for("T-0351", "player", pose.key)
            expected_upload_path = gen.prepare_reference_for_upload(expected_path, test_out_dir)
            graph = captured_graphs[i]
            assert graph[gen.CONCEPT_IMAGE_NODE_ID]["inputs"]["image"] == (
                expected_upload_path.name
            )
            if expected_box is None:
                assert gen.CONCEPT_CROP_NODE_ID not in graph
            else:
                crop_inputs = graph[gen.CONCEPT_CROP_NODE_ID]["inputs"]
                assert (
                    crop_inputs["x"],
                    crop_inputs["y"],
                    crop_inputs["width"],
                    crop_inputs["height"],
                ) == expected_box

        # Side panels must not carry the front crop's node at all -- they
        # condition on the whole T-0317 reference image, uncropped.
        side_keys = {"side_left_forward", "side_right_forward", "side_neutral"}
        for i, pose in enumerate(gen.POSE_SPECS):
            if pose.key in side_keys:
                assert gen.CONCEPT_CROP_NODE_ID not in captured_graphs[i]

        # Provenance records each pose's own resolved reference (the true
        # source, e.g. the T-0317 file -- not the padded upload copy) plus
        # whether square-padding was applied for that upload.
        for record in provenance["poses"]:
            expected_path, expected_box = gen.reference_image_for(
                "T-0351", "player", record["key"]
            )
            assert record["reference_image"] == str(expected_path.relative_to(gen.REPO_ROOT))
            assert record["reference_crop_box"] == (
                list(expected_box) if expected_box is not None else None
            ) or record["reference_crop_box"] == expected_box
            assert record["reference_square_padded"] == (
                expected_path == gen.PROFILE_REFERENCE_T0317_PATH
            )
    finally:
        shutil.rmtree(test_out_dir, ignore_errors=True)


# ── Attempt 21 (RE-SCOPE follow-up): square-padding the T-0317 reference ──
# before upload, per pad_image_to_square/prepare_reference_for_upload's own
# docstrings above.


def test_pad_image_to_square_pads_a_tall_narrow_image_to_a_square() -> None:
    from PIL import Image

    im = Image.new("RGB", (175, 891), (10, 120, 60))
    padded = gen.pad_image_to_square(im)
    assert padded.size == (891, 891)


def test_pad_image_to_square_pads_a_wide_short_image_to_a_square() -> None:
    from PIL import Image

    im = Image.new("RGB", (400, 100), (10, 120, 60))
    padded = gen.pad_image_to_square(im)
    assert padded.size == (400, 400)


def test_pad_image_to_square_centres_the_original_and_fills_background() -> None:
    from PIL import Image

    im = Image.new("RGB", (10, 40), (255, 0, 0))
    padded = gen.pad_image_to_square(im, background=(1, 2, 3))
    assert padded.size == (40, 40)
    # Corner pixels are background-filled padding, not the original image.
    assert padded.getpixel((0, 0)) == (1, 2, 3)
    assert padded.getpixel((39, 0)) == (1, 2, 3)
    # A pixel in the centre column, within the original's vertical extent,
    # is the original image, not padding.
    assert padded.getpixel((20, 20)) == (255, 0, 0)


def test_pad_image_to_square_leaves_an_already_square_image_unchanged_in_size() -> None:
    from PIL import Image

    im = Image.new("RGB", (50, 50), (10, 120, 60))
    padded = gen.pad_image_to_square(im)
    assert padded.size == (50, 50)


def test_prepare_reference_for_upload_leaves_non_t0317_references_unchanged(tmp_path) -> None:
    """The concept-sheet crops are already close to square -- no reason to
    pad them, and no reason to write a new file to disk for them either."""
    result = gen.prepare_reference_for_upload(gen.CONCEPT_SHEET_PATH, tmp_path)
    assert result == gen.CONCEPT_SHEET_PATH


def test_prepare_reference_for_upload_pads_the_t0317_reference(tmp_path) -> None:
    result = gen.prepare_reference_for_upload(gen.PROFILE_REFERENCE_T0317_PATH, tmp_path)
    assert result != gen.PROFILE_REFERENCE_T0317_PATH
    assert result.exists()

    from PIL import Image

    with Image.open(result) as im:
        assert im.width == im.height


def test_prepare_reference_for_upload_caches_the_padded_file(tmp_path) -> None:
    """Called once per side panel (three times a run) -- must not
    regenerate the padded file each time."""
    first = gen.prepare_reference_for_upload(gen.PROFILE_REFERENCE_T0317_PATH, tmp_path)
    mtime_after_first = first.stat().st_mtime
    second = gen.prepare_reference_for_upload(gen.PROFILE_REFERENCE_T0317_PATH, tmp_path)
    assert second == first
    assert second.stat().st_mtime == mtime_after_first


def test_controlnet_name_matches_verified_host_inventory() -> None:
    """@DennieSeth's 2026-09-10 amendment verified this exact model present
    on the live ComfyUI host (860 nodes) -- an SDXL OpenPose ControlNet,
    already used successfully by this pipeline's own single-figure cards
    (T-0249, T-0272)."""
    assert gen.CONTROLNET_NAME == "controlnet-openpose-sdxl-1.0_xinsir.safetensors"


def test_run_five_pose_attempt_conditions_each_pose_with_its_own_skeleton(monkeypatch) -> None:
    """End-to-end (network stubbed): each of the five POSE_SPECS panels must
    submit a graph carrying that pose's own OpenPose skeleton via ControlNet
    -- not five identical prompt-only generations, which is exactly what
    seven prior attempts already proved doesn't work.

    `out_dir_for` is deliberately NOT monkeypatched to a bare pytest
    `tmp_path`: `run_five_pose_attempt` records each skeleton's path
    relative to `REPO_ROOT` in its provenance (same convention every other
    path in this provenance dict already uses), which requires the
    directory to genuinely live under the repo. `assets/out/` is gitignored
    scratch space (CLAUDE.md), so a real subdirectory there is the correct
    stand-in, not a workaround -- cleaned up in `finally` regardless of
    pass/fail."""
    import shutil

    from PIL import Image

    test_out_dir = gen.REPO_ROOT / "assets" / "out" / "_test_scratch_T0351_controlnet"
    test_out_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(gen, "out_dir_for", lambda card, entity, attempt: test_out_dir)

    captured_graphs = []

    def fake_upload_image(path):
        return path.name

    def fake_submit_prompt(graph):
        captured_graphs.append(graph)
        return f"prompt-{len(captured_graphs)}"

    def fake_wait_for_completion(prompt_id, timeout_s=300):
        return {"outputs": {gen.MAIN_SAVE_NODE_ID: {"images": [{"filename": "x.png"}]}}}

    def fake_fetch_save_image(info, node_id):
        from io import BytesIO

        buf = BytesIO()
        Image.new("RGB", (16, 16), (10, 20, 30)).save(buf, format="PNG")
        return buf.getvalue()

    monkeypatch.setattr(gen, "upload_image", fake_upload_image)
    monkeypatch.setattr(gen, "submit_prompt", fake_submit_prompt)
    monkeypatch.setattr(gen, "wait_for_completion", fake_wait_for_completion)
    monkeypatch.setattr(gen, "fetch_save_image", fake_fetch_save_image)

    try:
        provenance = gen.run_five_pose_attempt(
            entity_name="player", attempt=8, base_seed=1000, width=64, height=64
        )

        assert len(captured_graphs) == 6
        for graph, pose in zip(captured_graphs, gen.POSE_SPECS):
            assert graph[gen.CONTROLNET_LOADER_NODE_ID]["inputs"]["control_net_name"] == (
                gen.CONTROLNET_NAME
            )
            pose_image_filename = graph[gen.POSE_IMAGE_NODE_ID]["inputs"]["image"]
            assert pose.key in pose_image_filename

        assert provenance["controlnet"] == gen.CONTROLNET_NAME
        assert provenance["controlnet_strength"] == gen.CONTROLNET_STRENGTH
        assert provenance["controlnet_end_percent"] == gen.CONTROLNET_END_PERCENT
        for record in provenance["poses"]:
            assert "pose_skeleton" in record

        # The legs panel must use its own no-coat prompt pair, not the
        # whole-figure one every other panel uses.
        legs_record = next(r for r in provenance["poses"] if r["key"] == "legs")
        assert "no coat" in legs_record["prompt"].lower()
        assert "coat" in legs_record["negative_prompt"].lower()
        front_record = next(r for r in provenance["poses"] if r["key"] == "front_tpose")
        assert "mid-hip" not in front_record["prompt"].lower()
    finally:
        shutil.rmtree(test_out_dir, ignore_errors=True)
