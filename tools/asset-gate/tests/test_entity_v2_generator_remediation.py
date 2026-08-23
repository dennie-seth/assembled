"""T-0222: Entity-v2 provenance generator remediation tests.

Verifies that each of the 9 T-0214 entity-v2 sidecars under
``assets/final/entity/`` has a ``generator`` field that is:
  1. exactly the bare resolvable path ``assets/src/character/gen_entities_v2.js``
     (no free-text annotation suffix like `` (curl-only pipeline, T-0214)``), and
  2. resolves to an existing committed file in the repo tree (P-7
     generator-resolvability gate, HANDOFF §22-c).

These tests are RED before the provenance correction (the bad generator value is
``"assets/src/character/gen_entities_v2.js (curl-only pipeline, T-0214)"``),
and GREEN afterwards.  The model_hash, seed, prompt, and all other fields must
remain unchanged -- this verifies only the generator field.

Also verifies the P-7 sweep on the entity/ subtree passes once the correction
is applied (all 9 resolve; no baseline exemptions needed for v2 sheets).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from asset_gate.generator import (
    check_provenance_generator_resolvable,
    sweep_provenance_generator_resolvable,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parent.parent.parent.parent  # tools/asset-gate/tests → repo root
_ASSETS_FINAL_ENTITY = _REPO_ROOT / "assets" / "final" / "entity"
_EXPECTED_GENERATOR = "assets/src/character/gen_entities_v2.js"

_V2_SIDECARS = [
    "sound_idle_sheet_v2.provenance.json",
    "sound_move_sheet_v2.provenance.json",
    "sound_trapped_sheet_v2.provenance.json",
    "still_air_idle_sheet_v2.provenance.json",
    "still_air_move_sheet_v2.provenance.json",
    "still_air_trapped_sheet_v2.provenance.json",
    "watcher_idle_sheet_v2.provenance.json",
    "watcher_move_sheet_v2.provenance.json",
    "watcher_trapped_sheet_v2.provenance.json",
]

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


@pytest.fixture(params=_V2_SIDECARS)
def v2_sidecar(request):
    """Parametrized fixture -- yields (name, dict) for each of the 9 v2 sidecars."""
    name = request.param
    path = _ASSETS_FINAL_ENTITY / name
    assert path.exists(), f"Missing sidecar: {path}"
    return name, json.loads(path.read_text())


# ---------------------------------------------------------------------------
# P-7: generator field is the bare resolvable path (no free-text suffix)
# ---------------------------------------------------------------------------


def test_generator_field_is_bare_path_with_no_suffix(v2_sidecar):
    """Generator must be the bare repo-relative path, no parenthetical annotation."""
    _name, prov = v2_sidecar
    assert prov.get("generator") == _EXPECTED_GENERATOR, (
        f"Expected generator = {_EXPECTED_GENERATOR!r}, "
        f"got {prov.get('generator')!r}. "
        "Strip the free-text suffix from the provenance sidecar."
    )


def test_generator_resolves_to_existing_file(v2_sidecar):
    """P-7: check_provenance_generator_resolvable must pass for each sidecar."""
    _name, prov = v2_sidecar
    result = check_provenance_generator_resolvable(prov, repo_root=_REPO_ROOT)
    assert result.passed, (
        f"P-7 gate failed for {_name}: {result.reason}"
    )


# ---------------------------------------------------------------------------
# No other provenance fields changed (guard against unintended edits)
# ---------------------------------------------------------------------------

_UNCHANGED_FIELDS = [
    "model",
    "model_hash",
    "lora_hash",
    "seed",
    "steps",
    "cfg",
    "sampler",
    "scheduler",
    "denoise",
    "concept_hash",
    "card",
]

_EXPECTED_MODEL_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
_EXPECTED_LORA_HASH = "2dab82287f6d36a98a142dae5199df47e001d86d4c9507a0524742b4d34f2b9f"
_EXPECTED_CONCEPT_HASH = "77b03788aef9533d5b5c36d9df2583d234ef23e455efc509bf5bab50ec1244ce"


def test_model_hash_unchanged(v2_sidecar):
    """model_hash must be the SDXL base hash -- not changed by this remediation."""
    _name, prov = v2_sidecar
    assert prov.get("model_hash") == _EXPECTED_MODEL_HASH


def test_lora_hash_unchanged(v2_sidecar):
    """lora_hash must be the Soviet-brutalism LoRA hash -- not changed."""
    _name, prov = v2_sidecar
    assert prov.get("lora_hash") == _EXPECTED_LORA_HASH


def test_concept_hash_unchanged(v2_sidecar):
    """concept_hash must be the entities concept sheet hash -- not changed."""
    _name, prov = v2_sidecar
    assert prov.get("concept_hash") == _EXPECTED_CONCEPT_HASH


def test_card_field_is_T_0214(v2_sidecar):
    """card field must remain T-0214 (the originating card)."""
    _name, prov = v2_sidecar
    assert prov.get("card") == "T-0214"


# ---------------------------------------------------------------------------
# P-7 sweep: all 9 v2 sidecars must pass without baseline exemption
# ---------------------------------------------------------------------------


def test_p7_sweep_all_v2_entity_sidecars_pass():
    """P-7 generator-resolvability sweep on assets/final/entity/ passes all 9 v2 sidecars.

    No baseline exemption for v2 sheets -- they must pass outright (unlike v1
    sheets which lack a generator field entirely and are legitimately baseline-exempt).
    """
    results = sweep_provenance_generator_resolvable(
        _ASSETS_FINAL_ENTITY, repo_root=_REPO_ROOT
    )

    v2_results = [r for r in results if "_v2.provenance.json" in r.details.get("path", "")]
    assert len(v2_results) == 9, f"Expected 9 v2 results, got {len(v2_results)}"

    failing = [r for r in v2_results if not r.passed]
    assert not failing, (
        f"P-7 sweep: {len(failing)} v2 sidecar(s) still failing:\n"
        + "\n".join(f"  {r.details.get('path')}: {r.reason}" for r in failing)
    )
