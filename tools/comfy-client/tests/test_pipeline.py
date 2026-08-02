"""Generation pipeline: license gate -> generate -> save -> descend seam ->
provenance -- the T-0071 handoff point for T-0073 (descend) and T-0102
(validate), which this task deliberately doesn't implement."""

from __future__ import annotations

import pytest

from comfy_client.client import GenerationClient
from comfy_client.license_allowlist import CheckpointNotAllowedError
from comfy_client.pipeline import generate
from comfy_client.recipe import Recipe


class FakeClient(GenerationClient):
    def __init__(self, prompt_id: str = "fake123", image_bytes: bytes = b"PNGDATA") -> None:
        self.prompt_id = prompt_id
        self.image_bytes = image_bytes
        self.calls: list[tuple] = []

    def submit(self, workflow):
        self.calls.append(("submit", workflow))
        return self.prompt_id

    def wait_for_completion(self, job_id, timeout, poll_interval):
        self.calls.append(("wait", job_id, timeout, poll_interval))
        return {"job_id": job_id}

    def fetch_output(self, job_result):
        self.calls.append(("fetch", job_result))
        return self.image_bytes


def test_generate_saves_raw_output_and_returns_result(tmp_path, sample_recipe):
    client = FakeClient()
    result = generate(sample_recipe, out_dir=tmp_path, client=client)

    assert result.path.exists()
    assert result.path.read_bytes() == b"PNGDATA"
    assert result.path.parent == tmp_path
    assert result.prompt_id == "fake123"
    assert [c[0] for c in client.calls] == ["submit", "wait", "fetch"]


def test_generate_submits_the_recipe_rendered_as_a_workflow(tmp_path, sample_recipe):
    client = FakeClient()
    generate(sample_recipe, out_dir=tmp_path, client=client)

    _, submitted_graph = client.calls[0]
    assert submitted_graph["6"]["inputs"]["text"] == sample_recipe.prompt


def test_generate_provenance_matches_recipe(tmp_path, sample_recipe):
    client = FakeClient(prompt_id="p42")
    result = generate(sample_recipe, out_dir=tmp_path, client=client)

    prov = result.provenance
    assert prov.model == sample_recipe.checkpoint
    assert prov.prompt == sample_recipe.prompt
    assert prov.seed == sample_recipe.seed
    assert prov.prompt_id == "p42"
    assert prov.workflow_hash


def test_generate_creates_out_dir_if_missing(tmp_path, sample_recipe):
    out_dir = tmp_path / "nested" / "out"
    result = generate(sample_recipe, out_dir=out_dir, client=FakeClient())
    assert result.path.exists()
    assert result.path.parent == out_dir


def test_generate_refuses_disallowed_checkpoint_before_any_client_call(tmp_path):
    recipe = Recipe(prompt="x", seed=1, checkpoint="not_on_allowlist.safetensors")
    client = FakeClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate(recipe, out_dir=tmp_path, client=client)
    assert client.calls == []
