"""Provenance seam (T-0075), audio side.

`.claude/rules/conduct.md`: every generated asset needs an
ASSET_PROVENANCE.md entry (model + license + prompt + seed) before its
card can leave in-progress. Mirrors `comfy_client.provenance`'s role for
the generative path, but a one-shot has no model and no license to
record -- P-1/P-3: the recipe (script + parameters + seed) *is* the
source, fully reproducible, no license question. `method` stands in for
"model" so a future shared ASSET_PROVENANCE.md writer can tell the two
provenance shapes apart without either one faking fields it doesn't have.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass

from sfx_synth.bus_targets import BUS_LOUDNESS_TARGETS
from sfx_synth.recipe import Recipe

METHOD_DETERMINISTIC_SYNTHESIS = "deterministic_synthesis"


@dataclass(frozen=True)
class ProvenanceRecord:
    name: str
    method: str
    seed: int
    bus: str
    sample_rate: int
    target_lufs: float
    tolerance_db: float
    layer_count: int
    sha256: str
    byte_length: int


def build_provenance_record(recipe: Recipe, encoded_bytes: bytes) -> ProvenanceRecord:
    target = BUS_LOUDNESS_TARGETS[recipe.bus]
    return ProvenanceRecord(
        name=recipe.name,
        method=METHOD_DETERMINISTIC_SYNTHESIS,
        seed=recipe.seed,
        bus=recipe.bus,
        sample_rate=recipe.sample_rate,
        target_lufs=target.target_lufs,
        tolerance_db=target.tolerance_db,
        layer_count=len(recipe.layers),
        sha256=hashlib.sha256(encoded_bytes).hexdigest(),
        byte_length=len(encoded_bytes),
    )


def provenance_to_dict(record: ProvenanceRecord) -> dict:
    return asdict(record)
