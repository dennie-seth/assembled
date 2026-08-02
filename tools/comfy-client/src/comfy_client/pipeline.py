"""Ties the whole T-0071 arrow together: license gate -> generate -> save ->
descend seam -> provenance (13-asset-pipeline.md §1). `generate()` is what
the `assets` agent (`.claude/agents/assets.md`) and the CLI (`cli.py`) call.

Deliberately stops short of the real descent chain (T-0073) and the
validation gate (T-0102, already built in `tools/asset-gate`) -- this
module only provides the seam those hand off through.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from comfy_client.base_url import resolve_base_url
from comfy_client.client import GenerationClient
from comfy_client.comfyui_client import ComfyUIClient
from comfy_client.descend import descend_stub
from comfy_client.license_allowlist import assert_checkpoint_allowed
from comfy_client.provenance import ProvenanceRecord, build_provenance_record
from comfy_client.recipe import Recipe
from comfy_client.workflow import render_workflow
from comfy_client.workflow import workflow_hash as compute_workflow_hash

DEFAULT_OUT_DIR = Path("assets/out")


@dataclass(frozen=True)
class GenerationResult:
    path: Path
    prompt_id: str
    provenance: ProvenanceRecord


def generate(
    recipe: Recipe,
    out_dir: str | Path = DEFAULT_OUT_DIR,
    client: GenerationClient | None = None,
    timeout: float = 300.0,
    poll_interval: float = 1.0,
) -> GenerationResult:
    """recipe -> generate -> descend(stub) -> provenance.

    Raises `CheckpointNotAllowedError` before ever rendering a workflow or
    touching `client` if `recipe.checkpoint` isn't on the license allowlist
    -- the T-0071 guardrail is enforced here, not left to the caller.
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

    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    raw_path = out_dir_path / f"{recipe.name}_{job_id}.png"
    raw_path.write_bytes(raw_bytes)

    # TODO(T-0073): real descent chain replaces this seam.
    final_path = descend_stub(raw_path)

    provenance = build_provenance_record(recipe, workflow_hash=graph_hash, prompt_id=job_id)

    return GenerationResult(path=final_path, prompt_id=job_id, provenance=provenance)
