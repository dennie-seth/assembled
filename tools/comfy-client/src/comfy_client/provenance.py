"""Provenance seam (T-0075).

`.claude/rules/conduct.md`: every generated asset needs an
`ASSET_PROVENANCE.md` entry (`model + license + prompt + seed`) before its
card can leave `in-progress` -- non-optional. The writer that appends to
`ASSET_PROVENANCE.md` is T-0075, not built here; this module captures the
record it will need, at generation time, so nothing has to be reconstructed
after the fact.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from gen_client_base.license_allowlist import assert_checkpoint_allowed

from comfy_client.errors import MissingModelHashError
from comfy_client.recipe import Recipe


@dataclass(frozen=True)
class ProvenanceRecord:
    model: str
    model_license: str
    model_hash: str | None
    prompt: str
    negative_prompt: str
    seed: int
    steps: int
    cfg: float
    width: int
    height: int
    workflow_hash: str
    prompt_id: str


def build_provenance_record(recipe: Recipe, workflow_hash: str, prompt_id: str) -> ProvenanceRecord:
    # Re-derives the license rather than trusting the caller ran the check --
    # cheap, and it means this function alone is safe to call from anywhere.
    entry = assert_checkpoint_allowed(recipe.checkpoint)
    if recipe.model_hash is None:
        raise MissingModelHashError(
            f"recipe.model_hash is None for checkpoint {recipe.checkpoint!r} -- "
            "the exact weights cannot be proven without a hash (PLAN.md §0). "
            "Pass checkpoint_dir= to generate(), or set recipe.model_hash before calling."
        )
    return ProvenanceRecord(
        model=recipe.checkpoint,
        model_license=entry.license,
        model_hash=recipe.model_hash,
        prompt=recipe.prompt,
        negative_prompt=recipe.negative_prompt,
        seed=recipe.seed,
        steps=recipe.steps,
        cfg=recipe.cfg,
        width=recipe.width,
        height=recipe.height,
        workflow_hash=workflow_hash,
        prompt_id=prompt_id,
    )


def provenance_to_dict(record: ProvenanceRecord) -> dict:
    return asdict(record)
