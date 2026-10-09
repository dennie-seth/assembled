"""T-0436 fix round 4: `char_gen.draw_order_audit_T0436` replays the real paint
loop (same sort `rig_compositor.render_frames` uses) to confirm which part
actually wins each contested pixel, rather than reading the z numbers back out of
the rig JSON and asserting the order from them alone.

`TestSyntheticGeometry` proves the mechanics against two plain opaque squares
whose overlap and expected winner are known by construction. `TestAgainstTheRig`
re-runs the same check against the real committed rig, posed to the reference
(`reference_pose_T0436.build_reference_placements`) -- this is the re-run the card
requires AFTER the per-side arm angle fix lands, since the arms now actually
overlap the torso/legs instead of hanging in a rest pose beside them.
"""
from __future__ import annotations

from PIL import Image

from char_gen import reference_pose_T0436 as refpose
from char_gen.draw_order_audit_T0436 import (
    canvas_geometry,
    contested_pairs,
    part_alpha_masks,
    realized_draw_rank,
    realized_owner,
)
from char_gen.rig_compositor import Placement


def _solid_placement(
    name: str, z: int, size: tuple[int, int], target_xy: tuple[float, float],
) -> Placement:
    img = Image.new("RGBA", size, (255, 255, 255, 255))
    return Placement(name=name, image=img, pivot_px=(0.0, 0.0), target_xy=target_xy, z=z)


class TestSyntheticGeometry:
    """Two 10x10 opaque squares, `a` (z=1) at x=0 and `b` (z=0, drawn LAST and
    therefore on top) at x=5 -- a known 5x10=50px overlap with a known winner."""

    @staticmethod
    def _placements() -> list[Placement]:
        return [
            _solid_placement("a", z=1, size=(10, 10), target_xy=(0.0, 0.0)),
            _solid_placement("b", z=0, size=(10, 10), target_xy=(5.0, 0.0)),
        ]

    def test_part_alpha_masks_places_each_part_at_its_own_position(self):
        masks = part_alpha_masks(self._placements(), canvas_size=(15, 10), offset=(0.0, 0.0))
        assert masks["a"][:, 0:5].min() == 255
        assert masks["a"][:, 10:15].max() == 0
        assert masks["b"][:, 10:15].min() == 255
        assert masks["b"][:, 0:5].max() == 0

    def test_realized_owner_gives_the_overlap_to_the_lower_z_part(self):
        placements = self._placements()
        masks = part_alpha_masks(placements, canvas_size=(15, 10), offset=(0.0, 0.0))
        owner = realized_owner(placements, masks)
        assert set(owner[:, 5:10].ravel().tolist()) == {"b"}, "b (z=0) draws last, wins the overlap"
        assert set(owner[:, 0:5].ravel().tolist()) == {"a"}
        assert set(owner[:, 10:15].ravel().tolist()) == {"b"}

    def test_realized_draw_rank_puts_the_lowest_z_last(self):
        ranks = realized_draw_rank(self._placements())
        assert ranks["a"] == 1, "higher z (1) paints first -- backmost"
        assert ranks["b"] == 2, "lower z (0) paints last -- frontmost"

    def test_contested_pairs_reports_the_known_overlap_and_agrees_with_z_order(self):
        placements = self._placements()
        masks = part_alpha_masks(placements, canvas_size=(15, 10), offset=(0.0, 0.0))
        pairs = contested_pairs(placements, masks)
        assert len(pairs) == 1
        pair = pairs[0]
        assert pair["lower_z_part"] == "b"
        assert pair["higher_z_part"] == "a"
        assert pair["contested_px"] == 50
        assert pair["lower_z_wins"] == 50
        assert pair["higher_z_wins"] == 0
        assert pair["resolves_against_z_order"] is False

    def test_non_overlapping_parts_are_not_reported(self):
        placements = [
            _solid_placement("a", z=1, size=(5, 5), target_xy=(0.0, 0.0)),
            _solid_placement("b", z=0, size=(5, 5), target_xy=(20.0, 0.0)),
        ]
        masks = part_alpha_masks(placements, canvas_size=(30, 5), offset=(0.0, 0.0))
        assert contested_pairs(placements, masks) == []

    def test_sub_threshold_alpha_does_not_count_as_a_contested_pixel(self):
        faint = Image.new("RGBA", (10, 10), (255, 255, 255, 40))  # below OPAQUE_THRESHOLD
        placements = [
            _solid_placement("a", z=1, size=(10, 10), target_xy=(0.0, 0.0)),
            Placement(name="b", image=faint, pivot_px=(0.0, 0.0), target_xy=(5.0, 0.0), z=0),
        ]
        masks = part_alpha_masks(placements, canvas_size=(15, 10), offset=(0.0, 0.0))
        assert contested_pairs(placements, masks) == []


class TestAgainstTheRig:
    """Re-run against the real committed rig, posed to the reference with this
    round's per-side arm angles -- the z values themselves must not change
    (asserted in `tests/test_canonical_rig_T0436.py`); this class instead confirms
    the REALIZED paint order still matches them now that the arms actually move
    into contested territory."""

    @staticmethod
    def _placements() -> list[Placement]:
        return refpose.build_reference_placements()

    def test_realized_draw_rank_matches_the_published_z_order(self):
        placements = self._placements()
        ranks = realized_draw_rank(placements)
        z_of = {p.name: p.z for p in placements}
        # Rank must be a strictly decreasing function of z (rank 10 = z 0 = frontmost).
        for name, rank in ranks.items():
            assert rank == 10 - z_of[name]

    def test_no_contested_pair_resolves_against_the_published_z_order(self):
        placements = self._placements()
        offset, canvas_size = canvas_geometry(placements)
        masks = part_alpha_masks(placements, canvas_size, offset)
        pairs = contested_pairs(placements, masks)
        violations = [p for p in pairs if p["resolves_against_z_order"]]
        assert violations == [], f"{len(violations)} of {len(pairs)} pairs disagree: {violations}"

    def test_near_arm_contests_and_wins_against_the_torso(self):
        """Fix round 6's Option B layering (`_L` drawn in front -- the near
        side now) puts `shoulder_L` ahead of `torso` in the paint order; this
        confirms that order holds on a pair that actually overlaps in this pose
        (the posed arms genuinely cross the torso silhouette), not just by
        reading z numbers. Per-side arm ANGLES did not swap with the layering --
        `shoulder_L` still poses at `SHOULDER_DEG_L` (-56.4deg, trailing back)
        -- only which side draws in front changed."""
        placements = self._placements()
        offset, canvas_size = canvas_geometry(placements)
        masks = part_alpha_masks(placements, canvas_size, offset)
        pairs = {
            frozenset((p["lower_z_part"], p["higher_z_part"])): p
            for p in contested_pairs(placements, masks)
        }
        pair = pairs[frozenset(("shoulder_L", "torso"))]
        assert pair["contested_px"] > 0
        assert pair["lower_z_part"] == "shoulder_L"
        assert pair["higher_z_wins"] == 0
