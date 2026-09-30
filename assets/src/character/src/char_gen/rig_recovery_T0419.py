"""T-0419: recover genuine per-frame COCO-18 rig keypoints for the three
synthetic v1 state sheets (`player_crouch_hide_sheet_v1`, `player_die_sheet_v1`,
`player_move_sheet_v1`) directly from `char_gen.synth_states`'s own
deterministic drawing formulas (`_draw_crouch_frame`, `_draw_die_frame`,
`_draw_walk_frame` + `_WALK_OFFSETS`).

This is RECOVERY, not generation: every coordinate below is the exact pixel
range `synth_states` already uses to paint that frame's body/head/leg/arm
rectangles, converted to the `{"joint": i, "x": ..., "y": ...}` (normalised
0..1 within a `CELL_SIZE`-px cell) shape `asset_gate.character._load_rig_keypoints`
reads (docs/design/13-asset-pipeline.md §3.5; `tools/asset-gate/src/asset_gate/
character.py`'s `RIG_LIMB_JOINT_PAIRS`/`HEAD_JOINT_INDICES`/etc.).

Because these three sheets are flat rectangular colour blocks with no
distinct facial features or (for crouch-hide/die) no separately-drawn arm
geometry at all, several COCO joints are honestly COLLAPSED onto the same
point -- an accurate transcription of "this feature does not exist in the
source pixels", never an invented distinct position. See each function's
own docstring for exactly which joints collapse and why.

COCO-18 joint layout: 0 nose, 1 neck, 2 Rshoulder, 3 Relbow, 4 Rwrist,
5 Lshoulder, 6 Lelbow, 7 Lwrist, 8 Rhip, 9 Rknee, 10 Rankle, 11 Lhip,
12 Lknee, 13 Lankle, 14 Reye, 15 Leye, 16 Rear, 17 Lear. "R"/"L" here is
this module's own consistent-but-arbitrary side labelling (mirrors
`asset_gate.character`'s own documented caveat for its NEAR/FAR limb
groups) -- it carries no screen-left/right or character-left/right claim,
only "the same side, consistently, across every frame of one sheet".
"""

from __future__ import annotations

#: Matches `char_gen.synth_states.CELL_SIZE`. Duplicated rather than
#: imported for the same reason `asset_gate.character.RIG_CONFIG_VERSION`
#: duplicates its own upstream constant -- see that constant's docstring.
CELL_SIZE = 48

#: Mirrors `synth_states._WALK_OFFSETS` exactly -- the 10 real walk-cycle
#: frames' own (l_off, r_off) leg-stride pairs.
_WALK_OFFSETS: list[tuple[int, int]] = [
    (0, 0),
    (-2, 2),
    (-4, 4),
    (-2, 2),
    (0, 0),
    (2, -2),
    (4, -4),
    (2, -2),
    (0, 0),
    (-2, 2),
]

#: The sheet's own two documented spare/blank cells ((3,1), (3,2), T-0199) --
#: row-major frame indices 10 and 11 in a 3-col x 4-row grid.
_MOVE_BLANK_FRAME_INDICES = frozenset({10, 11})

#: `synth_states._draw_crouch_frame`/`_draw_die_frame`'s own constant body
#: cores.
_CROUCH_BODY = (10, 20, 38, 42)  # (left, top, right, bottom)
_DIE_BODY = (8, 13, 40, 42)

#: `synth_states._draw_walk_frame`'s own constants.
_MOVE_BODY = (8, 13, 42, 42)  # legs start at row 29, not the body bottom
_MOVE_HEAD = (16, 4, 28, 14)  # (left, top, right, bottom)
_MOVE_RIGHT_ARM = (40, 13, 46, 23)
_MOVE_LEFT_ARM = (2, 13, 10, 23)
_MOVE_LEG_ROW_TOP, _MOVE_LEG_ROW_BOT = 29, 35
_MOVE_LEFT_LEG_COL0, _MOVE_RIGHT_LEG_COL0 = 14, 30
_MOVE_LEG_WIDTH = 6


def _norm(col: float, row: float) -> dict:
    return {"x": col / CELL_SIZE, "y": row / CELL_SIZE}


def _joint_list(points: dict[int, tuple[float, float]]) -> list[dict]:
    return [{"joint": j, **_norm(*points[j])} for j in range(18)]


def crouch_hide_frame_keypoints(step: int) -> list[dict]:
    """`_draw_crouch_frame(step)`, step 0..8: body core rows 20:42 cols
    10:38 (constant); head rows (4+2*step):(+10) cols 16:28 (descends);
    legs rows (40-step):(+5, capped at 46) cols 14:20 (R) / 30:36 (L)
    (slide up). No facial features or arms were ever drawn distinctly --
    nose/eyes/ears collapse to the head-box centre, and
    shoulder/elbow/wrist collapse to the body-core edge on each side.
    """
    left, top, right, bottom = _CROUCH_BODY
    head_top = 4 + 2 * step
    head_bot = head_top + 10
    head_center = ((16 + 28) / 2, (head_top + head_bot) / 2)
    neck = ((left + right) / 2, top)
    leg_top = 40 - step
    leg_bot = min(leg_top + 5, 46)
    r_leg_col, l_leg_col = (30 + 36) / 2, (14 + 20) / 2

    points = {
        0: head_center,
        14: head_center,
        15: head_center,
        16: head_center,
        17: head_center,
        1: neck,
        2: (right, top),
        3: (right, top),
        4: (right, top),
        5: (left, top),
        6: (left, top),
        7: (left, top),
        8: (right, bottom),
        11: (left, bottom),
        9: (r_leg_col, (leg_top + leg_bot) / 2),
        10: (r_leg_col, leg_bot),
        12: (l_leg_col, (leg_top + leg_bot) / 2),
        13: (l_leg_col, leg_bot),
    }
    return _joint_list(points)


def die_frame_keypoints(step: int) -> list[dict]:
    """`_draw_die_frame(step)`, step 0..8: body core rows 13:42 cols 8:40
    (constant); head rows (4+2*step):(+10) cols (16+2*step):(+12) (shifts
    right+down); legs rows (41-step):(+5, capped at 46) cols 14:20 (R) /
    30:36 (L) (rise). Same collapse rationale as crouch-hide: no facial
    features or arms are drawn distinctly.
    """
    left, top, right, bottom = _DIE_BODY
    head_r0 = 4 + 2 * step
    head_c0 = 16 + 2 * step
    head_center = (head_c0 + 6, head_r0 + 5)
    neck = ((left + right) / 2, top)
    leg_r0 = 41 - step
    leg_r1 = min(leg_r0 + 5, 46)
    r_leg_col, l_leg_col = (30 + 36) / 2, (14 + 20) / 2

    points = {
        0: head_center,
        14: head_center,
        15: head_center,
        16: head_center,
        17: head_center,
        1: neck,
        2: (right, top),
        3: (right, top),
        4: (right, top),
        5: (left, top),
        6: (left, top),
        7: (left, top),
        8: (right, bottom),
        11: (left, bottom),
        9: (r_leg_col, (leg_r0 + leg_r1) / 2),
        10: (r_leg_col, leg_r1),
        12: (l_leg_col, (leg_r0 + leg_r1) / 2),
        13: (l_leg_col, leg_r1),
    }
    return _joint_list(points)


def move_frame_keypoints(frame_index: int) -> list[dict]:
    """`_draw_walk_frame` + `_WALK_OFFSETS`, row-major frame_index 0..11
    across the sheet's real 3x4 grid: frames 0-9 are the 10 real walk-cycle
    frames (`_WALK_OFFSETS[frame_index]` gives that frame's own (l_off,
    r_off) leg-stride shift); frames 10-11 are the sheet's own documented
    spare/blank cells ((3,1), (3,2)) with no figure drawn at all -- every
    joint collapses to the cell centre (0.5, 0.5) for those two, the
    honest way to record "no pose exists here" rather than inventing one.

    Unlike crouch-hide/die, `_draw_walk_frame` draws real (constant across
    frames) arm rectangles, so shoulder/elbow/wrist are genuine distinct
    points here, not collapsed.
    """
    if frame_index in _MOVE_BLANK_FRAME_INDICES:
        return [{"joint": j, "x": 0.5, "y": 0.5} for j in range(18)]

    l_off, r_off = _WALK_OFFSETS[frame_index]
    body_left, body_top, body_right, _ = _MOVE_BODY
    head_left, head_top, head_right, head_bot = _MOVE_HEAD
    head_center = ((head_left + head_right) / 2, (head_top + head_bot) / 2)
    neck = ((body_left + body_right) / 2, body_top)

    ra_left, ra_top, ra_right, ra_bot = _MOVE_RIGHT_ARM
    la_left, la_top, la_right, la_bot = _MOVE_LEFT_ARM
    arm_row = (ra_top + ra_bot) / 2
    r_shoulder, r_elbow, r_wrist = ra_left, (ra_left + ra_right) / 2, ra_right - 1
    l_shoulder, l_elbow, l_wrist = la_right, (la_left + la_right) / 2, la_left + 1

    r_hip_col = _MOVE_RIGHT_LEG_COL0 + _MOVE_LEG_WIDTH / 2
    l_hip_col = _MOVE_LEFT_LEG_COL0 + _MOVE_LEG_WIDTH / 2
    leg_row = (_MOVE_LEG_ROW_TOP + _MOVE_LEG_ROW_BOT) / 2
    r_knee_col = _MOVE_RIGHT_LEG_COL0 + r_off + _MOVE_LEG_WIDTH / 2
    l_knee_col = _MOVE_LEFT_LEG_COL0 + l_off + _MOVE_LEG_WIDTH / 2

    points = {
        0: head_center,
        14: head_center,
        15: head_center,
        16: head_center,
        17: head_center,
        1: neck,
        2: (r_shoulder, arm_row),
        3: (r_elbow, arm_row),
        4: (r_wrist, arm_row),
        5: (l_shoulder, arm_row),
        6: (l_elbow, arm_row),
        7: (l_wrist, arm_row),
        8: (r_hip_col, _MOVE_LEG_ROW_TOP),
        11: (l_hip_col, _MOVE_LEG_ROW_TOP),
        9: (r_knee_col, leg_row),
        10: (r_knee_col, _MOVE_LEG_ROW_BOT),
        12: (l_knee_col, leg_row),
        13: (l_knee_col, _MOVE_LEG_ROW_BOT),
    }
    return _joint_list(points)


def move_sheet_frame_count() -> int:
    """`player_move_sheet_v1`'s own `layout.cols * layout.rows` (3*4) --
    the asset-gate recompute requires one `frame_generation` entry per
    grid cell, not per real walk frame, so the 2 spare/blank cells need
    entries too (see `_MOVE_BLANK_FRAME_INDICES`)."""
    return 12
