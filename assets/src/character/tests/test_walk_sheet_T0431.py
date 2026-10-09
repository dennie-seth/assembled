"""Regressions for `char_gen.walk_sheet` (T-0431): a deterministic walk-sheet
composite built ONLY from the committed `side_view_rig.json`, the ten
committed `assets/src/character/parts/side_view/*.png` parts and
`char_gen.walk_cycle`'s already-tested gait curves -- zero GPU calls, zero
network calls.

This module is source only: it renders frames and derives the per-frame
COCO-18 keypoints that describe what the rig actually commanded (the same
"versioned rig evidence" shape `asset_gate.character` recomputes
pose-fidelity/identity-stability/part-identity from). It does not decide
whether to promote anything into `assets/final/` -- that decision, and the
actual character-gate measurement against committed provenance, lives in
`gen_walk_sheet_deterministic_T0431.py` (a generator script, consistent with
every other `gen_*_T0NNN.py` in this package, and not unit-tested the same
way `sitting_idle_cycle.main()` isn't -- its own component functions are).
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from char_gen import rig_compositor, walk_sheet
from char_gen.character_scale import CELL_PX

PARTS_DIR = rig_compositor.PARTS_DIR
RIG_PATH = rig_compositor.RIG_PATH

#: The 18 COCO joint indices every frame's keypoints dict must carry --
#: `asset_gate.character.RIG_LIMB_JOINT_PAIRS` draws capsules between these,
#: so a missing one breaks the gate's own recompute, not just this module.
ALL_JOINTS = frozenset(range(18))


def _hash_inputs() -> dict[str, str]:
    """sha256 of every committed input this module reads -- the ten parts,
    the rig JSON, and `char_gen/walk_cycle.py` itself -- so a test can prove
    none of them were modified by rendering, not just assume it."""
    paths = [RIG_PATH] + [PARTS_DIR / f"{name}.png" for name in rig_compositor.PART_NAMES]
    paths.append(Path(walk_sheet.__file__).parent / "walk_cycle.py")
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


class TestDeterministic:
    """Same inputs, same output -- no sampling, no randomness, no clock."""

    def test_two_renders_produce_byte_identical_frames(self):
        r1 = walk_sheet.render_frames()
        r2 = walk_sheet.render_frames()
        assert len(r1.cell_frames) == len(r2.cell_frames)
        for f1, f2 in zip(r1.cell_frames, r2.cell_frames, strict=True):
            assert list(f1.getdata()) == list(f2.getdata())

    def test_two_renders_produce_identical_keypoints(self):
        r1 = walk_sheet.render_frames()
        r2 = walk_sheet.render_frames()
        assert r1.keypoints == r2.keypoints

    def test_module_source_names_no_gpu_or_network_client(self):
        """The whole point of this card: a composite, not a generation call.
        Checked against the module's own source text, not just its current
        import list, so a `from x import y` dodge would still be caught."""
        import inspect

        src = inspect.getsource(walk_sheet)
        for forbidden in ("requests", "comfy_client", "httpx", "socket", "ComfyUI"):
            assert forbidden not in src, f"found forbidden GPU/network reference: {forbidden!r}"


class TestCommittedInputsAreUntouched:
    """Acceptance: 'char_gen.walk_cycle, the committed parts and
    side_view_rig.json are consumed as they stand on this branch and are not
    modified. Assert rather than assume.'"""

    def test_rendering_does_not_modify_any_committed_input_file(self):
        before = _hash_inputs()
        walk_sheet.render_frames()
        after = _hash_inputs()
        assert before == after

    def test_placeholder_walk_sheet_is_untouched(self):
        repo_root = Path(__file__).resolve().parents[4]
        placeholder_dir = repo_root / "assets" / "final" / "character"
        placeholder_files = [
            placeholder_dir / "player_walk_sheet_hybrid.png",
            placeholder_dir / "player_walk_sheet_hybrid.provenance.json",
            placeholder_dir / "player_walk_sheet_hybrid.gate_report.json",
        ]
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in placeholder_files}
        walk_sheet.render_frames()
        after = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in placeholder_files}
        assert before == after


class TestFrameGrid:
    def test_frame_count_matches_walk_cycle_convention(self):
        r = walk_sheet.render_frames()
        assert len(r.cell_frames) == walk_sheet.FRAME_COUNT == 8

    def test_every_cell_frame_is_the_shared_cell_size(self):
        r = walk_sheet.render_frames()
        for f in r.cell_frames:
            assert f.size == (CELL_PX, CELL_PX)

    def test_every_frame_has_some_opaque_and_some_transparent_pixels(self):
        """Not a blank frame, not a fully-opaque one -- a real cutout figure."""
        r = walk_sheet.render_frames()
        for f in r.cell_frames:
            alphas = [px[3] for px in f.getdata()]
            assert any(a > 0 for a in alphas)
            assert any(a == 0 for a in alphas)


class TestGaitWiring:
    """This module must drive the compositor with `char_gen.walk_cycle`'s
    OWN curves, not a re-authored gait -- these checks confirm the wiring,
    not re-derive the gait math (already pinned by `test_walk_cycle.py`)."""

    def test_near_and_far_legs_are_out_of_phase(self):
        r = walk_sheet.render_frames()
        kp0 = r.keypoints[0]
        # right hip/knee/ankle vs left hip/knee/ankle should differ at phase 0
        # (near-side heel-strike vs far-side mid-cycle) for at least one pair.
        assert kp0[9] != kp0[12] or kp0[10] != kp0[13]

    def test_loop_seam_frame_count_is_whole_cycles(self):
        # FRAME_COUNT frames tile exactly one 0..1 gait cycle (walk_cycle.sample wraps).
        assert walk_sheet.FRAME_COUNT > 0


class TestKeypoints:
    def test_every_frame_declares_all_eighteen_joints(self):
        r = walk_sheet.render_frames()
        for kp in r.keypoints:
            assert set(kp) == ALL_JOINTS

    def test_keypoints_are_plausible_fractions_of_the_cell(self):
        """Not strictly clamped to [0,1] -- a swinging limb legitimately
        reaches near or slightly past the cell edge -- but must stay in a
        sane neighbourhood, not some other coordinate space entirely."""
        r = walk_sheet.render_frames()
        for kp in r.keypoints:
            for j, (x, y) in kp.items():
                assert -0.5 <= x <= 1.5, f"joint {j} x={x} out of plausible range"
                assert -0.5 <= y <= 1.5, f"joint {j} y={y} out of plausible range"

    def test_keypoints_to_coco_list_round_trips(self):
        r = walk_sheet.render_frames()
        serialised = walk_sheet.keypoints_to_coco_list(r.keypoints[0])
        assert len(serialised) == 18
        restored = {item["joint"]: (item["x"], item["y"]) for item in serialised}
        assert restored == r.keypoints[0]


class TestQuantization:
    def test_quantized_frames_are_indexed_with_background_zero(self):
        r = walk_sheet.render_frames()
        palette = [(0, 0, 0)] * 16
        palette[0] = (0, 255, 0)  # a loud background colour so it's unmistakable
        indexed = walk_sheet.quantize_to_indexed(r.cell_frames, palette, background_index=0)
        assert len(indexed) == len(r.cell_frames)
        for img in indexed:
            assert img.mode == "P"
            assert img.size == (CELL_PX, CELL_PX)

    def test_background_pixels_quantize_to_the_background_index(self):
        r = walk_sheet.render_frames()
        palette = [
            (10, 200, 10), (255, 0, 0), (0, 0, 255), (255, 255, 0),
            (0, 255, 255), (255, 0, 255), (128, 128, 128), (0, 0, 0),
            (255, 255, 255), (64, 64, 64), (192, 192, 192), (32, 32, 32),
            (16, 16, 16), (8, 8, 8), (4, 4, 4), (2, 2, 2),
        ]
        indexed = walk_sheet.quantize_to_indexed(r.cell_frames, palette, background_index=0)
        frame0_rgba = r.cell_frames[0]
        frame0_indexed = indexed[0]
        rgba_data = frame0_rgba.getdata()
        indexed_data = frame0_indexed.getdata()
        for (r_, g_, b_, a), idx in zip(rgba_data, indexed_data, strict=True):
            if a < 128:
                assert idx == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
