"""Chunked/resumable per-frame generation bookkeeping (T-0266, HANDOFF §24-e).

The single shared home for the resume + chunking logic every §24-e per-frame
generator (WALK `gen_hybrid_walk_T0259.py`, and HIDE/ACTION once they exist)
calls, so none of the three re-implements it (see this card's "shared, not
copy-pasted" acceptance criterion).

Why this module exists: `gen_hybrid_walk_T0259.py`'s per-frame loop generated
all 8 frames in a single `run_attempt` call with no way to stop and resume.
Measured per-frame cost from real ComfyUI history is ~100s/frame (95.2s,
100.4s, 118.0s), so an 8-frame sheet is ~14 minutes -- longer than a single
foreground shell call's 10-minute cap (600000ms). `run_in_background: true`
does not help: the implementer's own session ending tears down the
background child, orphaning ComfyUI mid-sheet with no resume logic to pick
it back up (T-0259, blocked at signature `3f1568f9...` twice for exactly
this reason).

This module is pure bookkeeping -- it has no ComfyUI/network dependency of
its own. Callers supply a `generate_frame(i)` callback that does the real
per-frame work (submit/poll/fetch/save) and a `required_names` template
naming that frame's *output* files; this module decides which frames are
already done, which are still pending, and how many to hand to the callback
in one call.

RED state: char_gen.chunked_frames does not exist -> every test ERRORs on
import.
GREEN state: skip-existing-frame resume (including the partial/corrupt
case -- inputs on disk but no outputs), a chunk bound derived from the
measured per-frame cost, and repeated `run_chunk` calls converging to a
complete sheet with no other change between calls.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from char_gen import chunked_frames


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x")


REQUIRED_NAMES = ["frame_{i}_main_384.png", "frame_{i}_cell_48_raw.png"]


# ---------------------------------------------------------------------------
# is_frame_complete / frames_needing_generation -- skip-existing resume
# ---------------------------------------------------------------------------


def test_frame_with_no_files_is_incomplete(tmp_path: Path) -> None:
    assert not chunked_frames.is_frame_complete(tmp_path, 0, REQUIRED_NAMES)


def test_frame_with_both_outputs_is_complete(tmp_path: Path) -> None:
    _touch(tmp_path / "frame_0_main_384.png")
    _touch(tmp_path / "frame_0_cell_48_raw.png")
    assert chunked_frames.is_frame_complete(tmp_path, 0, REQUIRED_NAMES)


def test_frame_with_only_inputs_written_is_incomplete(tmp_path: Path) -> None:
    """T-0259's exact orphaned case: frame_1_keypoints.json +
    frame_1_pose_skeleton_384.png (that frame's *inputs*) were written just
    before the session died, but neither output file landed. That frame
    must be re-generated, not skipped, even though something is on disk."""
    _touch(tmp_path / "frame_1_keypoints.json")
    _touch(tmp_path / "frame_1_pose_skeleton_384.png")
    assert not chunked_frames.is_frame_complete(tmp_path, 1, REQUIRED_NAMES)


def test_frame_with_only_one_output_is_incomplete(tmp_path: Path) -> None:
    _touch(tmp_path / "frame_2_main_384.png")
    assert not chunked_frames.is_frame_complete(tmp_path, 2, REQUIRED_NAMES)


def test_frames_needing_generation_skips_complete_ones(tmp_path: Path) -> None:
    _touch(tmp_path / "frame_0_main_384.png")
    _touch(tmp_path / "frame_0_cell_48_raw.png")
    _touch(tmp_path / "frame_2_main_384.png")
    _touch(tmp_path / "frame_2_cell_48_raw.png")
    pending = chunked_frames.frames_needing_generation(tmp_path, range(4), REQUIRED_NAMES)
    assert pending == [1, 3]


# ---------------------------------------------------------------------------
# default_max_frames -- bound justified against the measured per-frame cost
# ---------------------------------------------------------------------------


def test_default_max_frames_matches_measured_cost() -> None:
    """~100s/frame, 600s shell cap, 180s headroom for upload/cutout/polling
    overhead -> floor((600-180)/100) = 4, matching the card's own worked
    example ("a default bound of ~4 frames (~7 min) leaves real headroom")."""
    assert chunked_frames.default_max_frames(
        seconds_per_frame=100.0, shell_timeout_s=600.0, headroom_s=180.0
    ) == 4


def test_default_max_frames_uses_measured_constants_by_default() -> None:
    assert chunked_frames.DEFAULT_MAX_FRAMES == chunked_frames.default_max_frames()
    assert chunked_frames.DEFAULT_MAX_FRAMES >= 1


def test_default_max_frames_never_returns_less_than_one() -> None:
    assert chunked_frames.default_max_frames(
        seconds_per_frame=10_000.0, shell_timeout_s=600.0, headroom_s=180.0
    ) == 1


def test_default_max_frames_rejects_headroom_ge_timeout() -> None:
    with pytest.raises(ValueError):
        chunked_frames.default_max_frames(
            seconds_per_frame=100.0, shell_timeout_s=600.0, headroom_s=600.0
        )


# ---------------------------------------------------------------------------
# next_chunk
# ---------------------------------------------------------------------------


def test_next_chunk_caps_at_max_frames(tmp_path: Path) -> None:
    chunk = chunked_frames.next_chunk(tmp_path, range(8), REQUIRED_NAMES, max_frames=4)
    assert chunk == [0, 1, 2, 3]


def test_next_chunk_rejects_non_positive_max_frames(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        chunked_frames.next_chunk(tmp_path, range(8), REQUIRED_NAMES, max_frames=0)


# ---------------------------------------------------------------------------
# run_chunk -- the resumability contract: repeated calls converge
# ---------------------------------------------------------------------------


def _fake_generate(out_dir: Path) -> "list[int]":
    """Returns a callback recording every frame index it was asked to
    generate, and writes both required output files for that frame -- a
    stand-in for the real ComfyUI submit/poll/fetch/save, so this whole
    module is tested with no GPU."""
    calls: list[int] = []

    def generate_frame(i: int) -> None:
        calls.append(i)
        _touch(out_dir / f"frame_{i}_main_384.png")
        _touch(out_dir / f"frame_{i}_cell_48_raw.png")

    generate_frame.calls = calls  # type: ignore[attr-defined]
    return generate_frame


def test_run_chunk_generates_only_up_to_max_frames(tmp_path: Path) -> None:
    generate_frame = _fake_generate(tmp_path)
    result = chunked_frames.run_chunk(
        out_dir=tmp_path,
        frame_indices=range(8),
        required_names=REQUIRED_NAMES,
        max_frames=4,
        generate_frame=generate_frame,
    )
    assert generate_frame.calls == [0, 1, 2, 3]
    assert result.generated == [0, 1, 2, 3]
    assert result.skipped == []
    assert result.remaining == [4, 5, 6, 7]
    assert result.complete is False


def test_run_chunk_skips_already_complete_frames(tmp_path: Path) -> None:
    _touch(tmp_path / "frame_0_main_384.png")
    _touch(tmp_path / "frame_0_cell_48_raw.png")
    generate_frame = _fake_generate(tmp_path)
    result = chunked_frames.run_chunk(
        out_dir=tmp_path,
        frame_indices=range(4),
        required_names=REQUIRED_NAMES,
        max_frames=4,
        generate_frame=generate_frame,
    )
    assert generate_frame.calls == [1, 2, 3]
    assert result.skipped == [0]
    assert result.generated == [1, 2, 3]
    assert result.complete is True


def test_run_chunk_regenerates_partial_frame_not_skips_it(tmp_path: Path) -> None:
    """The exact T-0259 defect this card exists to fix: a frame with only
    its inputs on disk (keypoints/skeleton, not modelled by this generic
    module -- any file that is not in `required_names`) must be handed to
    `generate_frame` again, not treated as done."""
    _touch(tmp_path / "frame_1_keypoints.json")
    _touch(tmp_path / "frame_1_pose_skeleton_384.png")
    generate_frame = _fake_generate(tmp_path)
    result = chunked_frames.run_chunk(
        out_dir=tmp_path,
        frame_indices=range(2),
        required_names=REQUIRED_NAMES,
        max_frames=4,
        generate_frame=generate_frame,
    )
    assert 1 in generate_frame.calls
    assert result.complete is True


def test_repeated_invocations_drive_to_completion(tmp_path: Path) -> None:
    """Acceptance: calling it repeatedly with no other change finishes the
    sheet -- chunk 1 -> frames 0-3, chunk 2 -> frames 4-7, then done."""
    generate_frame = _fake_generate(tmp_path)

    chunk_1 = chunked_frames.run_chunk(
        out_dir=tmp_path,
        frame_indices=range(8),
        required_names=REQUIRED_NAMES,
        max_frames=4,
        generate_frame=generate_frame,
    )
    assert chunk_1.generated == [0, 1, 2, 3]
    assert chunk_1.complete is False

    # Same call, no other change -- must pick up exactly where it left off.
    chunk_2 = chunked_frames.run_chunk(
        out_dir=tmp_path,
        frame_indices=range(8),
        required_names=REQUIRED_NAMES,
        max_frames=4,
        generate_frame=generate_frame,
    )
    assert chunk_2.skipped == [0, 1, 2, 3]
    assert chunk_2.generated == [4, 5, 6, 7]
    assert chunk_2.complete is True
    assert generate_frame.calls == [0, 1, 2, 3, 4, 5, 6, 7]

    # A third call once everything is complete must be a no-op.
    chunk_3 = chunked_frames.run_chunk(
        out_dir=tmp_path,
        frame_indices=range(8),
        required_names=REQUIRED_NAMES,
        max_frames=4,
        generate_frame=generate_frame,
    )
    assert chunk_3.generated == []
    assert chunk_3.skipped == list(range(8))
    assert chunk_3.complete is True
    assert generate_frame.calls == [0, 1, 2, 3, 4, 5, 6, 7]
