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

RED state: any generator source under this directory contains the literal
`(0.072, 0.112)` -> the grep below finds it, the test fails.
"""

from __future__ import annotations

import re
from pathlib import Path

_CHARACTER_DIR = Path(__file__).resolve().parents[1]

# Deliberately tolerant of whitespace variation (e.g. "(0.072,0.112)") -- the
# defect this guards against is the *value* being restated, not one specific
# formatting of it.
_ARM_C_BENCHMARK_LITERAL_RE = re.compile(r"\(\s*0\.072\s*,\s*0\.112\s*\)")

# The one place the pair is allowed to be spelled out as a literal: the
# shared constant's own definition. Everything else must import it.
_ALLOWED_DEFINITION_FILE = (
    Path(__file__).resolve().parents[4]
    / "tools"
    / "comfy-client"
    / "src"
    / "comfy_client"
    / "provenance_sidecar.py"
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


def test_no_arm_c_benchmark_literal_anywhere_under_assets_src_character():
    """Broader than the flat *.py glob above -- also covers src/char_gen/**
    and any future subpackage, so a literal cannot hide one directory down."""
    offenders = []
    for path in _CHARACTER_DIR.rglob("*.py"):
        if path.resolve() == _ALLOWED_DEFINITION_FILE.resolve():
            continue
        if _ARM_C_BENCHMARK_LITERAL_RE.search(path.read_text()):
            offenders.append(str(path.relative_to(_CHARACTER_DIR)))
    assert not offenders, (
        f"ARM_C_BENCHMARK literal (0.072, 0.112) copy-pasted in {offenders} -- import "
        "ARM_C_BENCHMARK from comfy_client.provenance_sidecar instead (CHR-1, T-0258)"
    )


def test_pose_authority_and_hybrid_generators_import_the_shared_constant():
    """Pins the fix, not just the absence of the literal -- a generator could
    otherwise satisfy the grep by defining the pair as e.g. `(0.0720, 0.1120)`
    while still never importing the shared constant."""
    for filename in ("gen_hybrid_idle_T0252.py", "gen_pose_authority_idle_T0249.py"):
        text = (_CHARACTER_DIR / filename).read_text()
        assert "from comfy_client.provenance_sidecar import" in text, (
            f"{filename} must import ARM_C_BENCHMARK from comfy_client.provenance_sidecar"
        )
        assert "ARM_C_BENCHMARK" in text


def test_chained_generator_still_reexports_pose_authoritys_constant():
    """gen_chained_idle_T0250.py never defined its own copy -- it re-exports
    gen_pose_authority_idle_T0249's. That must stay true rather than gaining
    its own separate import (a second source of truth CHR-1 also forbids)."""
    text = (_CHARACTER_DIR / "gen_chained_idle_T0250.py").read_text()
    assert "ARM_C_BENCHMARK = pose_authority.ARM_C_BENCHMARK" in text
