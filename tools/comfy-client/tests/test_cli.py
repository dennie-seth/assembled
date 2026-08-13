"""CLI entrypoints: `comfy-client generate --recipe ...` and
`comfy-client concept --recipe ...` (T-0104) -- what the assets agent (or
a human, per the manual live-smoke instructions in README.md) actually
invokes. Mocks `pipeline.generate`/`concept.generate_concept`, no real
ComfyUI/HTTP here."""

from __future__ import annotations

import json

import pytest
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from comfy_client import cli
from comfy_client.concept import (
    ConceptResult,
    build_concept_provenance_record,
    build_conditioned_concept_provenance_record,
)
from comfy_client.pipeline import GenerationResult
from comfy_client.provenance import build_provenance_record
from comfy_client.recipe import Recipe


@pytest.fixture
def recipe_path(tmp_path):
    path = tmp_path / "recipe.json"
    path.write_text(json.dumps({"prompt": "a derelict signal tower", "seed": 42}))
    return str(path)


def test_generate_command_prints_json_result(monkeypatch, capsys, tmp_path, recipe_path):
    recipe = Recipe(prompt="a derelict signal tower", seed=42, model_hash="a" * 64)
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


def test_concept_command_prints_json_result(monkeypatch, capsys, tmp_path, recipe_path):
    recipe = Recipe(prompt="a derelict signal tower", seed=42, model_hash="a" * 64)
    out_path = tmp_path / "assembled.png"
    out_path.write_bytes(b"data")
    fake_result = ConceptResult(
        path=out_path,
        prompt_id="p1",
        provenance=build_concept_provenance_record(
            recipe, workflow_hash="hash1", prompt_id="p1", concept_hash="chash1"
        ),
    )

    def fake_generate_concept(recipe_arg, out_dir, timeout, poll_interval):
        assert recipe_arg.prompt == "a derelict signal tower"
        return fake_result

    monkeypatch.setattr(cli, "generate_concept", fake_generate_concept)

    exit_code = cli.main(["concept", "--recipe", recipe_path, "--out-dir", str(tmp_path)])
    assert exit_code == 0

    output = json.loads(capsys.readouterr().out)
    assert output["path"] == str(out_path)
    assert output["prompt_id"] == "p1"
    assert output["provenance"]["concept_hash"] == "chash1"
    assert output["provenance"]["workflow_hash"] == "hash1"


def test_concept_command_reports_license_rejection(monkeypatch, capsys, recipe_path, tmp_path):
    def fake_generate_concept(recipe_arg, out_dir, timeout, poll_interval):
        raise CheckpointNotAllowedError("checkpoint not approved")

    monkeypatch.setattr(cli, "generate_concept", fake_generate_concept)

    exit_code = cli.main(["concept", "--recipe", recipe_path, "--out-dir", str(tmp_path)])
    assert exit_code == 1
    assert "checkpoint not approved" in capsys.readouterr().err


def test_concept_requires_recipe_argument():
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["concept"])


def test_concept_command_with_init_image_calls_conditioned_path(
    monkeypatch, capsys, tmp_path, recipe_path
):
    recipe = Recipe(prompt="a derelict signal tower", seed=42, denoise=0.65, model_hash="a" * 64)
    out_path = tmp_path / "assembled.png"
    out_path.write_bytes(b"data")
    fake_result = ConceptResult(
        path=out_path,
        prompt_id="p1",
        provenance=build_conditioned_concept_provenance_record(
            recipe,
            workflow_hash="hash1",
            prompt_id="p1",
            concept_hash="chash1",
            conditioning_source="template.png",
        ),
    )

    def fake_generate_concept_conditioned(
        recipe_arg, init_image_path, out_dir, timeout, poll_interval
    ):
        assert recipe_arg.prompt == "a derelict signal tower"
        assert init_image_path == "template.png"
        return fake_result

    monkeypatch.setattr(cli, "generate_concept_conditioned", fake_generate_concept_conditioned)

    exit_code = cli.main(
        [
            "concept",
            "--recipe",
            recipe_path,
            "--out-dir",
            str(tmp_path),
            "--init-image",
            "template.png",
        ]
    )
    assert exit_code == 0

    output = json.loads(capsys.readouterr().out)
    assert output["provenance"]["concept_hash"] == "chash1"
    assert output["provenance"]["conditioning_source"] == "template.png"
    assert output["provenance"]["denoise"] == 0.65
