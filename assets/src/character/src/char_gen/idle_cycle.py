"""Deterministic side-view idle loop for the committed character parts.

Scope, deliberately small
-------------------------
**One signal: a gentle vertical breath in the upper body.** @DennieSeth, 2026-10-05, after a
first version that layered breathing, a weight shift, torso pitch and roll, and trailing arm
motion -- correct on every measurement and too busy to watch. Idle plays constantly, so it
has to sit still enough to ignore.

So this carries a single motion and nothing else:

* the torso, head and arms rise and fall together as one piece
* the **hips and both legs do not move at all** -- they are solved once, at rest, and reused
  for every frame
* no sway, no pitch, no roll, no arm swing, no limb articulation

Because the hips are static the feet are planted trivially rather than by inverse kinematics
each frame. `solve_leg` is still used for that one-off rest pose, and remains the right tool
for any future animation whose hips *do* move while a foot stays put.

T-0437: re-derived on the canonical rig (T-0436)
-------------------------------------------------
The breathing motion above is unchanged -- @DennieSeth signed off this loop on T-0430 and
this card does not re-tune it. What changes is how the render path attaches to the rig:

* `render_frames` now passes `shoulder_points`/`hip_points` resolved from
  `side_view_rig.json`'s `canonical_rig` shoulder bar and pelvis bar (via
  `reference_pose_T0436.canonical_world_points`, the same geometry T-0436's own
  reference-pose render already established -- re-derived here, not duplicated), so
  each arm is rooted at its own shoulder-bar end and each leg at its own hip-bar end.
* `FAR_LEG_OFFSET_FRAC` -- the old fore-aft fudge that kept one shared hip's far leg
  from exactly coinciding with the near one -- is gone. The pelvis bar's two distinct
  hip points do that job now; `leg_stance`'s `far_leg_offset_frac` field is still
  required by the shared `LegStance` dataclass but is unused (0.0), exactly as
  `reference_pose_T0436.leg_stance` already does, since `hip_points` overrides both
  legs' own roots.
* `lateral_offset_frac` is applied, one value per limb chain -- see
  `far_limb_lateral_offset_frac`.
* Each arm gets its own rest-angle fields (`SHOULDER_REST_DEG_R`/`ELBOW_REST_DEG_R` and
  `SHOULDER_REST_DEG_L`/`ELBOW_REST_DEG_L`) rather than falling back to one shared
  pair -- required once the two arms are rooted at different shoulder-bar ends. A
  standing idle has no reach, so both sides keep the SAME value the single shared pair
  used before this card (0.0 / 14.0) -- the split is structural (it feeds
  `UpperPose`'s per-side `shoulder_deg_for`/`elbow_deg_for` mechanism), not a pose
  change, and is deliberately NOT the reference lunge's reach/trail pair
  (`reference_pose_T0436.SHOULDER_DEG_R`/`SHOULDER_DEG_L`). The old single-pair
  `SHOULDER_REST_DEG`/`ELBOW_REST_DEG` constants are kept, unchanged, because
  `sitting_idle_cycle` still reads them by name for its own (different) arm rest pose
  -- out of scope for this card to touch.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from char_gen import reference_pose_T0436, rig_compositor
from char_gen.walk_cycle import bone_length, distal_joint  # noqa: F401  (shared geometry)

#: One gentle rise-and-fall per loop. Two reads as panting at this frame count.
BREATH_CYCLES_PER_LOOP = 1.0

#: Vertical travel of the upper body, as a fraction of the torso's own height.
#:
#: CALIBRATED TO THE OUTPUT RESOLUTION, not chosen by eye. An earlier pass used a
#: "subtle" 0.016 and measured 0.15px of travel at the 40px figure -- arithmetically
#: present, visually absent. At this scale a readable signal has to clear a pixel, so this
#: targets ~1.1px: enough to see, small enough to ignore.
BREATH_RISE_FRAC = 0.108

#: The arms hang. Constant for the whole loop -- they ride the torso and carry no motion of
#: their own. Kept as a single shared pair for `sitting_idle_cycle`, which still reads these
#: two names directly for its own (different) arm rest pose -- out of scope for this card.
SHOULDER_REST_DEG = 0.0
ELBOW_REST_DEG = 14.0          # a hanging arm is never perfectly straight
HEAD_REST_DEG = 0.0

#: T-0437: per-side rest angles, required once the canonical rig's shoulder bar roots
#: each arm at a different point -- `UpperPose.shoulder_deg_for`/`elbow_deg_for` only
#: consult the shared pair above when a side's own override is `None`, and this card
#: sets both overrides explicitly so neither arm ever falls back. A standing idle has
#: no reach, so both sides get the SAME hang the single shared pair always used --
#: not the reference lunge's reaching/trailing pair
#: (`reference_pose_T0436.SHOULDER_DEG_R`/`SHOULDER_DEG_L`, -56.4/44.3 degrees).
SHOULDER_REST_DEG_R = SHOULDER_REST_DEG
ELBOW_REST_DEG_R = ELBOW_REST_DEG
SHOULDER_REST_DEG_L = SHOULDER_REST_DEG
ELBOW_REST_DEG_L = ELBOW_REST_DEG

#: How much of the breath the legs absorb. Zero: the hips are static, so the legs are
#: identical in every frame and the feet cannot drift.
LEG_FOLLOW = 0.0

#: The idle STANCE: straight legs, thighs vertical, feet flat.
#:
#: These are set directly rather than solved. An earlier version ran the rest pose through
#: `solve_leg` at 93% extension, which resolved to 43.4 degrees of knee flexion with the
#: thighs ~25 degrees forward -- a crouch carried over from the walk, not a standing pose.
#: A neutral stand has nothing to solve for: the thigh hangs vertical and the knee is
#: straight, so saying so is both simpler and exactly right.
IDLE_THIGH_DEG = 0.0
IDLE_KNEE_FLEXION_DEG = 0.0


@dataclass(frozen=True)
class IdlePose:
    """Resolved idle pose at one phase.

    `upper_dy` is the only field that varies across the loop. Negative is up the screen.

    T-0437: `shoulder_deg`/`elbow_deg` (the old single shared pair) are replaced by
    per-side fields -- the canonical rig roots each arm at its own shoulder-bar end,
    so a standing idle (which has no reach) now states explicitly that both sides
    hang at the same angle, rather than relying on one scalar that could no longer
    express two separately-rooted arms.
    """
    upper_dy: float
    shoulder_deg_r: float = SHOULDER_REST_DEG_R
    elbow_deg_r: float = ELBOW_REST_DEG_R
    shoulder_deg_l: float = SHOULDER_REST_DEG_L
    elbow_deg_l: float = ELBOW_REST_DEG_L
    head_deg: float = HEAD_REST_DEG
    torso_deg: float = 0.0
    hip_dx: float = 0.0
    hip_dy: float = 0.0


def breath(phase: float) -> float:
    """0..1 ease over one cycle, resting at both ends so the loop closes seamlessly."""
    return 0.5 - 0.5 * math.cos(2 * math.pi * BREATH_CYCLES_PER_LOOP * (phase % 1.0))


def pose_at(phase: float, torso_height: float) -> IdlePose:
    """Resolve the pose. Only `upper_dy` varies; everything else is the rest pose."""
    return IdlePose(upper_dy=-BREATH_RISE_FRAC * torso_height * breath(phase))


def travel_at_final_height(torso_height: float, descent_scale: float) -> float:
    """Peak-to-peak upper-body travel in FINAL pixels -- the number that decides whether
    the motion reads at all."""
    return BREATH_RISE_FRAC * torso_height * descent_scale


# --------------------------------------------------------------------- legs ----
@dataclass(frozen=True)
class LegIK:
    """Two-bone solution: angles that put an ankle under a hip."""
    thigh_deg: float
    knee_flexion_deg: float

    @property
    def calf_deg(self) -> float:
        """Absolute calf angle -- parent plus own flexion, knee bending backward."""
        return self.thigh_deg - self.knee_flexion_deg


def solve_leg(hip: tuple[float, float], ankle: tuple[float, float],
              thigh_len: float, calf_len: float) -> LegIK:
    """Angles placing `ankle` at the end of the chain hanging from `hip`.

    This rig's convention: an angle is measured from straight-down, positive swinging the
    tip toward +x. The knee bends forward, which is the human direction.
    """
    dx, dy = ankle[0] - hip[0], ankle[1] - hip[1]
    reach = math.hypot(dx, dy)
    lo, hi = abs(thigh_len - calf_len), thigh_len + calf_len
    # Clamp just inside full extension: straight is both a singularity and a locked-looking
    # pose. A sliver of bend is safer and better looking.
    reach = max(lo + 1e-6, min(hi - 1e-6, reach))

    direction = math.degrees(math.atan2(dx, dy))
    cos_a = (thigh_len ** 2 + reach ** 2 - calf_len ** 2) / (2 * thigh_len * reach)
    cos_b = (thigh_len ** 2 + calf_len ** 2 - reach ** 2) / (2 * thigh_len * calf_len)
    a = math.degrees(math.acos(max(-1.0, min(1.0, cos_a))))
    b = math.degrees(math.acos(max(-1.0, min(1.0, cos_b))))
    return LegIK(thigh_deg=direction + a, knee_flexion_deg=180.0 - b)


def idle_stance() -> LegIK:
    """The standing pose the breath rides on: straight leg, thigh vertical."""
    return LegIK(thigh_deg=IDLE_THIGH_DEG, knee_flexion_deg=IDLE_KNEE_FLEXION_DEG)


def ankle_of(hip: tuple[float, float], ik: LegIK,
             thigh_len: float, calf_len: float) -> tuple[float, float]:
    """Forward-kinematics check: where the solved chain actually puts the ankle."""
    knee = distal_joint(hip, thigh_len, ik.thigh_deg)
    return distal_joint(knee, calf_len, ik.calf_deg)


# ------------------------------------------------------------------- compositing ----
# Added for T-0269 round 2: the only way to prove the shared `character_scale`
# convention actually holds the standing idle at its approved ~40px figure height is to
# render it, next to the crouch, through the same compositor. Purely additive -- every
# function above this line is untouched, so their resolved values are unaffected.

def leg_stance(thigh_len: float, calf_len: float) -> rig_compositor.LegStance:
    """The standing stance as a `rig_compositor.LegStance`: hip directly above the
    ankle, straight leg (`IDLE_THIGH_DEG`/`IDLE_KNEE_FLEXION_DEG`), ankle on the ground
    plane `thigh_len + calf_len` below the hip. Both sides get the SAME angles -- the
    standing idle has no stagger -- `LegStance`'s per-side split (T-0269 round 3) only
    matters to a pose that actually wants two different leg angles.

    T-0437: `far_leg_offset_frac` is 0.0 and UNUSED -- the pelvis bar's two distinct
    hip points (`canonical_points`, passed as `hip_points` in `render_frames`/
    `build_placements_at`) now separate the two legs, superseding the old
    `FAR_LEG_OFFSET_FRAC` fore-aft fudge this field used to carry. Same convention
    `reference_pose_T0436.leg_stance` already established for the reference lunge."""
    return rig_compositor.LegStance(
        hip=(0.0, 0.0),
        ground_plane_y=thigh_len + calf_len,
        thigh_deg_r=IDLE_THIGH_DEG,
        knee_flexion_deg_r=IDLE_KNEE_FLEXION_DEG,
        thigh_deg_l=IDLE_THIGH_DEG,
        knee_flexion_deg_l=IDLE_KNEE_FLEXION_DEG,
        far_leg_offset_frac=0.0,
    )


def canonical_points(
    rig: dict,
) -> tuple[dict[str, tuple[float, float]], dict[str, tuple[float, float]]]:
    """Shoulder-bar and pelvis-bar world points for one idle frame, hip at the origin
    (the same convention `leg_stance` already uses) -- delegates to
    `reference_pose_T0436.canonical_world_points`, the canonical-rig geometry T-0436's
    own reference-pose render already established, rather than re-deriving it here.
    Returns `(shoulder_points, hip_points)`, ready to pass straight into
    `rig_compositor.build_placements`/`render_frames`."""
    points = reference_pose_T0436.canonical_world_points(rig, hip_world=(0.0, 0.0))
    shoulder_points = {"R": points["shoulder_R"], "L": points["shoulder_L"]}
    hip_points = {"R": points["hip_R"], "L": points["hip_L"]}
    return shoulder_points, hip_points


def far_limb_lateral_offset_frac(rig: dict) -> dict[str, float]:
    """The 3/4 lateral-offset axis, one value per limb chain, applied at each chain's
    root (`shoulder_L`/`thigh_L`; the distal part -- `forearm_L`/`calf_L` -- inherits
    the shift through forward kinematics and is named at the same value only to
    document "one offset for this chain", per `rig_compositor.build_placements`'s own
    docstring).

    Re-reads the rig's own recorded
    `canonical_rig.lateral_offset_axis.demonstration_values` (0.10 arm chain, 0.06 leg
    chain) via `reference_pose_T0436.default_lateral_offset_frac`, rather than
    inventing a second, idle-specific magnitude -- the axis's job (clear the far
    limb's own chain from the torso's silhouette) is the same whether the arm reaches,
    as the reference lunge's does, or hangs, as idle's does. Measured directly against
    idle's own hanging angles (`SHOULDER_REST_DEG_L`/`ELBOW_REST_DEG_L`, both 0.0/14.0,
    not the lunge's reach), these values leave the far arm (`shoulder_L`+`forearm_L`)
    and far leg (`thigh_L`+`calf_L`) each a four-digit visible-pixel count -- not a
    sliver -- confirmed in `tests/test_idle_canonical_rig.py`."""
    return reference_pose_T0436.default_lateral_offset_frac(rig)


def _upper_pose_at(phase: float, torso_height: float) -> rig_compositor.UpperPose:
    """`shoulder_deg`/`elbow_deg` (the shared-scalar fields) carry side R's own rest
    angle only so a reader diffing this dataclass does not mistake them for an unset
    placeholder -- they are never actually read, because `shoulder_deg_r`/
    `shoulder_deg_l` (and the elbow equivalents) are always set below, so neither arm
    ever falls back to the shared pair. Same convention `reference_pose_T0436.
    upper_pose` already uses."""
    p = pose_at(phase, torso_height)
    return rig_compositor.UpperPose(
        upper_dy=p.upper_dy, shoulder_deg=p.shoulder_deg_r, elbow_deg=p.elbow_deg_r,
        head_deg=p.head_deg,
        shoulder_deg_r=p.shoulder_deg_r, elbow_deg_r=p.elbow_deg_r,
        shoulder_deg_l=p.shoulder_deg_l, elbow_deg_l=p.elbow_deg_l,
    )


def build_placements_at(phase: float = 0.0) -> list[rig_compositor.Placement]:
    """All ten parts, placed for one phase of the idle loop -- the exact same inputs
    `render_frames` passes into the shared compositor for every frame, exposed
    standalone so a draw-order audit or a point-by-point check (and the evidence
    generator) can inspect a single frame's `Placement`s directly, rather than only
    the composited pixels `render_frames` returns."""
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    scaled = rig_compositor.scaled_parts(parts, rig)
    lengths = rig_compositor.measured_bone_lengths(parts, rig)

    stance = leg_stance(lengths["thigh_R"], lengths["calf_R"])
    shoulder_points, hip_points = canonical_points(rig)
    offsets = far_limb_lateral_offset_frac(rig)
    upper = _upper_pose_at(phase, scaled["torso"].height)

    return rig_compositor.build_placements(
        upper, stance, scaled, rig["rig"], rig["attach_torso_local_px"], lengths,
        shoulder_points=shoulder_points, hip_points=hip_points,
        lateral_offset_frac=offsets,
    )


def render_frames(frame_count: int = 12, **kwargs) -> rig_compositor.RenderResult:
    """Composite the standing idle through the shared compositor, at the one shared
    `char_gen.character_scale.CHARACTER_SCALE` -- the render this round adds so the
    standing idle's own figure height can be measured and compared against a crouch,
    rather than asserted from intent. Does not touch, and is not used to regenerate,
    the already-approved `docs/assets/evidence/T-0430` files.

    T-0437: `shoulder_points`/`hip_points`/`lateral_offset_frac` are now always
    passed -- the same `canonical_points`/`far_limb_lateral_offset_frac` helpers
    `build_placements_at` uses, so both call sites resolve the canonical rig's
    geometry from one place."""
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    stance = leg_stance(lengths["thigh_R"], lengths["calf_R"])
    shoulder_points, hip_points = canonical_points(rig)
    offsets = far_limb_lateral_offset_frac(rig)
    return rig_compositor.render_frames(
        stance, _upper_pose_at, frame_count,
        shoulder_points=shoulder_points, hip_points=hip_points,
        lateral_offset_frac=offsets,
        **kwargs,
    )
