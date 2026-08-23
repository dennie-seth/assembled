"""Generator resolvability gate tests (T-0219).

Tests for `asset_gate.generator.check_provenance_generator_resolvable`.  The
gate must reject any provenance record whose `generator` field is missing,
empty, or names a path/process that doesn't exist in the repo tree (HANDOFF
§22-c).  A fabricated or ad-hoc-script generator string that passes today's
gate silently makes the asset unregeneraable -- circumventing P-3 ("the
recipe is the artifact").
"""

from __future__ import annotations

import json

from asset_gate.generator import (
    check_provenance_generator_resolvable,
    load_generator_baseline,
    sweep_provenance_generator_resolvable,
)


# ---- check_provenance_generator_resolvable unit tests ----


def test_passes_when_generator_resolves_to_an_existing_file(tmp_path):
    script = tmp_path / "assets" / "src" / "workflows" / "gen.json"
    script.parent.mkdir(parents=True)
    script.write_text("{}")

    prov = {"generator": "assets/src/workflows/gen.json", "model": "sd_xl_base_1.0.safetensors"}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert result.passed


def test_passes_when_generator_is_a_python_script(tmp_path):
    script = tmp_path / "assets" / "src" / "character" / "synth_entities.py"
    script.parent.mkdir(parents=True)
    script.write_text("# gen")

    prov = {"generator": "assets/src/character/synth_entities.py"}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert result.passed


def test_fails_when_generator_field_is_missing(tmp_path):
    prov = {"model": "sd_xl_base_1.0.safetensors", "seed": 42}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert not result.passed
    assert "missing" in result.reason.lower()


def test_fails_when_generator_field_is_null(tmp_path):
    prov = {"model": "sd_xl_base_1.0.safetensors", "generator": None}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert not result.passed


def test_fails_when_generator_field_is_empty_string(tmp_path):
    prov = {"model": "sd_xl_base_1.0.safetensors", "generator": ""}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert not result.passed


def test_fails_when_generator_names_nonexistent_path(tmp_path):
    prov = {
        "generator": "tools/nonexistent/script.py",
        "model": "sd_xl_base_1.0.safetensors",
    }
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert not result.passed
    assert "not resolve" in result.reason.lower()


def test_fails_when_generator_is_free_text_naming_absent_nodes(tmp_path):
    """Regression: the motivating T-0215 case -- SolidMask + JoinImageWithAlpha don't exist."""
    prov = {
        "generator": "ComfyUI 0.29.0 via T-0215 (SDXL T2I + ImageScale + SolidMask + JoinImageWithAlpha)",
        "model": "sd_xl_base_1.0.safetensors",
    }
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert not result.passed
    assert "not resolve" in result.reason.lower()


def test_result_check_name_is_provenance_generator_resolvable(tmp_path):
    prov = {"model": "x.safetensors"}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert result.check == "provenance_generator_resolvable"


def test_details_include_generator_when_present(tmp_path):
    prov = {"generator": "tools/missing/gen.py"}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert result.details["generator"] == "tools/missing/gen.py"


def test_details_include_present_false_when_field_missing(tmp_path):
    prov = {"model": "x.safetensors"}
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert result.details.get("present") is False


# ---- Sweep tests ----


def _write_prov(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"model": "x.safetensors", "seed": 1, **fields}))


def test_sweep_passes_when_every_sidecar_has_a_resolvable_generator(tmp_path):
    repo_root = tmp_path / "repo"
    script = repo_root / "assets" / "src" / "gen.py"
    script.parent.mkdir(parents=True)
    script.write_text("# gen")

    assets_root = repo_root / "assets"
    _write_prov(assets_root / "a.provenance.json", generator="assets/src/gen.py")
    _write_prov(assets_root / "nested" / "b.provenance.json", generator="assets/src/gen.py")

    results = sweep_provenance_generator_resolvable(assets_root, repo_root=repo_root)

    assert len(results) == 2
    assert all(r.passed for r in results)


def test_sweep_fails_for_each_sidecar_with_an_unresolvable_generator(tmp_path):
    repo_root = tmp_path / "repo"
    script = repo_root / "assets" / "src" / "gen.py"
    script.parent.mkdir(parents=True)
    script.write_text("# gen")

    assets_root = repo_root / "assets"
    _write_prov(assets_root / "good.provenance.json", generator="assets/src/gen.py")
    _write_prov(assets_root / "bad.provenance.json", generator="tools/nonexistent/script.py")

    results = sweep_provenance_generator_resolvable(assets_root, repo_root=repo_root)

    assert len(results) == 2
    by_pass = {r.passed for r in results}
    assert by_pass == {True, False}
    failing = [r for r in results if not r.passed]
    assert "bad.provenance.json" in failing[0].reason


def test_sweep_fails_for_sidecar_with_missing_generator(tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    assets_root = repo_root / "assets"
    _write_prov(assets_root / "no_gen.provenance.json")  # no generator field

    results = sweep_provenance_generator_resolvable(assets_root, repo_root=repo_root)

    assert len(results) == 1
    assert not results[0].passed


def test_sweep_ignores_non_provenance_json_files(tmp_path):
    repo_root = tmp_path
    (tmp_path / "recipe.json").write_text(json.dumps({"prompt": "x"}))
    script = tmp_path / "gen.py"
    script.write_text("# gen")
    _write_prov(tmp_path / "a.provenance.json", generator="gen.py")

    results = sweep_provenance_generator_resolvable(tmp_path, repo_root=tmp_path)

    assert len(results) == 1


def test_sweep_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_provenance_generator_resolvable(tmp_path, repo_root=tmp_path) == []


def test_sweep_result_details_include_path(tmp_path):
    repo_root = tmp_path
    _write_prov(tmp_path / "sub" / "a.provenance.json")  # no generator

    results = sweep_provenance_generator_resolvable(tmp_path, repo_root=repo_root)

    assert results[0].details["path"] == "sub/a.provenance.json"


# ---- Baseline exemption ----


def test_sweep_baseline_exempts_documented_pre_existing_gaps(tmp_path):
    repo_root = tmp_path

    _write_prov(tmp_path / "known_bad.provenance.json")  # missing generator
    _write_prov(tmp_path / "unknown_bad.provenance.json")  # missing generator

    results = sweep_provenance_generator_resolvable(
        tmp_path, repo_root=repo_root, baseline=frozenset({"known_bad.provenance.json"})
    )

    by_path = {r.details["path"]: r for r in results}
    assert by_path["known_bad.provenance.json"].passed
    assert by_path["known_bad.provenance.json"].details["baseline_exempt"] is True
    assert not by_path["unknown_bad.provenance.json"].passed
    assert "baseline_exempt" not in by_path["unknown_bad.provenance.json"].details


def test_sweep_does_not_baseline_exempt_a_passing_file(tmp_path):
    repo_root = tmp_path
    script = tmp_path / "gen.py"
    script.write_text("# gen")
    _write_prov(tmp_path / "fine.provenance.json", generator="gen.py")

    results = sweep_provenance_generator_resolvable(
        tmp_path, repo_root=repo_root, baseline=frozenset({"fine.provenance.json"})
    )

    assert results[0].passed
    assert "baseline_exempt" not in results[0].details


def test_load_generator_baseline_returns_empty_set_when_file_missing(tmp_path):
    assert load_generator_baseline(tmp_path / "does_not_exist.txt") == frozenset()


def test_load_generator_baseline_parses_lines_and_skips_comments_and_blanks(tmp_path):
    baseline_file = tmp_path / "baseline.txt"
    baseline_file.write_text("# a comment\nfoo/bar.provenance.json\n\nbaz.provenance.json\n")

    assert load_generator_baseline(baseline_file) == frozenset(
        {"foo/bar.provenance.json", "baz.provenance.json"}
    )


def test_load_generator_baseline_default_path_excludes_signal_tower_props():
    """The 5 signal_tower props are the motivating failure case -- never in the baseline."""
    baseline = load_generator_baseline()

    assert "final/props/signal_tower/crate_stack_v1.provenance.json" not in baseline
    assert "final/props/signal_tower/locker_v1.provenance.json" not in baseline
    assert "final/props/signal_tower/low_duct_v1.provenance.json" not in baseline
    assert "final/props/signal_tower/relay_cabinet_v1.provenance.json" not in baseline
    assert "final/props/signal_tower/server_rack_v1.provenance.json" not in baseline
    # 24 pre-existing gaps (all committed provenance files minus the 5 signal_tower props)
    assert len(baseline) == 24


# ---- Regression: the 5 T-0215 signal_tower props must fail ----


def test_signal_tower_prop_with_fabricated_generator_fails(tmp_path):
    """Motivating case (HANDOFF §22-c): generator names nodes not in the repo."""
    prov = {
        "model": "sd_xl_base_1.0.safetensors",
        "generator": "ComfyUI 0.29.0 via T-0215 (SDXL T2I + ImageScale + SolidMask + JoinImageWithAlpha)",
        "seed": 12345,
    }
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert not result.passed
    assert result.check == "provenance_generator_resolvable"


def test_signal_tower_prop_with_missing_generator_fails(tmp_path):
    """Current repo state: synthetic sidecars lack a generator field entirely."""
    prov = {
        "model": "synth -- programmatic stdlib-only generation (T-0201 fallback)",
        "model_hash": None,
        "seed": 0,
    }
    result = check_provenance_generator_resolvable(prov, repo_root=tmp_path)
    assert not result.passed
