"""The one world-to-pixel scale and ground anchor shared by every side-view pose.

Why this module exists (T-0269 round 2)
----------------------------------------
Round 1 measured the SEATED figure's own native height (730.82px, head to ground) and
derived a descent scale -- 0.05473 -- that forced *that pose* to fill the same 40px
figure cell as the standing idle. That makes a crouching character render ~37.5%
*larger* than when standing, because a compact pose was being inflated to hit a tall
pose's own target height. A character's apparent size cannot depend on which pose it is
in.

So there is exactly ONE world-to-pixel scale, defined here and nowhere else, derived
once from the approved standing idle's own convention
(`docs/assets/evidence/T-0430/rig.json`: figure_px=40 at cell_px=48) and never
recomputed from any other pose's own height. Every side-view animation --
`char_gen.idle_cycle` and `char_gen.sitting_idle_cycle` alike -- imports
`CHARACTER_SCALE` and `GROUND_ANCHOR_CELL_Y` from here rather than deriving its own.

A pose that is physically more compact than the standing figure (a crouch, a sit) will
render shorter than FIGURE_PX at this scale. That is the correct result, not a defect
this module exists to hide.
"""
from __future__ import annotations

#: The 48px sprite cell every side-view animation composites into.
CELL_PX = 48

#: The STANDING idle's own reference height in that cell -- the convention this scale
#: was derived from, not a per-pose target every pose must hit.
FIGURE_PX = 40

#: Derived once from the approved standing idle (`docs/assets/evidence/T-0430/rig.json`).
#: Pose-independent: no pose's own native height is ever substituted into this number.
CHARACTER_SCALE = 0.0398

#: Where the ground plane lands within the 48px cell -- the SAME row for every pose, so
#: swapping sprites can never make the character hop. Matches the standing idle's own
#: vertical centering convention: (cell_px - figure_px) / 2 px of margin above and below
#: a 40px-tall figure, i.e. the ground sits `(cell_px - figure_px) / 2` px up from the
#: bottom edge of the cell.
GROUND_ANCHOR_CELL_Y = float(CELL_PX - (CELL_PX - FIGURE_PX) / 2.0)


def figure_height(hip_y: float, ground_plane_y: float, attach: dict,
                   head_height: float, head_pivot_y: float) -> float:
    """Topmost head pixel to the ground plane, for a hip at `hip_y` and a ground plane
    at `ground_plane_y`, both in the same native-pixel world units.

    Pose-agnostic: it takes wherever a stance's own hip and ground plane resolve to, so
    it is equally correct for a standing, seated, or crouched figure -- it reports a
    pose's own height, it does not decide a scale from it.
    """
    torso_origin_y = hip_y - attach["hip"][1]
    head_top_y = torso_origin_y + attach["neck"][1] - head_height * head_pivot_y
    return ground_plane_y - head_top_y
