"""Provenance seam (T-0075 pattern, shared with comfy-client and sfx-synth).

`.claude/rules/conduct.md`: every generated asset needs an
`ASSET_PROVENANCE.md` entry (`model + license + prompt + seed`) before its
card can leave `in-progress` -- non-optional. Also carries the D-20
bus-assignment field (tasks/T-0082.md acceptance: "every generated audio
asset carries a bus-assignment field") so it travels with the output from
generation time, not bolted on after.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from gen_client_base.license_allowlist import assert_checkpoint_allowed

from audio_agent.bus import Bus
from audio_agent.recipe import MusicRecipe


@dataclass(frozen=True)
class ProvenanceRecord:
    model: str
    model_license: str
    model_hash: str | None
    prompt: str
    seed: int
    duration: float
    infer_step: int
    bus: Bus
    request_hash: str
    job_id: str


def build_provenance_record(
    recipe: MusicRecipe, request_hash: str, job_id: str
) -> ProvenanceRecord:
    # Re-derives the license rather than trusting the caller ran the check --
    # cheap, and it means this function alone is safe to call from anywhere.
    entry = assert_checkpoint_allowed(recipe.checkpoint)
    return ProvenanceRecord(
        model=recipe.checkpoint,
        model_license=entry.license,
        model_hash=recipe.model_hash,
        prompt=recipe.prompt,
        seed=recipe.seed,
        duration=recipe.duration,
        infer_step=recipe.infer_step,
        bus=recipe.bus,
        request_hash=request_hash,
        job_id=job_id,
    )


def provenance_to_dict(record: ProvenanceRecord) -> dict:
    d = asdict(record)
    d["bus"] = record.bus.value
    return d
