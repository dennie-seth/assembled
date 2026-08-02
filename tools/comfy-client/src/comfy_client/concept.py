"""Concept-generation path (T-0104, `docs/design/13-asset-pipeline.md` §6).

`recipe -> generate -> commit` -- deliberately narrower than
`pipeline.generate()`'s full arrow. Concept art is a **source**, not a
shippable asset (P-1/P-3 inverted for it): full-colour, full-res, never
downscaled or palette-quantized, and committed to `assets/src/concept/`
rather than gitignored. So this module skips `descend`/`validate`
entirely instead of running the identity `descend_stub` -- there is no
palette yet to quantize against; extracting one *from* an approved sheet
is the next task (T-0105).

Because the output is committed rather than regenerable-and-discarded,
its provenance has to persist alongside it immediately (a
`<name>.provenance.json` sidecar) rather than waiting on the
not-yet-built `ASSET_PROVENANCE.md` writer (T-0075) the way
`pipeline.generate()`'s does. `concept_hash` (sha256 of the approved
sheet) is the field the archetype-first coherence guard (T-0106) will
key conditioning on.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import assert_checkpoint_allowed

from comfy_client.base_url import resolve_base_url
from comfy_client.comfyui_client import ComfyUIClient
from comfy_client.provenance import build_provenance_record
from comfy_client.recipe import Recipe
from comfy_client.workflow import render_workflow
from comfy_client.workflow import workflow_hash as compute_workflow_hash

DEFAULT_CONCEPT_DIR = Path("assets/src/concept")


@dataclass(frozen=True)
class ConceptProvenanceRecord:
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
    concept_hash: str


def build_concept_provenance_record(
    recipe: Recipe, workflow_hash: str, prompt_id: str, concept_hash: str
) -> ConceptProvenanceRecord:
    base = build_provenance_record(recipe, workflow_hash=workflow_hash, prompt_id=prompt_id)
    return ConceptProvenanceRecord(**asdict(base), concept_hash=concept_hash)


def concept_provenance_to_dict(record: ConceptProvenanceRecord) -> dict:
    return asdict(record)


@dataclass(frozen=True)
class ConceptResult:
    path: Path
    prompt_id: str
    provenance: ConceptProvenanceRecord


def generate_concept(
    recipe: Recipe,
    out_dir: str | Path = DEFAULT_CONCEPT_DIR,
    client: GenerationClient | None = None,
    timeout: float = 300.0,
    poll_interval: float = 1.0,
) -> ConceptResult:
    """recipe -> generate -> commit (no descend, no quantize -- see module
    docstring). Raises `CheckpointNotAllowedError` before ever rendering a
    workflow or touching `client`, same guardrail as `pipeline.generate()`.
    """
    assert_checkpoint_allowed(recipe.checkpoint)

    graph = render_workflow(recipe)
    graph_hash = compute_workflow_hash(graph)

    gen_client = client or ComfyUIClient(base_url=resolve_base_url())

    job_id = gen_client.submit(graph)
    job_result = gen_client.wait_for_completion(
        job_id, timeout=timeout, poll_interval=poll_interval
    )
    raw_bytes = gen_client.fetch_output(job_result)
    concept_hash = hashlib.sha256(raw_bytes).hexdigest()

    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    image_path = out_dir_path / f"{recipe.name}.png"
    image_path.write_bytes(raw_bytes)

    provenance = build_concept_provenance_record(
        recipe, workflow_hash=graph_hash, prompt_id=job_id, concept_hash=concept_hash
    )
    provenance_path = out_dir_path / f"{recipe.name}.provenance.json"
    provenance_path.write_text(json.dumps(concept_provenance_to_dict(provenance), indent=2))

    return ConceptResult(path=image_path, prompt_id=job_id, provenance=provenance)
