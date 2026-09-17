"""RED: re-cut an already-sampled walk attempt against T-0319's background
fix -- no new ComfyUI calls, no seed/denoise change.

Card scope: "Re-cut the existing attempts against the corrected background
before regenerating anything ... no new GPU spend until that is exhausted."
`reprocess_attempt_background_fix` reads an attempt's already-written
`frame_{i}_main_384.png` + `frame_{i}_keypoints.json` from `out_dir` (any
directory -- not necessarily this repo's own gitignored `assets/out/`, so the
same function can be pointed at the preserved attempt 5/7 directories that
survived their own worktree's removal), applies
`force_border_background_to_fill` to each frame's own detected background
before re-running the SAME per-frame cutout
(`cutout_foreground_mask`/`CUTOUT_OKLAB_TOLERANCE`/`BACKGROUND_MASK_MARGIN_FRAC`)
every fresh generation already uses, and reports each cell's background
fraction both as originally sampled ('before') and after the fix ('after')
against `MIN_BACKGROUND_FRACTION` (mirrors
`test_player_walk_hybrid_T0259_gate.py`'s own 0.65 floor) -- so whether the
fix alone clears an already-generated attempt's cells is a measured fact.

No GPU/ComfyUI needed: purely a re-derivation of already-sampled pixels on
disk, same pattern as `gen_chained_idle_T0250.reprocess_attempt_cutout`.

RED: `gen_hybrid_walk_T0259` has no `reprocess_attempt_background_fix` and no
`MIN_BACKGROUND_FRACTION`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_hybrid_walk_T0259 as walk  # noqa: E402

# Stand-in for the real 384px generation size -- the function under test is
# size-agnostic (it downscales to FINAL_CELL_PX regardless of input size), so
# a smaller synthetic frame keeps the test fast.
FRAME_PX = 96
GREY_BACKGROUND = (144, 143, 145)  # T-0319's measured mid-grey, matches the real defect
FIGURE_RGB = (40, 120, 60)  # a mid-value green, plausibly close to grey in Oklab


def _write_attempt(out_dir: Path, background_rgb: tuple[int, int, int]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, (row, col) in enumerate(walk.FRAME_CELLS):
        arr = np.zeros((FRAME_PX, FRAME_PX, 3), dtype=np.uint8)
        arr[:, :] = background_rgb
        # A figure block roughly centered, sized/shaped like a real frame's
        # own keypoints bbox would produce.
        x0, y0, x1, y1 = 30, 20, 66, 80
        arr[y0:y1, x0:x1] = FIGURE_RGB
        Image.fromarray(arr, mode="RGB").save(out_dir / f"frame_{i}_main_384.png")

        points = [
            {"joint": 0, "x": x0 / FRAME_PX, "y": y0 / FRAME_PX},
            {"joint": 1, "x": (x1 - 1) / FRAME_PX, "y": (y1 - 1) / FRAME_PX},
        ]
        (out_dir / f"frame_{i}_keypoints.json").write_text(json.dumps(points))


@pytest.fixture
def grey_attempt_dir(tmp_path: Path) -> Path:
    out_dir = tmp_path / "attempt_grey"
    _write_attempt(out_dir, GREY_BACKGROUND)
    return out_dir


def test_report_has_before_and_after_for_every_cell(grey_attempt_dir: Path) -> None:
    report = walk.reprocess_attempt_background_fix(grey_attempt_dir)

    assert set(report["before"]) == {f"{r}_{c}" for r, c in walk.FRAME_CELLS}
    assert set(report["after"]) == {f"{r}_{c}" for r, c in walk.FRAME_CELLS}
    assert report["min_background_fraction"] == walk.MIN_BACKGROUND_FRACTION


def test_min_background_fraction_matches_gate_floor() -> None:
    """Mirrors test_player_walk_hybrid_T0259_gate.py's MIN_BACKGROUND_FRACTION
    literal (0.65) -- the re-cut report is only meaningful graded against the
    same bar the real gate uses."""
    assert walk.MIN_BACKGROUND_FRACTION == 0.65


def test_fix_never_regresses_background_fraction(grey_attempt_dir: Path) -> None:
    report = walk.reprocess_attempt_background_fix(grey_attempt_dir)

    for cell in report["before"]:
        assert report["after"][cell] >= report["before"][cell] - 1e-9, (
            f"cell {cell}: fix regressed background fraction "
            f"({report['before'][cell]:.4f} -> {report['after'][cell]:.4f})"
        )


def test_writes_before_and_after_sheets(grey_attempt_dir: Path) -> None:
    walk.reprocess_attempt_background_fix(grey_attempt_dir)

    assert (grey_attempt_dir / "sheet_192x96_indexed_before_T0319.png").is_file()
    assert (grey_attempt_dir / "sheet_192x96_indexed_after_T0319.png").is_file()


def test_pass_fail_reported_against_the_gate_floor(grey_attempt_dir: Path) -> None:
    report = walk.reprocess_attempt_background_fix(grey_attempt_dir)

    for cell, frac in report["before"].items():
        assert report["before_passes"][cell] == (frac >= walk.MIN_BACKGROUND_FRACTION)
    for cell, frac in report["after"].items():
        assert report["after_passes"][cell] == (frac >= walk.MIN_BACKGROUND_FRACTION)


def test_already_dark_background_attempt_is_left_materially_unchanged(tmp_path: Path) -> None:
    """The fix must not be a net negative on an attempt whose background was
    already fine -- before and after should agree closely when there was no
    grey-background defect to correct."""
    out_dir = tmp_path / "attempt_dark"
    _write_attempt(out_dir, (18, 17, 14))

    report = walk.reprocess_attempt_background_fix(out_dir)

    for cell in report["before"]:
        assert abs(report["after"][cell] - report["before"][cell]) < 0.02
