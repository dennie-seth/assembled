"""T-0363: conftest.py must never synthesize a missing shipped sheet.

Before this fix, `tests/conftest.py` ran module-level `_generate_*`/
`_ensure_*` calls (idle/move/crouch-hide/die, v1 and v2, plus all 9 entity
sheets and their v2 provenance sidecars) *and* a session-scoped autouse
fixture (`ensure_synth_sheets`) that repeated the same checks -- and on any
of those checks finding a shipped file absent, silently wrote a synthetic
placeholder straight into the real, committed `assets/final/character/**`
or `assets/final/entity/**` tree.

This is the exact false-provenance hazard T-0212/T-0217 already paid for: a
deleted or missing shipped sheet gets silently replaced by a procedural
stand-in on any test run, and a later `git add -A` can commit it as if it
were real. Every one of those files is already committed to git today, so
in a clean checkout this landmine never fires -- but it is still armed,
and every `*_gate.py` test module already has its own clear
`assert SHEET_PATH.exists(), "..."` fixture (see e.g.
`test_player_idle_gate.py::sheet`) that conftest.py's auto-generation was
silently pre-empting.

This test proves the landmine is disarmed by actually running the gate
suite, as a subprocess, against a temporary copy of the repo layout with
the idle sheet deliberately absent, and asserting both:
  (a) the run fails loudly with the gate fixture's own missing-file message
      (not a silent/clean pass), and
  (b) conftest.py does not write anything into the temp tree's
      `assets/final/character/` as a side effect of running the suite.

RED (pre-fix conftest.py): the missing-sheet run below passes cleanly even
with `player_idle_sheet_v1.png` absent, *and* leaves a newly synthesized
PNG on disk at that path -- both wrong, both asserted against here.
GREEN (post-fix conftest.py): the missing-sheet run fails with
"idle sheet not found" and the path stays absent throughout.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]
_CHAR_TESTS_DIR = Path(__file__).resolve().parent
_CHAR_SRC_DIR = _CHAR_TESTS_DIR.parent / "src"
_ASSET_GATE_SRC = _REPO_ROOT / "tools" / "asset-gate" / "src"
_PALETTE_SRC = _REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
_REAL_IDLE_SHEET = _REPO_ROOT / "assets" / "final" / "character" / "player_idle_sheet_v1.png"


def _build_temp_repo(tmp_path: Path, *, include_idle_sheet: bool) -> Path:
    """Mirror just enough of the repo layout under `tmp_path` for
    `conftest.py`'s `parents[4]`-based `_REPO_ROOT` resolution
    (`assets/src/character/tests/conftest.py` -> repo root) to hold, with a
    fresh copy of the tests dir plus the one gate test this check exercises.
    """
    root = tmp_path / "repo"
    tests_dst = root / "assets" / "src" / "character" / "tests"
    tests_dst.mkdir(parents=True)
    shutil.copy2(_CHAR_TESTS_DIR / "conftest.py", tests_dst / "conftest.py")
    shutil.copy2(_CHAR_TESTS_DIR / "__init__.py", tests_dst / "__init__.py")
    shutil.copy2(
        _CHAR_TESTS_DIR / "test_player_idle_gate.py",
        tests_dst / "test_player_idle_gate.py",
    )

    # char_gen's own src/ and tools/asset-gate's src/ -- conftest.py
    # sys.path-injects both relative to its own _REPO_ROOT, so both need to
    # exist at the matching relative location under the temp root for the
    # copied test module's `pytest.importorskip("asset_gate...")` calls to
    # actually resolve (rather than silently skip).
    shutil.copytree(_CHAR_SRC_DIR, root / "assets" / "src" / "character" / "src")
    shutil.copytree(_ASSET_GATE_SRC, root / "tools" / "asset-gate" / "src")

    pal_dst = root / "assets" / "final" / "palette"
    pal_dst.mkdir(parents=True)
    shutil.copy2(_PALETTE_SRC, pal_dst / "home_palette.json")

    char_out = root / "assets" / "final" / "character"
    char_out.mkdir(parents=True)
    if include_idle_sheet:
        shutil.copy2(_REAL_IDLE_SHEET, char_out / "player_idle_sheet_v1.png")

    return root


def _run_pytest_in(root: Path) -> subprocess.CompletedProcess[str]:
    test_file = root / "assets" / "src" / "character" / "tests" / "test_player_idle_gate.py"
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", str(test_file)],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_missing_sheet_fails_loudly_and_writes_nothing(tmp_path: Path) -> None:
    """With `player_idle_sheet_v1.png` absent, the gate suite must fail with
    a clear message -- and conftest.py must never materialize a
    replacement."""
    root = _build_temp_repo(tmp_path, include_idle_sheet=False)
    sheet_path = root / "assets" / "final" / "character" / "player_idle_sheet_v1.png"
    assert not sheet_path.exists()

    result = _run_pytest_in(root)

    assert result.returncode != 0, (
        "expected the gate suite to fail with the idle sheet absent, got a "
        f"clean pass (returncode 0). stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    combined = result.stdout + result.stderr
    assert "idle sheet not found" in combined, (
        f"expected the SHEET_PATH fixture's own missing-file message, got:\n{combined}"
    )
    assert not sheet_path.exists(), (
        "conftest.py silently synthesized a replacement sheet at "
        f"{sheet_path} while running the suite -- this is exactly the "
        "false-provenance hazard this test guards against"
    )
    leftovers = list(char_dir.name for char_dir in sheet_path.parent.iterdir())
    assert leftovers == [], (
        "conftest.py wrote into assets/final/character as a side effect of "
        f"running the test suite: {leftovers}"
    )


def test_present_sheet_still_passes(tmp_path: Path) -> None:
    """Sanity check: with the real shipped sheet present, the same suite
    still passes -- this fix only stops conftest.py from *faking* a missing
    file, it doesn't touch the gate checks themselves."""
    root = _build_temp_repo(tmp_path, include_idle_sheet=True)

    result = _run_pytest_in(root)

    assert result.returncode == 0, (
        f"expected a clean pass with the real sheet present, got:\n"
        f"{result.stdout}\n{result.stderr}"
    )
