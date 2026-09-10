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


def test_pose_specs_has_five_entries_in_acceptance_criteria_order() -> None:
    keys = [pose.key for pose in gen.POSE_SPECS]
    assert keys == [
        "front_tpose",
        "back_tpose",
        "side_left_forward",
        "side_right_forward",
        "side_neutral",
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
    assert "mid-hip" in prompt and "thigh" in prompt
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


def test_build_single_pose_negative_prompt_forbids_long_coat_and_heels() -> None:
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "long coat" in negative or "floor-length coat" in negative
    assert "heel" in negative


def test_build_single_pose_negative_prompt_does_not_re_add_panel_bans() -> None:
    """MAIN_NEGATIVE (via build_negative_prompt) already forbids grid/panel/
    multi-figure compositions -- exactly what a single-pose generation
    wants, so this must not duplicate build_limb_pose_negative_prompt's own
    extra anti-panel clauses (six figures, two rows, etc.), which belonged
    to the single-shot five-panel approach this lever replaces."""
    negative = gen.build_single_pose_negative_prompt().lower()
    assert "six figures" not in negative
    assert "six panels" not in negative


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


def test_limb_crop_boxes_for_t0351_boxes_fit_within_the_five_panel_row() -> None:
    """Each box must resolve to real pixels inside a 5120x1024 row (five
    1024x1024 panels side by side, in POSE_SPECS order) -- a box that
    overruns the row would silently crop garbage or raise deep inside PIL
    instead of failing this test with a clear message."""
    boxes = gen.limb_crop_boxes_for("T-0351", "player")
    for name, (left, top, right, bottom) in boxes.items():
        assert 0 <= left < right <= 5120, name
        assert 0 <= top < bottom <= 1024, name
