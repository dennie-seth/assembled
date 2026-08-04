"""CLI entrypoint: `audio-agent generate ...` / `audio-agent generate-texture
...` -- what the `audio` agent (or a human, per the manual live-smoke
instructions in README.md) actually invokes. Mocks `pipeline.generate` /
`pipeline.generate_texture`, no real ACE-Step/Stable-Audio/HTTP here.
Mirrors tools/comfy-client/tests/test_cli.py."""

from __future__ import annotations

import json

import pytest
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from audio_agent import cli
from audio_agent.pipeline import GenerationResult
from audio_agent.provenance import build_provenance_record, build_texture_provenance_record
from audio_agent.recipe import MusicRecipe
from audio_agent.texture_recipe import TextureRecipe


@pytest.fixture
def recipe_path(tmp_path):
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps({"prompt": "a room-anchored music cue", "seed": 42}))
    return str(path)


def test_generate_command_prints_json_result(monkeypatch, capsys, tmp_path, recipe_path):
    recipe = MusicRecipe(prompt="a room-anchored music cue", seed=42)
    out_path = tmp_path / "assembled_j1.wav"
    out_path.write_bytes(b"data")
    fake_result = GenerationResult(
        path=out_path,
        job_id="assembled_j1.wav",
        provenance=build_provenance_record(recipe, request_hash="hash1", job_id="assembled_j1.wav"),
    )

    def fake_generate(recipe_arg, out_dir, timeout, poll_interval, lock_timeout):
        assert recipe_arg.prompt == "a room-anchored music cue"
        return fake_result

    monkeypatch.setattr(cli, "generate", fake_generate)

    exit_code = cli.main(["generate", "--recipe", recipe_path, "--out-dir", str(tmp_path)])
    assert exit_code == 0

    output = json.loads(capsys.readouterr().out)
    assert output["path"] == str(out_path)
    assert output["job_id"] == "assembled_j1.wav"
    assert output["provenance"]["request_hash"] == "hash1"
    assert output["provenance"]["bus"] == "Music"


def test_generate_command_reports_license_rejection(monkeypatch, capsys, recipe_path, tmp_path):
    def fake_generate(recipe_arg, out_dir, timeout, poll_interval, lock_timeout):
        raise CheckpointNotAllowedError("checkpoint not approved")

    monkeypatch.setattr(cli, "generate", fake_generate)

    exit_code = cli.main(["generate", "--recipe", recipe_path, "--out-dir", str(tmp_path)])
    assert exit_code == 1
    assert "checkpoint not approved" in capsys.readouterr().err


def test_generate_requires_recipe_argument():
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["generate"])


@pytest.fixture
def texture_recipe_path(tmp_path):
    path = tmp_path / "texture_recipe.json"
    path.write_text(json.dumps({"prompt": "a rusted vent grinding", "seed": 9}))
    return str(path)


def test_generate_texture_command_prints_json_result(
    monkeypatch, capsys, tmp_path, texture_recipe_path
):
    recipe = TextureRecipe(prompt="a rusted vent grinding", seed=9)
    out_path = tmp_path / "assembled_t1.wav"
    out_path.write_bytes(b"data")
    fake_result = GenerationResult(
        path=out_path,
        job_id="assembled_t1.wav",
        provenance=build_texture_provenance_record(
            recipe, request_hash="hash2", job_id="assembled_t1.wav"
        ),
    )

    def fake_generate_texture(recipe_arg, out_dir, timeout, poll_interval, lock_timeout):
        assert recipe_arg.prompt == "a rusted vent grinding"
        return fake_result

    monkeypatch.setattr(cli, "generate_texture", fake_generate_texture)

    exit_code = cli.main(
        ["generate-texture", "--recipe", texture_recipe_path, "--out-dir", str(tmp_path)]
    )
    assert exit_code == 0

    output = json.loads(capsys.readouterr().out)
    assert output["path"] == str(out_path)
    assert output["job_id"] == "assembled_t1.wav"
    assert output["provenance"]["request_hash"] == "hash2"
    assert output["provenance"]["bus"] == "World SFX"


def test_generate_texture_command_reports_license_rejection(
    monkeypatch, capsys, texture_recipe_path, tmp_path
):
    def fake_generate_texture(recipe_arg, out_dir, timeout, poll_interval, lock_timeout):
        raise CheckpointNotAllowedError("checkpoint not approved")

    monkeypatch.setattr(cli, "generate_texture", fake_generate_texture)

    exit_code = cli.main(
        ["generate-texture", "--recipe", texture_recipe_path, "--out-dir", str(tmp_path)]
    )
    assert exit_code == 1
    assert "checkpoint not approved" in capsys.readouterr().err


def test_generate_texture_requires_recipe_argument():
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["generate-texture"])
