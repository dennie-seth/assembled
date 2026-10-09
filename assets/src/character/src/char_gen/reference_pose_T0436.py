"""The static render that proves the canonical rig (T-0436) can reproduce the
structural features measured from @DennieSeth's skeleton reference: a shoulder bar
and a pelvis bar with two distinct ends each, and a per-part lateral offset that
clears the far arm from the torso's own silhouette instead of merely re-sorting it
behind.

Scope, deliberately narrow (docs/design/23-canonical-rig.md): this is not
`walk_cycle`/`idle_cycle`/`sitting_idle_cycle` re-derived. It calls the shared
`rig_compositor.render_frames` for exactly one static frame, using the new opt-in
`shoulder_points`/`hip_points`/`lateral_offset_frac` parameters every pre-existing
pose module leaves unset.

What this render does and does not prove
-----------------------------------------
The reference image (`zorder_fix_2026-10-08/dennie_canonical_skeleton_ref.png`) is
not present in this worktree or this card's attachments -- only the structural
measurements transcribed into the task card (the two bar widths, the near/far limb
ratios) are available, not the lunge's own joint ANGLES. This render therefore
reproduces the measured STRUCTURE (bar widths, the far arm's visibility) in a
representative wide-stance pose chosen to exercise that structure, not a
pixel-matched copy of the reference's exact silhouette.
"""
from __future__ import annotations

from char_gen import rig_compositor

#: A wide-stance lunge, representative of the reference's "wide-stance 3/4 action
#: pose" framing. The reference's own joint angles were not transcribed into this
#: card -- see the module docstring.
FRONT_THIGH_DEG = 42.0
FRONT_KNEE_FLEXION_DEG = 55.0
BACK_THIGH_DEG = -22.0
BACK_KNEE_FLEXION_DEG = 8.0

#: Fix round 4 -- per-side arm angles, extracted from the red bone lines in the
#: attached `dennie_canonical_skeleton_ref.png`, then mirrored (the reference faces
#: -x, this rig faces +x, so `theta -> 180 - theta`) and converted into this rig's
#: own `sign_convention.positive_angle` (0 = hanging straight down, positive swings
#: the tip toward +x). R is the near arm, reaching forward; L is the far arm,
#: trailing back -- one shared scalar cannot express both, which is why
#: `UpperPose` gained the per-side `*_r`/`*_l` fields this round. Replaces the
#: previous SHOULDER_REST_DEG/ELBOW_REST_DEG rest pose (10.0/20.0 for both arms),
#: which rendered as two parallel droops rather than a reach and a trail.
SHOULDER_DEG_R = 44.3
ELBOW_DEG_R = 40.7
SHOULDER_DEG_L = -56.4
ELBOW_DEG_L = 33.2
HEAD_REST_DEG = 0.0

#: Pulls the far shoulder/forearm/thigh/calf clear of the torso's own silhouette --
#: the fix for the far arm's 0-visible-pixel baseline. Chosen empirically (see
#: docs/design/23-canonical-rig.md for the resulting visible-pixel counts) and
#: carried in the rig's own `canonical_rig.lateral_offset_axis.demonstration_values`
#: as the single recorded source of truth; this module reads it from there rather
#: than repeating the numbers.
def default_lateral_offset_frac(rig: dict) -> dict[str, float]:
    return dict(rig["canonical_rig"]["lateral_offset_axis"]["demonstration_values"])


def canonical_world_points(
    rig: dict, hip_world: tuple[float, float]
) -> dict[str, tuple[float, float]]:
    """Shoulder-bar and pelvis-bar end points, in the SAME world frame as `hip_world`
    -- i.e. `hip_world + (local - hip_local)`, the no-torso-lean case of
    `rig_compositor.build_placements`'s own `attach_world` (this render holds
    `torso_deg` at 0, so that reduction is exact, not an approximation)."""
    attach = rig["attach_torso_local_px"]
    hip_local = attach["hip"]
    shoulder_local = attach["shoulder"]
    canonical = rig["canonical_rig"]

    def world_of(
        local_point: tuple[float, float], local_y_ref: tuple[float, float]
    ) -> tuple[float, float]:
        return (
            hip_world[0] + (local_point[0] - hip_local[0]),
            hip_world[1] + (local_y_ref[1] - hip_local[1]),
        )

    shoulder_bar = canonical["shoulder_bar"]
    pelvis_bar = canonical["pelvis_bar"]
    return {
        "shoulder_R": world_of(shoulder_bar["R_local_px"], shoulder_local),
        "shoulder_L": world_of(shoulder_bar["L_local_px"], shoulder_local),
        "hip_R": world_of(pelvis_bar["R_local_px"], hip_local),
        "hip_L": world_of(pelvis_bar["L_local_px"], hip_local),
    }


def leg_stance(hip_world: tuple[float, float], ground_plane_y: float) -> rig_compositor.LegStance:
    return rig_compositor.LegStance(
        hip=hip_world,
        ground_plane_y=ground_plane_y,
        thigh_deg_r=FRONT_THIGH_DEG,
        knee_flexion_deg_r=FRONT_KNEE_FLEXION_DEG,
        thigh_deg_l=BACK_THIGH_DEG,
        knee_flexion_deg_l=BACK_KNEE_FLEXION_DEG,
        far_leg_offset_frac=0.0,  # unused: hip_points overrides this leg's own split
    )


def upper_pose(_phase: float, _torso_height: float) -> rig_compositor.UpperPose:
    """`shoulder_deg`/`elbow_deg` (the shared-scalar fields) are set to the near
    (R) arm's own angle -- they are never read because `shoulder_deg_r`/
    `elbow_deg_r` override them for side R, and `shoulder_deg_l`/`elbow_deg_l`
    override them for side L, so no side ever falls back to the shared pair. They
    carry a real value rather than 0.0 only so a reader diffing this dataclass
    does not mistake the shared fields for an unset/placeholder pose."""
    return rig_compositor.UpperPose(
        upper_dy=0.0, shoulder_deg=SHOULDER_DEG_R, elbow_deg=ELBOW_DEG_R,
        head_deg=HEAD_REST_DEG,
        shoulder_deg_r=SHOULDER_DEG_R, elbow_deg_r=ELBOW_DEG_R,
        shoulder_deg_l=SHOULDER_DEG_L, elbow_deg_l=ELBOW_DEG_L,
    )


def build_reference_placements(
    *, lateral_offset_frac: dict[str, float] | None = None,
) -> list[rig_compositor.Placement]:
    """The ten parts, placed for one static frame of the reference pose. Defaults to
    the rig's own recorded demonstration offsets; pass `lateral_offset_frac={}` to
    see the two-point bar attach WITHOUT the extra sideways push, the contrast case
    that proves the push -- not the bar alone -- is what clears the far arm."""
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    scaled = rig_compositor.scaled_parts(parts, rig)
    lengths = rig_compositor.measured_bone_lengths(parts, rig)
    rig_entries = rig["rig"]
    attach = rig["attach_torso_local_px"]

    hip_world = (0.0, 0.0)
    points = canonical_world_points(rig, hip_world)
    ground_plane_y = max(
        lengths["thigh_R"] + lengths["calf_R"], lengths["thigh_L"] + lengths["calf_L"]
    )
    stance = leg_stance(hip_world, ground_plane_y)
    offsets = (
        default_lateral_offset_frac(rig) if lateral_offset_frac is None else lateral_offset_frac
    )

    return rig_compositor.build_placements(
        upper_pose(0.0, scaled["torso"].height),
        stance,
        scaled,
        rig_entries,
        attach,
        lengths,
        shoulder_points={"R": points["shoulder_R"], "L": points["shoulder_L"]},
        hip_points={"R": points["hip_R"], "L": points["hip_L"]},
        lateral_offset_frac=offsets,
    )


def render() -> rig_compositor.RenderResult:
    """The same pose, through the full `rig_compositor.render_frames` pipeline (one
    frame) -- ground anchoring, character-scale descent, the cell composite -- for
    evidence generation."""
    parts = rig_compositor.load_parts()
    rig = rig_compositor.load_rig()
    lengths = rig_compositor.measured_bone_lengths(parts, rig)

    hip_world = (0.0, 0.0)
    points = canonical_world_points(rig, hip_world)
    ground_plane_y = max(
        lengths["thigh_R"] + lengths["calf_R"], lengths["thigh_L"] + lengths["calf_L"]
    )
    stance = leg_stance(hip_world, ground_plane_y)

    return rig_compositor.render_frames(
        stance, upper_pose, frame_count=1,
        shoulder_points={"R": points["shoulder_R"], "L": points["shoulder_L"]},
        hip_points={"R": points["hip_R"], "L": points["hip_L"]},
        lateral_offset_frac=default_lateral_offset_frac(rig),
    )
