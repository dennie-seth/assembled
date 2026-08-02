"""Concept-generation path (T-0104, `docs/design/13-asset-pipeline.md` §6):
recipe -> generate -> commit, deliberately skipping the descend/validate
arm -- concept art is a full-colour, never-indexed SOURCE, not a
shippable asset. Mirrors `test_pipeline.py`'s shape; the differences are
the point (no descend, a concept_hash, and a provenance sidecar written
alongside the image since the output is committed, not gitignored)."""

from __future__ import annotations

import json

import pytest
from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from comfy_client.concept import generate_concept
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


def test_generate_concept_writes_full_colour_image_and_returns_result(tmp_path, sample_recipe):
    client = FakeClient()
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)

    assert result.path.exists()
    assert result.path.read_bytes() == b"PNGDATA"
    assert result.path == tmp_path / f"{sample_recipe.name}.png"
    assert result.prompt_id == "fake123"
    assert [c[0] for c in client.calls] == ["submit", "wait", "fetch"]


def test_generate_concept_does_not_descend(tmp_path, sample_recipe):
    """No downscale/quantize -- the file on disk is exactly the raw SDXL
    output, byte for byte (contrast with `pipeline.generate()`'s descend
    seam)."""
    client = FakeClient(image_bytes=b"RAWFULLCOLOURPNG")
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)
    assert result.path.read_bytes() == b"RAWFULLCOLOURPNG"


def test_generate_concept_writes_provenance_sidecar_with_concept_hash(tmp_path, sample_recipe):
    client = FakeClient(image_bytes=b"PNGDATA")
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)

    sidecar = tmp_path / f"{sample_recipe.name}.provenance.json"
    assert sidecar.exists()
    on_disk = json.loads(sidecar.read_text())

    import hashlib

    expected_hash = hashlib.sha256(b"PNGDATA").hexdigest()
    assert on_disk["concept_hash"] == expected_hash
    assert result.provenance.concept_hash == expected_hash


def test_generate_concept_provenance_matches_recipe(tmp_path, sample_recipe):
    client = FakeClient(prompt_id="p42")
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)

    prov = result.provenance
    assert prov.model == sample_recipe.checkpoint
    assert prov.prompt == sample_recipe.prompt
    assert prov.seed == sample_recipe.seed
    assert prov.prompt_id == "p42"
    assert prov.workflow_hash


def test_generate_concept_creates_out_dir_if_missing(tmp_path, sample_recipe):
    out_dir = tmp_path / "nested" / "concept"
    result = generate_concept(sample_recipe, out_dir=out_dir, client=FakeClient())
    assert result.path.exists()
    assert result.path.parent == out_dir


def test_generate_concept_refuses_disallowed_checkpoint_before_any_client_call(tmp_path):
    recipe = Recipe(prompt="x", seed=1, checkpoint="not_on_allowlist.safetensors")
    client = FakeClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate_concept(recipe, out_dir=tmp_path, client=client)
    assert client.calls == []
