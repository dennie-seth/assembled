"""Generation pipeline: license gate -> generate (under gpu_lock) -> save ->
descend seam -> provenance -- the T-0082 handoff point for T-0083 (descend)
and T-0102 (validate), which this task deliberately doesn't implement.
Mirrors tools/comfy-client/tests/test_pipeline.py. `generate_texture`
(T-0081, Stable Audio Open) mirrors `generate` (ACE-Step) below it."""

from __future__ import annotations

import pytest
from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from audio_agent.bus import Bus
from audio_agent.pipeline import generate, generate_texture
from audio_agent.recipe import MusicRecipe
from audio_agent.texture_recipe import TextureRecipe


class FakeClient(GenerationClient):
    def __init__(self, audio_bytes: bytes = b"WAVDATA") -> None:
        self.audio_bytes = audio_bytes
        self.calls: list[tuple] = []

    def submit(self, workflow):
        self.calls.append(("submit", workflow))
        return workflow["output_path"]

    def wait_for_completion(self, job_id, timeout, poll_interval):
        self.calls.append(("wait", job_id, timeout, poll_interval))
        return {"job_id": job_id}

    def fetch_output(self, job_result):
        self.calls.append(("fetch", job_result))
        return self.audio_bytes


def test_generate_saves_raw_output_and_returns_result(tmp_path, sample_recipe):
    client = FakeClient()
    result = generate(
        sample_recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock"
    )

    assert result.path.exists()
    assert result.path.read_bytes() == b"WAVDATA"
    assert result.path.parent == tmp_path
    assert result.job_id.startswith(sample_recipe.name)
    assert result.job_id.endswith(".wav")
    assert [c[0] for c in client.calls] == ["submit", "wait", "fetch"]


def test_generate_submits_the_recipe_rendered_as_a_request(tmp_path, sample_recipe):
    client = FakeClient()
    generate(sample_recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock")

    _, submitted_request = client.calls[0]
    assert submitted_request["prompt"] == sample_recipe.prompt
    assert submitted_request["actual_seeds"] == [sample_recipe.seed]


def test_generate_provenance_matches_recipe_and_carries_bus(tmp_path, sample_recipe):
    client = FakeClient()
    result = generate(
        sample_recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock"
    )

    prov = result.provenance
    assert prov.model == sample_recipe.checkpoint
    assert prov.prompt == sample_recipe.prompt
    assert prov.seed == sample_recipe.seed
    assert prov.bus is Bus.MUSIC
    assert prov.job_id == result.job_id
    assert prov.request_hash


def test_generate_creates_out_dir_if_missing(tmp_path, sample_recipe):
    out_dir = tmp_path / "nested" / "out"
    result = generate(
        sample_recipe,
        out_dir=out_dir,
        client=FakeClient(),
        lock_path=tmp_path / "gpu.lock",
    )
    assert result.path.exists()
    assert result.path.parent == out_dir


def test_generate_refuses_disallowed_checkpoint_before_any_client_call(tmp_path):
    recipe = MusicRecipe(prompt="x", seed=1, checkpoint="not_on_allowlist")
    client = FakeClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate(recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock")
    assert client.calls == []


def test_generate_acquires_and_releases_the_gpu_lock(tmp_path, sample_recipe):
    lock_path = tmp_path / "gpu.lock"
    generate(sample_recipe, out_dir=tmp_path, client=FakeClient(), lock_path=lock_path)

    # Lock file exists (created on acquire) and is acquirable again immediately
    # afterward, proving generate() released it before returning.
    assert lock_path.exists()
    from audio_agent.gpu_lock import gpu_lock

    with gpu_lock(lock_path, timeout=1.0):
        pass


def test_generate_texture_saves_raw_output_and_returns_result(tmp_path, sample_texture_recipe):
    client = FakeClient()
    result = generate_texture(
        sample_texture_recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock"
    )

    assert result.path.exists()
    assert result.path.read_bytes() == b"WAVDATA"
    assert result.path.parent == tmp_path
    assert result.job_id.startswith(sample_texture_recipe.name)
    assert result.job_id.endswith(".wav")
    assert [c[0] for c in client.calls] == ["submit", "wait", "fetch"]


def test_generate_texture_submits_the_recipe_rendered_as_a_request(tmp_path, sample_texture_recipe):
    client = FakeClient()
    generate_texture(
        sample_texture_recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock"
    )

    _, submitted_request = client.calls[0]
    assert submitted_request["prompt"] == sample_texture_recipe.prompt
    assert submitted_request["seed"] == sample_texture_recipe.seed


def test_generate_texture_provenance_matches_recipe_and_carries_bus(
    tmp_path, sample_texture_recipe
):
    client = FakeClient()
    result = generate_texture(
        sample_texture_recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock"
    )

    prov = result.provenance
    assert prov.model == sample_texture_recipe.checkpoint
    assert prov.prompt == sample_texture_recipe.prompt
    assert prov.seed == sample_texture_recipe.seed
    assert prov.bus is Bus.WORLD_SFX
    assert prov.job_id == result.job_id
    assert prov.request_hash


def test_generate_texture_creates_out_dir_if_missing(tmp_path, sample_texture_recipe):
    out_dir = tmp_path / "nested" / "out"
    result = generate_texture(
        sample_texture_recipe,
        out_dir=out_dir,
        client=FakeClient(),
        lock_path=tmp_path / "gpu.lock",
    )
    assert result.path.exists()
    assert result.path.parent == out_dir


def test_generate_texture_refuses_disallowed_checkpoint_before_any_client_call(tmp_path):
    recipe = TextureRecipe(prompt="x", seed=1, checkpoint="not_on_allowlist")
    client = FakeClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate_texture(recipe, out_dir=tmp_path, client=client, lock_path=tmp_path / "gpu.lock")
    assert client.calls == []


def test_generate_texture_acquires_and_releases_the_gpu_lock(tmp_path, sample_texture_recipe):
    lock_path = tmp_path / "gpu.lock"
    generate_texture(
        sample_texture_recipe, out_dir=tmp_path, client=FakeClient(), lock_path=lock_path
    )

    # Same lock path as generate() (ACE-Step) -- proves the two backends
    # serialize against each other, not just against themselves.
    assert lock_path.exists()
    from audio_agent.gpu_lock import gpu_lock

    with gpu_lock(lock_path, timeout=1.0):
        pass
