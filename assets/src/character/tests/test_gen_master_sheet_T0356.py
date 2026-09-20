"""Tier-1 master-sheet successor round: forward-limb-conditioned side panels
+ unobstructed legs panel (T-0356).

Successor to T-0351 (PR #368), which stopped and reported at the 3-attempt
RE-SCOPE cap with 3 of 6 panels clean (front_tpose, back_tpose, side_neutral)
and identified precisely why the other three never converged: reference
conditioning must be POSE-matched, not merely view-matched, and no
forward-limb reference existed for side_left_forward/side_right_forward.

This card changes exactly three things, nothing else:
  1. side_left_forward/side_right_forward now condition on the forward-limb
     green side reference (T-0394's promoted attempt 2,
     assets/src/concept/player_profile_forward_limb_reference_controlnet.png)
     instead of T-0317's neutral-pose profile, plus an explicit,
     CLIP-emphasized coat-length clause matching that reference's own
     provenance wording (T-0351 attempt 21 showed the coat drifting to
     mid-thigh on seed variance alone when this was left unweighted).
  2. The "legs" panel's negative prompt gains terms for the specific defect
     T-0351 attempt 19 showed under its own unchanged torso-free ControlNet
     skeleton: a coat FLAP draped over the thighs (not a full coat body,
     already banned) -- "flap"/"drape"/"hem" were never named.
  3. This card's own attempt cap is 4 (its own pre-registered stop-and-report
     threshold), distinct from T-0351's 21.

Panels 1 (front_tpose), 2 (back_tpose), 5 (side_neutral), and the legs
panel's own positive prompt are explicitly asserted BYTE-IDENTICAL to
T-0351's solved recipe -- this card's own "do not re-tune panels 1, 2 or 5"
rule, enforced mechanically, not just by docstring promise.

Pure construction/string tests plus a mocked-ComfyUI graph-capture test (the
same pattern test_gen_master_sheet_T0351.py's own ipadapter_end_at test
uses) -- no live network dependency. RED state: FORWARD_LIMB_REFERENCE_PATH,
build_forward_limb_pose_positive_prompt, build_forward_limb_legs_panel_negative_prompt,
and resolve_pose_prompts do not exist yet -> AttributeError.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_master_sheet_T0336 as gen  # noqa: E402

CARD = "T-0356"


# ── Attempt cap: this card's own pre-registered 4-attempt stop-and-report ──


def test_check_attempt_cap_t0356_caps_at_four() -> None:
    gen.check_attempt_cap(4, card=CARD)  # must not raise
    with pytest.raises(SystemExit):
        gen.check_attempt_cap(5, card=CARD)


def test_t0356_registered_as_a_five_pose_card() -> None:
    assert CARD in gen.FIVE_POSE_CARDS


# ── The forward-limb reference itself -- must be a real, committed file ────


def test_forward_limb_reference_path_exists_and_is_a_raster_image() -> None:
    from PIL import Image

    path = gen.FORWARD_LIMB_REFERENCE_PATH
    assert path.exists(), path
    with Image.open(path) as im:
        im.verify()


def test_forward_limb_reference_path_is_committed_under_concept() -> None:
    assert gen.FORWARD_LIMB_REFERENCE_PATH.parent == gen.REPO_ROOT / "assets" / "src" / "concept"
    assert gen.FORWARD_LIMB_REFERENCE_PATH.name == (
        "player_profile_forward_limb_reference_controlnet.png"
    )


# ── reference_image_for: panels 1/2/5/6 reuse T-0351 unchanged, panels 3/4 ──
# resolve to the new forward-limb reference. ────────────────────────────────


def test_reference_image_for_t0356_front_back_neutral_legs_match_t0351_unchanged() -> None:
    """This card's own 'reuse the recipe unchanged' rule for panels 1, 2, 5
    (and the legs panel, which no reference change was ever asked for
    either) -- enforced mechanically: the exact same (path, crop) pair
    T-0351 resolves, not just a similar one."""
    for pose_key in ("front_tpose", "back_tpose", "side_neutral", "legs"):
        assert gen.reference_image_for(CARD, "player", pose_key) == gen.reference_image_for(
            "T-0351", "player", pose_key
        ), pose_key


def test_reference_image_for_t0356_side_forward_panels_use_the_forward_limb_reference() -> None:
    for pose_key in ("side_left_forward", "side_right_forward"):
        path, box = gen.reference_image_for(CARD, "player", pose_key)
        assert path == gen.FORWARD_LIMB_REFERENCE_PATH, pose_key
        # already a single isolated figure at 1024x1024 -- used whole, no crop.
        assert box is None, pose_key


def test_reference_image_for_t0356_side_forward_panels_differ_from_t0351() -> None:
    """The whole point of this card: T-0351's own side_left_forward/
    side_right_forward conditioned on T-0317 (a neutral, arms-down
    reference) and never converged in 21 attempts -- this card must
    resolve to a genuinely different reference for those two panels."""
    for pose_key in ("side_left_forward", "side_right_forward"):
        assert gen.reference_image_for(CARD, "player", pose_key) != gen.reference_image_for(
            "T-0351", "player", pose_key
        ), pose_key


# ── build_forward_limb_pose_positive_prompt: side_left_forward/right only ──


def test_build_forward_limb_pose_positive_prompt_carries_the_reference_coat_length() -> None:
    """T-0351 attempt 21 showed the coat drifting to mid-thigh on seed
    variance alone when the shared 'full-length coat reaching past the
    knee' clause every panel already carries (build_single_pose_positive_prompt)
    is left unweighted. This card's own reference (T-0394's promoted
    attempt 2 provenance) explicitly states 'coat reaching to mid-shin,
    well past the knee' -- carry that exact constraint, CLIP-emphasized."""
    player = gen.ENTITIES["player"]
    pose = next(p for p in gen.POSE_SPECS if p.key == "side_left_forward")
    prompt = gen.build_forward_limb_pose_positive_prompt(player, pose).lower()
    assert "mid-shin" in prompt
    assert "knee" in prompt
    assert ":1." in prompt


def test_build_forward_limb_pose_positive_prompt_coat_clause_is_emphasized() -> None:
    player = gen.ENTITIES["player"]
    pose = next(p for p in gen.POSE_SPECS if p.key == "side_right_forward")
    prompt = gen.build_forward_limb_pose_positive_prompt(player, pose)
    lowered = prompt.lower()
    coat_start = lowered.index("mid-shin")
    preceding_open_paren = prompt.rfind("(", 0, coat_start)
    assert preceding_open_paren != -1, "coat-length clause must be wrapped in its own emphasis"
    assert prompt.count("(") == prompt.count(")")


def test_build_forward_limb_pose_positive_prompt_keeps_pose_and_identity_wording() -> None:
    """Only the coat-length clause is new -- pose, isolation, hood/mask and
    costume wording must still carry over from build_single_pose_positive_prompt
    unchanged, since this is a targeted addition, not a rewrite."""
    player = gen.ENTITIES["player"]
    pose = next(p for p in gen.POSE_SPECS if p.key == "side_left_forward")
    prompt = gen.build_forward_limb_pose_positive_prompt(player, pose).lower()
    assert pose.pose_clause.lower() in prompt
    assert "hooded mask" in prompt and "eye lenses" in prompt
    assert "institutional green coat" in prompt
    assert "single full-body figure" in prompt


def test_build_forward_limb_pose_positive_prompt_side_right_forward_keeps_its_own_pose() -> None:
    player = gen.ENTITIES["player"]
    pose = next(p for p in gen.POSE_SPECS if p.key == "side_right_forward")
    prompt = gen.build_forward_limb_pose_positive_prompt(player, pose).lower()
    assert "right arm" in prompt and "right leg" in prompt
    assert "left arm" in prompt and "left leg" in prompt


# ── build_forward_limb_legs_panel_negative_prompt: the coat-flap fix ───────


def test_build_forward_limb_legs_panel_negative_prompt_bans_the_coat_flap() -> None:
    """T-0351 attempt 19: the legs panel exposed the thighs (the panel's own
    purpose) but a coat flap still draped over them -- 'flap'/'drape'/'hem'
    were never named by the existing coat/jacket/cloak/cape ban."""
    negative = gen.build_forward_limb_legs_panel_negative_prompt().lower()
    assert "flap" in negative
    assert "drape" in negative or "draped" in negative


def test_build_forward_limb_legs_panel_negative_prompt_includes_t0351_baseline() -> None:
    """Additive, not a replacement -- every existing ban (coat, jacket,
    cape, ...) from build_legs_panel_negative_prompt must still be present."""
    base = gen.build_legs_panel_negative_prompt().lower()
    extended = gen.build_forward_limb_legs_panel_negative_prompt().lower()
    for term in ("coat", "jacket", "cape", "cloak"):
        assert term in base and term in extended
    assert extended != base


# ── resolve_pose_prompts: the single wiring point run_five_pose_attempt ────
# uses -- panels 1/2/5/legs-positive must be BYTE-IDENTICAL to T-0351's own
# solved recipe; only side_left_forward/side_right_forward (positive) and
# legs (negative) differ for this card.


def test_resolve_pose_prompts_reuses_t0351_recipe_unchanged_for_solved_panels() -> None:
    player = gen.ENTITIES["player"]
    for pose_key in ("front_tpose", "back_tpose", "side_neutral"):
        pose = next(p for p in gen.POSE_SPECS if p.key == pose_key)
        t0356_positive, t0356_negative = gen.resolve_pose_prompts(CARD, player, pose)
        assert t0356_positive == gen.build_single_pose_positive_prompt(player, pose), pose_key
        assert t0356_negative == gen.build_single_pose_negative_prompt(pose), pose_key


def test_resolve_pose_prompts_legs_panel_positive_unchanged_negative_extended() -> None:
    player = gen.ENTITIES["player"]
    pose = next(p for p in gen.POSE_SPECS if p.key == "legs")
    positive, negative = gen.resolve_pose_prompts(CARD, player, pose)
    assert positive == gen.build_legs_panel_positive_prompt(player)
    assert negative == gen.build_forward_limb_legs_panel_negative_prompt()
    assert negative != gen.build_legs_panel_negative_prompt()


def test_resolve_pose_prompts_forward_panels_use_the_new_builder() -> None:
    player = gen.ENTITIES["player"]
    for pose_key in ("side_left_forward", "side_right_forward"):
        pose = next(p for p in gen.POSE_SPECS if p.key == pose_key)
        positive, negative = gen.resolve_pose_prompts(CARD, player, pose)
        assert positive == gen.build_forward_limb_pose_positive_prompt(player, pose)
        assert positive != gen.build_single_pose_positive_prompt(player, pose)
        # negative prompt is unchanged -- only the positive-prompt coat
        # clause and the reference image differ for these two panels.
        assert negative == gen.build_single_pose_negative_prompt(pose)


def test_resolve_pose_prompts_t0351_card_still_uses_original_builders_unchanged() -> None:
    """This card's own dispatch must not leak into T-0351's call sites --
    resolve_pose_prompts is a new function T-0351 never calls."""
    player = gen.ENTITIES["player"]
    for pose in gen.POSE_SPECS:
        if pose.no_coat:
            positive, negative = gen.resolve_pose_prompts("T-0351", player, pose)
            assert positive == gen.build_legs_panel_positive_prompt(player)
            assert negative == gen.build_legs_panel_negative_prompt()
        else:
            positive, negative = gen.resolve_pose_prompts("T-0351", player, pose)
            assert positive == gen.build_single_pose_positive_prompt(player, pose)
            assert negative == gen.build_single_pose_negative_prompt(pose)


# ── limb_crop_boxes_for: same six-panel-row layout as T-0351, reused as-is ─


def test_limb_crop_boxes_for_t0356_matches_t0351_unchanged() -> None:
    """The panel layout (six 1024x1024 panels in POSE_SPECS order) is
    unchanged from T-0351 -- only the reference conditioning and the legs
    negative prompt differ, neither of which moves any pixel's position in
    the composited row, so the hand-tuned crop boxes carry over exactly."""
    assert gen.limb_crop_boxes_for(CARD, "player") == gen.limb_crop_boxes_for("T-0351", "player")
    assert "upper_leg" in gen.limb_crop_boxes_for(CARD, "player")


# ── run_five_pose_attempt wiring: mocked ComfyUI, same pattern as T-0351's ──
# own test_run_five_pose_attempt_threads_ipadapter_end_at_per_pose.


def test_run_five_pose_attempt_t0356_conditions_side_panels_on_forward_limb_reference(
    monkeypatch,
) -> None:
    from PIL import Image

    test_out_dir = gen.REPO_ROOT / "assets" / "out" / "_test_scratch_T0356_forward_limb"
    test_out_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(gen, "out_dir_for", lambda card, entity, attempt: test_out_dir)

    captured_graphs = []
    uploaded_paths = []

    def fake_upload_image(path):
        uploaded_paths.append(Path(path))
        return Path(path).name

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
            entity_name="player", attempt=1, base_seed=5000, width=64, height=64, card=CARD
        )
        assert len(provenance["poses"]) == 6

        by_key = {record["key"]: record for record in provenance["poses"]}
        for pose_key in ("side_left_forward", "side_right_forward"):
            assert by_key[pose_key]["reference_image"] == str(
                gen.FORWARD_LIMB_REFERENCE_PATH.relative_to(gen.REPO_ROOT)
            )
        for pose_key in ("front_tpose", "back_tpose", "side_neutral", "legs"):
            t0351_expected_path = gen.reference_image_for("T-0351", "player", pose_key)[0]
            assert by_key[pose_key]["reference_image"] == str(
                t0351_expected_path.relative_to(gen.REPO_ROOT)
            )

        # The legs panel's own graph positive/negative text must match this
        # card's own resolved builders, not T-0351's plain ones.
        legs_index = [pose.key for pose in gen.POSE_SPECS].index("legs")
        assert (
            by_key["legs"]["negative_prompt"]
            == gen.build_forward_limb_legs_panel_negative_prompt()
        )
        assert by_key["legs"]["prompt"] == gen.build_legs_panel_positive_prompt(
            gen.ENTITIES["player"]
        )
        assert captured_graphs[legs_index] is not None  # graph was actually submitted
    finally:
        shutil.rmtree(test_out_dir, ignore_errors=True)
