"""Chunked/resumable per-frame generation bookkeeping (T-0266, HANDOFF §24-e).

The single shared home for the resume + chunking logic every §24-e
per-frame generator calls — WALK (`gen_hybrid_walk_T0259.py`), and HIDE/
ACTION once they exist — so none of the three re-implements it.

**Why this exists.** `gen_hybrid_walk_T0259.py`'s per-frame loop generated
all 8 frames inside a single call with no way to stop and resume. Measured
per-frame cost from real ComfyUI history is ~100s/frame (95.2s, 100.4s,
118.0s across 5 real walk generations), so an 8-frame sheet is ~14 minutes
— longer than a single foreground shell call's 10-minute cap (600000ms).
`run_in_background: true` does not help: the implementer's own session
ending tears down the background child, orphaning the ComfyUI run mid-sheet
with nothing left to receive it and no resume logic to pick it back up
(T-0259, blocked at signature `3f1568f9...` twice for exactly this reason).

This module is pure bookkeeping with no ComfyUI/network dependency of its
own — a caller supplies a `generate_frame(i)` callback that does the real
per-frame work (submit/poll/fetch/save) and a `required_names` template
naming that frame's *output* files (e.g. `["frame_{i}_main_384.png",
"frame_{i}_cell_48_raw.png"]`); this module decides which frames are
already complete on disk, which are still pending, and how many to hand to
the callback in one call — safe to invoke repeatedly with no other change
until the sheet is complete.

**Skip-existing resume, not "any file present" resume.** A frame counts as
complete only when every one of its *output* files exists — never its
inputs. T-0259's own orphaned attempt left `frame_1_keypoints.json` and
`frame_1_pose_skeleton_384.png` (that frame's inputs, written just before
the session died) with no `frame_1_main_384.png`/`frame_1_cell_48_raw.png`
to show for it; a resume that skipped on "something is on disk" would skip
that frame forever. `required_names` is deliberately the caller's list of
*output* filenames only, so an input-only frame is indistinguishable from
an untouched one and is always re-handed to `generate_frame`.

**Runbook: sequential foreground chunks, never background-and-walk-away.**
Drive a sheet to completion by calling the owning script repeatedly with an
unchanged `--max-frames` (or equivalent) inside this same implementer
session, each call finishing well under the 10-minute shell cap, until the
returned `ChunkResult.complete` is True — then assemble/promote/commit. Do
**not** launch generation with `run_in_background: true` and end the turn;
that is precisely what orphaned T-0259.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

#: Measured wall-clock cost per real ComfyUI frame generation (T-0259
#: history: 95.2s, 100.4s, 118.0s across 5 real walk generations — see this
#: card's Context section). ~100s/frame is the conservative round figure
#: the default bound is derived from, not a guess.
MEASURED_SECONDS_PER_FRAME = 100.0

#: A single foreground shell call's hard cap (600000ms).
SHELL_TIMEOUT_SECONDS = 600.0

#: Time subtracted from the shell timeout before dividing by per-frame cost
#: — covers IP-Adapter upload, per-frame cutout/assembly, and HTTP polling
#: overhead beyond raw per-frame KSampler time, so a chunk finishes with
#: margin instead of flush against the wall.
CHUNK_HEADROOM_SECONDS = 180.0


def default_max_frames(
    seconds_per_frame: float = MEASURED_SECONDS_PER_FRAME,
    shell_timeout_s: float = SHELL_TIMEOUT_SECONDS,
    headroom_s: float = CHUNK_HEADROOM_SECONDS,
) -> int:
    """Largest frame count whose generation time fits under the shell
    timeout with headroom to spare — derived from the measured per-frame
    cost, not guessed. With the module defaults:
    floor((600 - 180) / 100) = 4, i.e. ~7 minutes of generation per chunk
    against a 10-minute cap.
    """
    budget = shell_timeout_s - headroom_s
    if budget <= 0:
        raise ValueError(
            f"headroom_s ({headroom_s}) must be smaller than shell_timeout_s ({shell_timeout_s})"
        )
    return max(int(budget // seconds_per_frame), 1)


#: The bound every §24-e generator defaults `--max-frames` to, unless a
#: caller overrides it (e.g. for a host with different measured latency).
DEFAULT_MAX_FRAMES = default_max_frames()


def _output_paths(out_dir: Path, frame_index: int, required_names: Sequence[str]) -> list[Path]:
    return [out_dir / name.format(i=frame_index) for name in required_names]


def is_frame_complete(out_dir: Path, frame_index: int, required_names: Sequence[str]) -> bool:
    """True only when every one of *frame_index*'s output files exists.

    Deliberately blind to any other file (pose skeletons, keypoints JSON,
    raw intermediate cells) — those are inputs or scratch, not evidence a
    frame finished. See the module docstring for why that distinction is
    the whole point.
    """
    return all(p.exists() for p in _output_paths(out_dir, frame_index, required_names))


def frames_needing_generation(
    out_dir: Path,
    frame_indices: Sequence[int],
    required_names: Sequence[str],
) -> list[int]:
    """*frame_indices*, in order, filtered down to the incomplete ones."""
    return [i for i in frame_indices if not is_frame_complete(out_dir, i, required_names)]


def next_chunk(
    out_dir: Path,
    frame_indices: Sequence[int],
    required_names: Sequence[str],
    max_frames: int,
) -> list[int]:
    """The next up-to-`max_frames` incomplete frame indices to generate."""
    if max_frames < 1:
        raise ValueError(f"max_frames must be >= 1, got {max_frames}")
    return frames_needing_generation(out_dir, frame_indices, required_names)[:max_frames]


@dataclass
class ChunkResult:
    """The outcome of one `run_chunk` call."""

    generated: list[int]
    skipped: list[int]
    remaining: list[int]

    @property
    def complete(self) -> bool:
        """True once no frame in the requested range is still incomplete."""
        return not self.remaining


def run_chunk(
    *,
    out_dir: Path,
    frame_indices: Sequence[int],
    required_names: Sequence[str],
    max_frames: int,
    generate_frame: Callable[[int], None],
) -> ChunkResult:
    """Generate up to `max_frames` incomplete frames, skipping any already
    complete, and report what is left.

    Safe to call repeatedly with no other change until `.complete` is
    True — that is the whole resumability contract: chunk 1 generates
    frames 0-3, chunk 2 (re-invoked with identical arguments) finds 0-3
    already complete on disk, skips them, and generates 4-7.

    `remaining`/`complete` are recomputed from disk *after* the callback
    runs rather than assumed from `generated` — a `generate_frame` that
    silently fails to produce one of its required outputs correctly shows
    up as still-remaining on the next call, instead of being lost.
    """
    if max_frames < 1:
        raise ValueError(f"max_frames must be >= 1, got {max_frames}")

    pending_before = frames_needing_generation(out_dir, frame_indices, required_names)
    skipped = [i for i in frame_indices if i not in pending_before]

    chunk = pending_before[:max_frames]
    for i in chunk:
        generate_frame(i)

    remaining = frames_needing_generation(out_dir, frame_indices, required_names)
    generated = [i for i in chunk if i not in remaining]

    return ChunkResult(generated=generated, skipped=skipped, remaining=remaining)
