"""CLI entrypoint: `comfy-client generate --recipe ...` -- what the assets
agent (or a human, per the manual live-smoke instructions in README.md)
actually invokes. Mocks `pipeline.generate`, no real ComfyUI/HTTP here."""

from __future__ import annotations

import json

import pytest
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from comfy_client import cli
from comfy_client.pipeline import GenerationResult
from comfy_client.provenance import build_provenance_record
from comfy_client.recipe import Recipe


@pytest.fixture
def recipe_path(tmp_path):
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps({"prompt": "a derelict signal tower", "seed": 42}))
    return str(path)


def test_generate_command_prints_json_result(monkeypatch, capsys, tmp_path, recipe_path):
    recipe = Recipe(prompt="a derelict signal tower", seed=42)
    out_path = tmp_path / "signal_tower_p1.png"
    out_path.write_bytes(b"data")
    fake_result = GenerationResult(
        path=out_path,
        prompt_id="p1",
        provenance=build_provenance_record(recipe, workflow_hash="hash1", prompt_id="p1"),
    )

    def fake_generate(recipe_arg, out_dir, timeout, poll_interval):
        assert recipe_arg.prompt == "a derelict signal tower"
        return fake_result

    monkeypatch.setattr(cli, "generate", fake_generate)

    exit_code = cli.main(["generate", "--recipe", recipe_path, "--out-dir", str(tmp_path)])
    assert exit_code == 0

    output = json.loads(capsys.readouterr().out)
    assert output["path"] == str(out_path)
    assert output["prompt_id"] == "p1"
    assert output["provenance"]["workflow_hash"] == "hash1"


def test_generate_command_reports_license_rejection(monkeypatch, capsys, recipe_path, tmp_path):
    def fake_generate(recipe_arg, out_dir, timeout, poll_interval):
        raise CheckpointNotAllowedError("checkpoint not approved")

    monkeypatch.setattr(cli, "generate", fake_generate)

    exit_code = cli.main(["generate", "--recipe", recipe_path, "--out-dir", str(tmp_path)])
    assert exit_code == 1
    assert "checkpoint not approved" in capsys.readouterr().err


def test_generate_requires_recipe_argument():
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["generate"])
