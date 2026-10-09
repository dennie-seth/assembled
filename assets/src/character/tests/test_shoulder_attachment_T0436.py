"""T-0436 fix round 5 (+ fix round 6's layering swap, + fix round 7's L/R suffix
rename): the far shoulder's attachment to the torso.

@DennieSeth's fix-round-5 comment found the reference-pose render reads as a
detached sleeve -- an "armhole" wedge of background between the far shoulder and
`torso` near the shoulder joint -- and that a uniform part up-scale cannot close
it, because the part is pinned at its own (proximal) pivot and scaling only moves
the distal end. The real cause is the arm-chain `lateral_offset_frac` (fix round
2's magnitude 0.35, `canonical_rig.lateral_offset_axis.demonstration_values`)
over-pushing the sleeve clear of the torso; the fix drops the magnitude to 0.10 and
separately restores the far shoulder's own CUT WIDTH (shrunk to 61% of the
artist's cut as a side effect of the existing bone-length correction) via a new
anisotropic `bone_length_fix.scaled` form, both measured directly here rather than
asserted from the rig's own numbers.

Fix round 6 (@DennieSeth's Option B, 2026-10-09T16:43) swapped the near/far
layering wholesale: `_L` drew in front, `_R` was far, so the lateral offset (and
therefore the armhole measurement) moved from `shoulder_L`/`forearm_L` to
`shoulder_R`/`forearm_R` for that round. Fix round 7 (2026-10-09T17:06) then
swapped the L/R suffix on all eight limb parts -- files renamed, rig keys renamed,
every side-keyed value carried with its physical part -- so the name tracks draw
depth directly: near/front = `_R`, far/behind = `_L` again.
`armhole_wedge_px`/`sleeve_torso_overlap_px` below default to `shoulder_name=
"shoulder_L"` (the far side under this naming), and
`TestReferencePoseShoulderAttachment` re-measures on the renamed rig rather than
assuming the fix-round-6 numbers transfer unchanged by name (they transfer
unchanged by PHYSICAL PART -- a rename, not a re-measurement -- but the
assertion still re-measures directly, since the acceptance criterion requires
verifying the rename against the actual render rather than assuming it).

`TestArmholeGeometry` -- synthetic placements, proving `armhole_wedge_px`/
`sleeve_torso_overlap_px` measure what their own names say, independent of the
real rig.

`TestReferencePoseShoulderAttachment` -- the real acceptance numbers against the
committed rig: the armhole wedge is small, the sleeve genuinely overlaps the
torso, the far arm stays visible well above the floor, the silhouette gains no new
fragment, and the draw order is unaffected.
"""
from __future__ import annotations

import hashlib

import numpy as np
import pytest
from PIL import Image

from char_gen import reference_pose_T0436 as refpose
from char_gen import rig_compositor
from char_gen.draw_order_audit_T0436 import canvas_geometry, contested_pairs, part_alpha_masks
from char_gen.part_isolation import _label_connected_components
from char_gen.rig_compositor import Placement
from char_gen.shoulder_attachment_T0436 import (
    armhole_wedge_px,
    sleeve_torso_overlap_px,
    visible_pixel_count,
)


def _solid_part(size: tuple[int, int]) -> Image.Image:
    return Image.new("RGBA", size, (200, 200, 200, 255))


def _placement(
    name: str, size: tuple[int, int], target_xy: tuple[float, float], z: int
) -> Placement:
    return Placement(
        name, _solid_part(size), pivot_px=(size[0] / 2.0, 0.0), target_xy=target_xy, z=z
    )


class TestArmholeGeometry:
    """Synthetic two-rectangle scenes -- isolates the geometry from the real rig's
    own part shapes. Uses `shoulder_L` as the synthetic placement's own name and
    passes it explicitly (it happens to match the functions' current default, the
    far side under the committed fix-round-7 naming, but passes it explicitly
    regardless) -- these tests are about the geometry, not about which side."""

    def test_no_gap_when_shoulder_overlaps_torso(self):
        torso = _placement("torso", (100, 200), (0.0, 0.0), z=5)
        shoulder = _placement("shoulder_L", (40, 40), (10.0, 0.0), z=8)
        placements = [torso, shoulder]
        assert armhole_wedge_px(placements, shoulder_name="shoulder_L") == 0
        assert sleeve_torso_overlap_px(placements, shoulder_name="shoulder_L") > 0

    def test_wedge_grows_as_the_sleeve_pulls_away_from_the_torso(self):
        near = [
            _placement("torso", (100, 200), (0.0, 0.0), z=5),
            _placement("shoulder_L", (40, 40), (70.0, 0.0), z=8),
        ]
        far = [
            _placement("torso", (100, 200), (0.0, 0.0), z=5),
            _placement("shoulder_L", (40, 40), (140.0, 0.0), z=8),
        ]
        wedge_near = armhole_wedge_px(near, shoulder_name="shoulder_L")
        wedge_far = armhole_wedge_px(far, shoulder_name="shoulder_L")
        assert wedge_near == 0, "the sleeve still overlaps the torso here"
        assert wedge_far > 0, "the sleeve is pulled clear -- a gap must appear"

    def test_wedge_respects_the_radius_bound(self):
        """This is specifically an ARMHOLE measurement -- a small radius only
        counts the sliver of the gap immediately adjacent to the joint, not the
        whole gap between two far-apart shapes."""
        torso = _placement("torso", (100, 200), (0.0, 0.0), z=5)
        shoulder = _placement("shoulder_L", (40, 40), (300.0, 0.0), z=8)
        placements = [torso, shoulder]
        small_radius = armhole_wedge_px(placements, radius=5.0, shoulder_name="shoulder_L")
        large_radius = armhole_wedge_px(placements, radius=400.0, shoulder_name="shoulder_L")
        assert small_radius < large_radius, "a bigger radius must admit more of the same gap"
        assert small_radius <= 40, "a 5px radius must not pull in the whole 150px gap"

    def test_overlap_counts_only_jointly_opaque_pixels(self):
        torso = _placement("torso", (100, 200), (0.0, 0.0), z=5)
        shoulder_touching = _placement("shoulder_L", (40, 40), (69.0, 0.0), z=8)
        shoulder_clear = _placement("shoulder_L", (40, 40), (200.0, 0.0), z=8)
        assert sleeve_torso_overlap_px(
            [torso, shoulder_touching], shoulder_name="shoulder_L"
        ) > 0
        assert sleeve_torso_overlap_px(
            [torso, shoulder_clear], shoulder_name="shoulder_L"
        ) == 0


class TestVisiblePixelCountMatchesTheExistingDefinition:
    """`shoulder_attachment_T0436.visible_pixel_count` is a production-code copy
    of `tests/test_reference_pose_render_T0436.py`'s own helper (duplicated, not
    imported, so neither test module reaches into the other) -- prove the two
    agree on the real rig rather than trusting that by inspection alone."""

    def test_agrees_with_the_reference_render_test_helper(self):
        from tests.test_reference_pose_render_T0436 import (
            visible_pixel_count as test_module_visible_pixel_count,
        )

        placements = refpose.build_reference_placements()
        for part_name in ("shoulder_L", "forearm_L", "torso"):
            assert visible_pixel_count(placements, part_name) == test_module_visible_pixel_count(
                placements, part_name
            )


class TestReferencePoseShoulderAttachment:
    """The real acceptance numbers, measured against the committed rig -- not
    copied from the task card's own prose. Fix round 6 moved the lateral offset
    (and therefore the armhole measurement) from `shoulder_L`/`forearm_L` to
    `shoulder_R`/`forearm_R`, that round's far side under Option B; fix round 7
    then renamed all eight limb parts so the name tracks draw depth directly,
    putting the far side back on `shoulder_L`/`forearm_L` -- the SAME physical
    part fix round 6 called `shoulder_R`, carrying the same anisotropic
    bone-length-fix width restore. These numbers are re-measured directly against
    the renamed, committed rig rather than assumed to carry over unchanged."""

    def test_armhole_wedge_is_at_most_400px(self):
        placements = refpose.build_reference_placements()
        wedge = armhole_wedge_px(placements)
        assert 0 < wedge <= 400, f"armhole wedge is {wedge}px"

    def test_armhole_wedge_shrank_from_the_fix_round_4_baseline(self):
        """The fix-round-4 committed offset magnitude (0.35) left the armhole
        wide open -- confirm the NEW rig is a real improvement, not just under
        the ceiling by accident."""
        placements = refpose.build_reference_placements()
        baseline_offsets = {
            "shoulder_L": 0.35, "forearm_L": 0.35, "thigh_L": 0.06, "calf_L": 0.06,
        }
        baseline = refpose.build_reference_placements(lateral_offset_frac=baseline_offsets)
        assert armhole_wedge_px(placements) < armhole_wedge_px(baseline)

    def test_shoulder_l_genuinely_overlaps_the_torso(self):
        placements = refpose.build_reference_placements()
        assert sleeve_torso_overlap_px(placements) > 0

    def test_far_arm_stays_visible_above_the_18000px_floor(self):
        placements = refpose.build_reference_placements()
        shoulder_px = visible_pixel_count(placements, "shoulder_L")
        forearm_px = visible_pixel_count(placements, "forearm_L")
        assert shoulder_px > 0
        assert forearm_px > 0
        assert shoulder_px + forearm_px >= 18000

    def test_silhouette_gains_no_new_fragment(self):
        """4-connectivity labelling of the rendered alpha -- the same algorithm
        `docs/design/23-canonical-rig.md` Sec 4 already used for the fix-round-4
        evidence (3 components >=50px: the main silhouette plus two pre-existing,
        unrelated calf motion-streak fragments, baked into `calf_L.png`'s own
        source art, on the far/behind leg). This round's rename must not add a
        4th."""
        result = refpose.render()
        alpha_mask = np.asarray(result.native_frames[0])[:, :, 3] > 0
        labels, component_count = _label_connected_components(alpha_mask)
        sizes = [int(np.count_nonzero(labels == label)) for label in range(1, component_count + 1)]
        big_components = [s for s in sizes if s >= 50]
        assert len(big_components) <= 3, (
            f"{len(big_components)} components >=50px: {big_components}"
        )

    def test_draw_order_is_unaffected_by_the_geometry_change(self):
        """Re-verification per the card's own acceptance criterion: replay the
        paint loop (not the rig's z numbers) and confirm realized rank still
        matches the published order 10 of 10, with 0 contested pairs resolving
        against it."""
        placements = refpose.build_reference_placements()
        offset, canvas_size = canvas_geometry(placements)
        masks = part_alpha_masks(placements, canvas_size, offset)
        pairs = contested_pairs(placements, masks)
        violations = [p for p in pairs if p["resolves_against_z_order"]]
        assert len(pairs) > 0
        assert violations == []

    def test_shoulder_r_bone_length_is_unchanged_by_the_width_restore(self):
        """The anisotropic scale's HEIGHT component (the bone-length correction)
        is untouched by this round -- only width changed. Fix round 7 renamed the
        corrected part from `shoulder_L` to `shoulder_R`."""
        rig = rig_compositor.load_rig()
        parts = rig_compositor.load_parts()
        lengths = rig_compositor.measured_bone_lengths(parts, rig)
        assert lengths["shoulder_R"] == pytest.approx(lengths["shoulder_L"], abs=1.0)

    def test_shoulder_r_png_is_still_byte_identical(self):
        """No re-cut -- the fix lives entirely in the rig's scale/offset data.
        Fix round 7 renamed this file from `shoulder_L.png`, but did not touch
        its bytes. Fix round 10: the prior version of this test compared
        `shoulder_R.png` to itself, which passes unconditionally and proves
        nothing (flagged by reviewer FAIL 2026-10-09T19:10). This asserts
        against the actual pre-rename content instead -- the sha256 below is
        the develop-branch `shoulder_L.png` blob's digest (git blob
        `1a11d543ef848bbac72520ccbbc5eb360a6d1871`, confirmed via
        `git diff --raw develop...HEAD` to be the exact blob `shoulder_R.png`
        now carries), so a future change that starts mutating the PNG in
        place fails this test loudly."""
        raw = (rig_compositor.PARTS_DIR / "shoulder_R.png").read_bytes()
        pre_rename_shoulder_l_sha256 = (
            "eac455901485d36acc9729ec523f05d86e0374785aa68041edf6334c95d3cc39"
        )
        assert hashlib.sha256(raw).hexdigest() == pre_rename_shoulder_l_sha256


class TestLateralOffsetValue:
    """Fix round 6 moved the offsets to that round's far side (`_R`), magnitude
    unchanged from fix round 5 (0.10 arm / 0.06 leg), sign flipped since the far
    side then sat screen-right of the hip. Fix round 7 (2026-10-09T17:06) renamed
    all eight limb parts so the far side is `_L` again -- the SAME physical parts,
    SAME magnitude and sign, only the key moved. `_R` carries no entry now -- it
    is the near side again and defaults to 0.0."""

    def test_arm_chain_offset_is_point_one_zero_on_the_far_l_side(self):
        rig = rig_compositor.load_rig()
        values = rig["canonical_rig"]["lateral_offset_axis"]["demonstration_values"]
        assert values["shoulder_L"] == pytest.approx(0.10)
        assert values["forearm_L"] == pytest.approx(0.10)
        assert values["shoulder_L"] == values["forearm_L"], (
            "one offset per chain -- the two must still match each other"
        )
        assert "shoulder_R" not in values
        assert "forearm_R" not in values

    def test_leg_chain_offset_is_unchanged_in_magnitude_from_fix_round_2(self):
        """This round only moves WHICH side carries the leg-chain offset; its
        magnitude (0.06) and the reasoning for it are carried forward as-is."""
        rig = rig_compositor.load_rig()
        values = rig["canonical_rig"]["lateral_offset_axis"]["demonstration_values"]
        assert values["thigh_L"] == pytest.approx(0.06)
        assert values["calf_L"] == pytest.approx(0.06)
        assert "thigh_R" not in values
        assert "calf_R" not in values
