"""CHR-1 (T-0258): the Arm-C benchmark pair must be defined in exactly one
place -- `comfy_client.provenance_sidecar.ARM_C_BENCHMARK` -- and imported
everywhere else, never copy-pasted as a literal.

Before this card, `ARM_C_BENCHMARK = (0.072, 0.112)` was hardcoded
independently in `gen_hybrid_idle_T0252.py` and
`gen_pose_authority_idle_T0249.py` (`gen_chained_idle_T0250.py` re-exported
the latter). A grep-based test is what stops that regressing silently: a
future generator that copy-pastes the literal instead of importing the shared
constant fails CI here, rather than passing review on the strength of
producing the same numbers by coincidence.

This test lives in `tools/asset-gate/tests/` rather than alongside the
generators it greps (`assets/src/character/tests/`) because that package has
no CI job of its own -- `pytest -q` there never runs in any workflow, so a
grep test committed there would pass locally and merge silently uncontested.
`ci-asset-gate.yml`'s `lint-test` job already runs `pytest -q` against this
package on every PR touching `assets/**` (which includes
`assets/src/character/**`), so living here is what actually makes this a CI
gate rather than a local-only check.

RED state: any generator source under `assets/src/character/` contains the
literal `(0.072, 0.112)` -> the grep below finds it, the test fails.
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CHARACTER_DIR = _REPO_ROOT / "assets" / "src" / "character"

# Deliberately tolerant of whitespace variation (e.g. "(0.072,0.112)") -- the
# defect this guards against is the *value* being restated, not one specific
# formatting of it.
_ARM_C_BENCHMARK_LITERAL_RE = re.compile(r"\(\s*0\.072\s*,\s*0\.112\s*\)")

# The one place the pair is allowed to be spelled out as a literal: the
# shared constant's own definition. Everything else must import it.
_ALLOWED_DEFINITION_FILE = (
    _REPO_ROOT / "tools" / "comfy-client" / "src" / "comfy_client" / "provenance_sidecar.py"
)


def _character_source_files() -> list[Path]:
    return sorted(p for p in _CHARACTER_DIR.glob("*.py") if p.is_file())


def test_allowed_definition_file_exists():
    """Guards the test itself against a silently-wrong path -- if this
    fails, the exemption below is checking nothing."""
    assert _ALLOWED_DEFINITION_FILE.is_file()


def test_no_arm_c_benchmark_literal_in_any_character_generator_source():
    offenders = []
    for path in _character_source_files():
        if _ARM_C_BENCHMARK_LITERAL_RE.search(path.read_text()):
            offenders.append(path.name)
    assert not offenders, (
        f"ARM_C_BENCHMARK literal (0.072, 0.112) copy-pasted in {offenders} -- import "
        "ARM_C_BENCHMARK from comfy_client.provenance_sidecar instead (CHR-1, T-0258)"
    )


#: Test/doc files legitimately describe the historical literal in prose (see
#: this very file's own docstring above) -- the defect this guards against is
#: a *generator* restating the value as code, not documentation mentioning it.
_EXCLUDED_DIRS = frozenset({"tests"})


def test_no_arm_c_benchmark_literal_anywhere_under_assets_src_character():
    """Broader than the flat *.py glob above -- also covers src/char_gen/**
    and any future subpackage, so a literal cannot hide one directory down.
    Excludes tests/ (this file's own directory) -- prose describing the
    historical bug, like this module's docstring, is not the defect."""
    offenders = []
    for path in _CHARACTER_DIR.rglob("*.py"):
        rel = path.relative_to(_CHARACTER_DIR)
        if rel.parts[0] in _EXCLUDED_DIRS:
            continue
        if path.resolve() == _ALLOWED_DEFINITION_FILE.resolve():
            continue
        if _ARM_C_BENCHMARK_LITERAL_RE.search(path.read_text()):
            offenders.append(str(rel))
    assert not offenders, (
        f"ARM_C_BENCHMARK literal (0.072, 0.112) copy-pasted in {offenders} -- import "
        "ARM_C_BENCHMARK from comfy_client.provenance_sidecar instead (CHR-1, T-0258)"
    )


def test_pose_authority_and_hybrid_generators_import_the_shared_write_helper():
    """Pins the fix, not just the absence of the literal -- a generator could
    otherwise satisfy the grep by defining the pair as e.g. `(0.0720, 0.1120)`
    while still never importing the shared helper."""
    for filename in ("gen_hybrid_idle_T0252.py", "gen_pose_authority_idle_T0249.py"):
        text = (_CHARACTER_DIR / filename).read_text()
        assert "from comfy_client.provenance_sidecar import" in text, (
            f"{filename} must import apply_arm_c_benchmark_fields "
            "from comfy_client.provenance_sidecar"
        )
        assert "apply_arm_c_benchmark_fields" in text


def test_pose_authority_generator_imports_arm_c_benchmark_for_reexport():
    """gen_chained_idle_T0250.py re-exports ARM_C_BENCHMARK as
    `pose_authority.ARM_C_BENCHMARK` -- that only works if
    gen_pose_authority_idle_T0249.py itself imports the name."""
    text = (_CHARACTER_DIR / "gen_pose_authority_idle_T0249.py").read_text()
    assert "ARM_C_BENCHMARK" in text


def test_chained_generator_still_reexports_pose_authoritys_constant():
    """gen_chained_idle_T0250.py never defined its own copy -- it re-exports
    gen_pose_authority_idle_T0249's. That must stay true rather than gaining
    its own separate import (a second source of truth CHR-1 also forbids)."""
    text = (_CHARACTER_DIR / "gen_chained_idle_T0250.py").read_text()
    assert "ARM_C_BENCHMARK = pose_authority.ARM_C_BENCHMARK" in text
