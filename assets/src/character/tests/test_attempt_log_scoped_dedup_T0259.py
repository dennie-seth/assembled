"""RED: `append_attempt_log`'s dedup-and-replace is file-wide, not scoped to
its own table.

Discovered live on 2026-09-08 (session 4): the committed
`ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md` has a SECOND table further down (the
STRIDE/KNEE/ARM/CROSS calibration sweep) whose first column is also headed
"Attempt" and also contains bare numerals like "5" and "6". Re-running a
real attempt under a reused slot number (e.g. `--attempt 5`) called
`append_attempt_log`, which deletes ANY line in the WHOLE FILE whose second
pipe-delimited field equals the attempt number as plain text -- silently
destroying rows in the calibration table (a completely different table,
with different column semantics) that happen to share the same leading
numeral, in addition to the intended main-table row it meant to replace.
This is the exact "documentation regression" class of bug two prior
sessions (93dc1f5, then a later session) hand-repaired without ever fixing
the function itself -- it recurred immediately the next time a real
attempt reused a numbered slot.

GREEN state: the dedup-and-replace only touches the contiguous block of
`|`-prefixed lines that immediately follows THIS function's own header row
(matched by its exact text, not just "starts with `|` and column 2 matches"
anywhere in the document). Every other table, and all prose, is left
byte-for-byte untouched regardless of what numerals its rows start with.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gen_hybrid_walk_T0259 as walk  # noqa: E402

# Reuses the real header/separator text verbatim, rather than a hand-typed
# copy, so this fixture can never silently drift from what the function
# under test actually searches for.
_MAIN_HEADER_ROW, _MAIN_SEPARATOR_ROW = walk.ATTEMPT_LOG_HEADER.splitlines(keepends=True)[-2:]

FIXTURE = (
    "# Hybrid walk-cycle attempt log (T-0259, HANDOFF §24-e)\n\n"
    "Some prose.\n\n"
    f"{_MAIN_HEADER_ROW}{_MAIN_SEPARATOR_ROW}"
    "| 5 | 11111 | 0.10-0.20 | FAIL | no | 100.0 | no | historical attempt 5, main table |\n"
    "| 6 | 22222 | 0.10-0.20 | FAIL | no | 100.0 | no | historical attempt 6, main table |\n"
    "\n"
    "Some more prose between the two tables.\n\n"
    "| Attempt | STRIDE / KNEE / ARM / CROSS | Denoise | Frame-delta range | Pairs over 0.30 |\n"
    "|---|---|---|---|---|\n"
    "| 5 | 0.30 / 0.18 / 0.20 / 0.14 | 0.45 | 0.328-0.473 | 8/8 |\n"
    "| 6 | 0.22 / 0.13 / 0.15 / 0.05 | 0.45 | 0.212-0.375 | 6/8 |\n"
    "\n"
    "Trailing prose that must survive untouched.\n"
)


@pytest.fixture
def log_path(tmp_path, monkeypatch):
    path = tmp_path / "ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md"
    path.write_text(FIXTURE)
    monkeypatch.setattr(walk, "ATTEMPT_LOG_PATH", path)
    return path


def _provenance(attempt: int, seed: int) -> dict:
    return {
        "attempt": attempt,
        "seed": seed,
        "frame_delta_range": [0.15, 0.25],
        "mechanical_gate_passed": True,
        "beats_arm_c_benchmark": False,
        "gpu_seconds": 200.0,
        "promoted": False,
    }


def test_reusing_attempt_5_does_not_delete_the_calibration_table_row(log_path):
    walk.append_attempt_log(_provenance(5, 33333), notes="reused slot 5, session 4")
    text = log_path.read_text()
    assert "0.30 / 0.18 / 0.20 / 0.14" in text, (
        "the calibration table's own attempt-5 row must survive -- it is a different table"
    )
    assert "0.212-0.375" in text, "the calibration table's attempt-6 row must be untouched too"


def test_reusing_attempt_5_does_not_delete_attempt_6s_main_table_row(log_path):
    """Only the row for the attempt actually being replaced (5) may be
    removed from the main table -- attempt 6's own main-table row must
    survive untouched."""
    walk.append_attempt_log(_provenance(5, 33333), notes="reused slot 5, session 4")
    text = log_path.read_text()
    assert "| 6 | 22222 | 0.10-0.20 | FAIL | no | 100.0 | no |" in text


def test_reusing_attempt_5_replaces_only_its_own_main_table_row(log_path):
    walk.append_attempt_log(_provenance(5, 33333), notes="reused slot 5, session 4")
    text = log_path.read_text()
    assert "historical attempt 5, main table" not in text
    assert "reused slot 5, session 4" in text


def test_trailing_and_leading_prose_survive_byte_for_byte(log_path):
    walk.append_attempt_log(_provenance(5, 33333), notes="x")
    text = log_path.read_text()
    assert "Trailing prose that must survive untouched." in text
    assert "Some more prose between the two tables." in text
