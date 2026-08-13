"""Generation pipeline: license gate -> generate -> save -> descend seam ->
provenance -- the T-0071 handoff point for T-0073 (descend) and T-0102
(validate), which this task deliberately doesn't implement."""

from __future__ import annotations

import hashlib

import pytest
from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from comfy_client.errors import MissingModelHashError
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


# ---- T-0151: model_hash required ----------------------------------------


def test_generate_with_checkpoint_dir_populates_model_hash(tmp_path):
    """generate() with checkpoint_dir hashes the file and stores it in provenance."""
    ckpt_dir = tmp_path / "checkpoints"
    ckpt_dir.mkdir()
    ckpt_file = ckpt_dir / "sd_xl_base_1.0.safetensors"
    ckpt_file.write_bytes(b"FAKE_CHECKPOINT_BYTES")
    expected_hash = hashlib.sha256(b"FAKE_CHECKPOINT_BYTES").hexdigest()

    recipe = Recipe(prompt="a signal tower", seed=1)
    client = FakeClient()
    result = generate(recipe, out_dir=tmp_path / "out", client=client, checkpoint_dir=ckpt_dir)

    assert result.provenance.model_hash == expected_hash


def test_generate_with_pre_set_model_hash_uses_it(tmp_path):
    """If recipe.model_hash is already set, no checkpoint_dir is needed."""
    recipe = Recipe(prompt="a signal tower", seed=1, model_hash="abcd1234" + "0" * 56)
    client = FakeClient()
    result = generate(recipe, out_dir=tmp_path, client=client)
    assert result.provenance.model_hash == recipe.model_hash


def test_generate_raises_missing_model_hash_without_checkpoint_dir(tmp_path):
    """generate() with no checkpoint_dir and recipe.model_hash=None raises."""
    recipe = Recipe(prompt="a signal tower", seed=1)  # model_hash defaults to None
    client = FakeClient()
    with pytest.raises(MissingModelHashError):
        generate(recipe, out_dir=tmp_path, client=client)
    # Client should not be called -- the error is raised before generation
    assert client.calls == []


def test_generate_checkpoint_dir_hash_overrides_recipe_model_hash(tmp_path):
    """If both checkpoint_dir and recipe.model_hash are provided, file hash wins."""
    ckpt_dir = tmp_path / "checkpoints"
    ckpt_dir.mkdir()
    ckpt_file = ckpt_dir / "sd_xl_base_1.0.safetensors"
    ckpt_file.write_bytes(b"ACTUAL_BYTES")
    file_hash = hashlib.sha256(b"ACTUAL_BYTES").hexdigest()

    recipe = Recipe(prompt="a signal tower", seed=1, model_hash="stale_hash" + "0" * 54)
    client = FakeClient()
    result = generate(recipe, out_dir=tmp_path / "out", client=client, checkpoint_dir=ckpt_dir)

    assert result.provenance.model_hash == file_hash


# ---- T-0075: ASSET_PROVENANCE.md auto-writer --------------------------------


def _make_provenance_md(tmp_path):
    """Minimal ASSET_PROVENANCE.md with the required table header."""
    md = tmp_path / "ASSET_PROVENANCE.md"
    md.write_text(
        "# Asset Provenance\n\n"
        "| Asset | Model | License | Prompt | Seed |\n"
        "|---|---|---|---|---|\n"
    )
    return md


def test_generate_appends_provenance_entry_to_md(tmp_path, sample_recipe):
    """generate() auto-appends a provenance row to ASSET_PROVENANCE.md (T-0075)."""
    md = _make_provenance_md(tmp_path)
    generate(sample_recipe, out_dir=tmp_path / "out", client=FakeClient(), provenance_md=md)

    text = md.read_text()
    assert sample_recipe.checkpoint in text
    assert str(sample_recipe.seed) in text
    assert sample_recipe.prompt in text or sample_recipe.prompt[:30] in text


def test_generate_writes_provenance_to_default_path_when_not_explicit(tmp_path, sample_recipe):
    """When provenance_md is not passed, generate() writes to ASSET_PROVENANCE.md in CWD.

    The autouse _default_provenance_md fixture creates the file and sets CWD to tmp_path,
    so the default Path('ASSET_PROVENANCE.md') resolves there (T-0075 criterion 1 & 3).
    """
    result = generate(sample_recipe, out_dir=tmp_path, client=FakeClient())
    assert result.path.exists()
    prov_text = (tmp_path / "ASSET_PROVENANCE.md").read_text()
    assert sample_recipe.checkpoint in prov_text
