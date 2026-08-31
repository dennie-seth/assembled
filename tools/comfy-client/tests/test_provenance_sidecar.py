"""Tests for `comfy_client.provenance_sidecar` -- the validating `.provenance.json` writer.

Root cause this closes (T-0226 / PR #247, HANDOFF §22-c): the concept-generation
path emitted sidecars with **no** `generator` field at all, so whoever ran it
hand-added the field afterwards as freeform prose
(``"assets/.../_comfyui_structure_workflow.json (ComfyUI 0.29.0 img2img+LoRA
workflow, submitted via tools/board/scripts/agentCurl.js per T-0226)"``).  The
P-7 gate in ``asset_gate.generator`` resolves that field **verbatim** as a repo
path, so the whole sentence failed to resolve and the card burned CI cycles.

The writer makes that unrepresentable: `generator` is set structurally to a bare
repo-relative path, free text is refused outright, and the path is validated
against the repo at write time -- at generation, not hours later in CI.
"""

from __future__ import annotations

import json
import subprocess

import pytest
from asset_gate.generator import check_provenance_generator_resolvable

from comfy_client.provenance_sidecar import (
    ARM_C_BENCHMARK,
    GeneratorFieldError,
    GeneratorNotCommittedError,
    apply_arm_c_benchmark_fields,
    validate_generator_field,
    write_provenance_sidecar,
)


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    """A real git repo -- the writer is git-aware, so a fake tree won't do."""
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@example.com")
    _git(tmp_path, "config", "user.name", "T")
    return tmp_path


def _commit_recipe(repo, rel="assets/src/concept/_workflow.json"):
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"prompt": {}}')
    _git(repo, "add", rel)
    _git(repo, "commit", "-qm", "add recipe")
    return rel


def _stage_recipe(repo, rel="assets/src/concept/_staged_workflow.json"):
    """Staged in the index but never committed -- must still count."""
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"prompt": {}}')
    _git(repo, "add", rel)
    return rel


RECORD = {
    "model": "sd_xl_base_1.0.safetensors",
    "model_license": "CreativeML Open RAIL++-M",
    "model_hash": "31e35c80",
    "prompt": "a flat side-on concept sheet",
    "negative_prompt": "perspective",
    "seed": 21201,
    "steps": 30,
    "cfg": 7.0,
    "width": 1024,
    "height": 1024,
    "workflow_hash": "df4b78eb",
    "prompt_id": "2797fa19-2607-4dfb-b3b1-dbec203cc9ea",
    "concept_hash": "ac90458c",
}


# ---- free-text generators are refused (the exact T-0226 defect) ----


def test_rejects_the_literal_t0226_generator_string(repo):
    """The string that actually shipped and broke the gate."""
    _commit_recipe(repo)
    bad = (
        "assets/src/concept/_workflow.json (ComfyUI 0.29.0 img2img+LoRA workflow, "
        "submitted via tools/board/scripts/agentCurl.js per T-0226)"
    )
    with pytest.raises(GeneratorFieldError):
        validate_generator_field(bad, repo_root=repo)


def test_rejects_the_t0210_parenthetical_pattern(repo):
    _commit_recipe(repo)
    with pytest.raises(GeneratorFieldError):
        validate_generator_field(
            "assets/src/concept/_workflow.json (ComfyUI via T-0210)", repo_root=repo
        )


@pytest.mark.parametrize(
    "bad",
    [
        "ComfyUI 0.29.0 via T-0215 (SolidMask + JoinImageWithAlpha)",  # the original §22-c example
        "assets/src/concept/_workflow.json extra",  # any whitespace at all
        "assets/src/concept/_workflow.json, and a note",
        'assets/src/concept/"_workflow".json',
        "assets/src/concept/_workflow.json;rm -rf /",
        "/etc/passwd",  # absolute
        "../../../etc/passwd",  # traversal
        "assets\\src\\concept\\_workflow.json",  # backslashes, not repo-relative posix
        "",
        None,
        123,
    ],
)
def test_rejects_non_bare_path_generators(repo, bad):
    _commit_recipe(repo)
    with pytest.raises((GeneratorFieldError, TypeError)):
        validate_generator_field(bad, repo_root=repo)


def test_generator_field_error_names_the_offending_value_and_the_rule(repo):
    _commit_recipe(repo)
    bad = "assets/src/concept/_workflow.json (ComfyUI 0.29.0)"
    with pytest.raises(GeneratorFieldError) as exc:
        validate_generator_field(bad, repo_root=repo)
    msg = str(exc.value)
    assert "_generator_note" in msg, "must point the caller at where prose belongs"
    assert "bare" in msg.lower() or "path" in msg.lower()


# ---- resolvability, git-aware ----


def test_accepts_a_bare_committed_path(repo):
    rel = _commit_recipe(repo)
    validate_generator_field(rel, repo_root=repo)  # must not raise


def test_accepts_a_staged_but_uncommitted_recipe(repo):
    """A recipe `git add`-ed in the same run counts -- CI will see it in the PR."""
    rel = _stage_recipe(repo)
    validate_generator_field(rel, repo_root=repo)  # must not raise


def test_rejects_a_path_that_does_not_exist(repo):
    with pytest.raises(GeneratorNotCommittedError):
        validate_generator_field("assets/src/concept/_nope.json", repo_root=repo)


def test_rejects_a_file_on_disk_that_is_untracked(repo):
    """The CI trap: present locally, invisible to the gate on a clean checkout."""
    p = repo / "assets/src/concept/_untracked.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{}")
    with pytest.raises(GeneratorNotCommittedError):
        validate_generator_field("assets/src/concept/_untracked.json", repo_root=repo)


def test_not_committed_error_is_actionable(repo):
    p = repo / "assets/src/concept/_untracked.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{}")
    with pytest.raises(GeneratorNotCommittedError) as exc:
        validate_generator_field("assets/src/concept/_untracked.json", repo_root=repo)
    msg = str(exc.value)
    assert "assets/src/concept/_untracked.json" in msg
    assert "commit" in msg.lower(), "must tell the caller what to do about it"


def test_rejects_a_directory(repo):
    _commit_recipe(repo)
    with pytest.raises(GeneratorNotCommittedError):
        validate_generator_field("assets/src/concept", repo_root=repo)


# ---- the writer itself ----


def test_writes_generator_as_a_bare_path_and_prose_into_its_own_fields(repo):
    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"

    write_provenance_sidecar(
        out,
        RECORD,
        generator=rel,
        repo_root=repo,
        comfyui_version="0.29.0",
        card="T-0226",
        note="submitted via tools/board/scripts/agentCurl.js",
    )

    written = json.loads(out.read_text())
    assert written["generator"] == rel
    assert written["comfyui_version"] == "0.29.0"
    assert written["card"] == "T-0226"
    assert written["_generator_note"] == "submitted via tools/board/scripts/agentCurl.js"
    # the prose must NOT have leaked into the gated field
    assert "(" not in written["generator"]
    assert " " not in written["generator"]


def test_round_trip_passes_the_real_asset_gate_resolver(repo):
    """The point of the whole exercise: what the writer emits satisfies the gate."""
    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"

    write_provenance_sidecar(out, RECORD, generator=rel, repo_root=repo, card="T-0226")

    result = check_provenance_generator_resolvable(json.loads(out.read_text()), repo_root=repo)
    assert result.passed, result.reason


def test_preserves_every_field_of_the_generation_record(repo):
    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"

    write_provenance_sidecar(out, RECORD, generator=rel, repo_root=repo)

    written = json.loads(out.read_text())
    for key, value in RECORD.items():
        assert written[key] == value


def test_accepts_a_dataclass_record(repo):
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class Rec:
        model: str
        seed: int

    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"
    write_provenance_sidecar(out, Rec(model="m", seed=1), generator=rel, repo_root=repo)

    written = json.loads(out.read_text())
    assert written["model"] == "m"
    assert written["seed"] == 1
    assert written["generator"] == rel


def test_optional_prose_fields_are_omitted_when_not_supplied(repo):
    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"
    write_provenance_sidecar(out, RECORD, generator=rel, repo_root=repo)

    written = json.loads(out.read_text())
    assert "comfyui_version" not in written
    assert "card" not in written
    assert "_generator_note" not in written


def test_refuses_to_write_anything_when_the_generator_is_bad(repo):
    """Fail loudly at generation -- and leave no half-valid sidecar behind."""
    _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"

    with pytest.raises(GeneratorFieldError):
        write_provenance_sidecar(
            out, RECORD, generator="assets/src/concept/_workflow.json (prose)", repo_root=repo
        )
    assert not out.exists()


def test_refuses_to_write_when_the_recipe_is_not_committed(repo):
    out = repo / "assets/src/concept/sheet.provenance.json"
    with pytest.raises(GeneratorNotCommittedError):
        write_provenance_sidecar(
            out, RECORD, generator="assets/src/concept/_nope.json", repo_root=repo
        )
    assert not out.exists()


def test_a_record_carrying_its_own_generator_key_cannot_smuggle_free_text(repo):
    """`generator` is the writer's to set -- a record field must not override it."""
    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"
    smuggled = {**RECORD, "generator": "ComfyUI 0.29.0 (hand-written)"}

    write_provenance_sidecar(out, smuggled, generator=rel, repo_root=repo)

    written = json.loads(out.read_text())
    assert written["generator"] == rel


def test_output_is_pretty_printed_json_with_trailing_newline(repo):
    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"
    write_provenance_sidecar(out, RECORD, generator=rel, repo_root=repo)

    text = out.read_text()
    assert text.endswith("\n")
    assert "\n  " in text, "indent=2, matching the existing sidecars"


def test_repo_root_is_discovered_from_the_sidecar_path_when_not_given(repo, monkeypatch):
    rel = _commit_recipe(repo)
    out = repo / "assets/src/concept/sheet.provenance.json"
    monkeypatch.chdir(repo)

    write_provenance_sidecar(out, RECORD, generator=rel)

    assert json.loads(out.read_text())["generator"] == rel


# ---------------------------------------------------------------------------
# CHR-1 (docs/board-invariants.md, DL-25/PR #287, T-0258): a single shared
# Arm-C benchmark constant + a write helper that owns frame_delta_range /
# arm_c_benchmark / beats_arm_c_benchmark, so a character generator cannot
# silently stop recording the comparison. See
# assets/src/character/gen_hybrid_idle_T0252.py,
# gen_pose_authority_idle_T0249.py and gen_chained_idle_T0250.py for the
# callers this replaces.
# ---------------------------------------------------------------------------


def test_arm_c_benchmark_is_the_documented_pair():
    """docs/board-invariants.md CHR-1: Arm C's own measured frame-delta range
    (T-0230), the tightest this pipeline has produced."""
    assert ARM_C_BENCHMARK == (0.072, 0.112)


def test_apply_arm_c_benchmark_fields_derives_range_from_ratios():
    ratios = [0.05, 0.09, 0.03]
    result = apply_arm_c_benchmark_fields({}, ratios)
    assert result["frame_delta_range"] == [0.03, 0.09]


def test_apply_arm_c_benchmark_fields_records_the_shared_benchmark_pair():
    result = apply_arm_c_benchmark_fields({}, [0.05])
    assert result["arm_c_benchmark"] == [0.072, 0.112]


def test_apply_arm_c_benchmark_fields_beats_when_worst_ratio_clears_upper_bound():
    result = apply_arm_c_benchmark_fields({}, [0.05, 0.112, 0.02])
    assert result["beats_arm_c_benchmark"] is True


def test_apply_arm_c_benchmark_fields_does_not_beat_when_worst_ratio_exceeds_upper_bound():
    """CHR-2: false is a legitimate, expected outcome (the shipped §24-e winner
    is itself false) -- this only checks the derivation is honest, not that
    beating the benchmark is required."""
    result = apply_arm_c_benchmark_fields({}, [0.05, 0.1763, 0.02])
    assert result["beats_arm_c_benchmark"] is False


def test_apply_arm_c_benchmark_fields_owns_beats_arm_c_benchmark_not_caller_supplied():
    """A caller must not be able to force `beats_arm_c_benchmark=True` for a
    sheet that does not actually beat the benchmark -- the field is always
    derived from `ratios`, never trusted from the input record."""
    smuggled = {"beats_arm_c_benchmark": True, "frame_delta_range": [0.0, 0.0]}
    result = apply_arm_c_benchmark_fields(smuggled, [0.5])
    assert result["beats_arm_c_benchmark"] is False
    assert result["frame_delta_range"] == [0.5, 0.5]


def test_apply_arm_c_benchmark_fields_owns_arm_c_benchmark_not_caller_supplied():
    smuggled = {"arm_c_benchmark": [0.0, 999.0]}
    result = apply_arm_c_benchmark_fields(smuggled, [0.05])
    assert result["arm_c_benchmark"] == [0.072, 0.112]


def test_apply_arm_c_benchmark_fields_does_not_mutate_the_input_record():
    record = {"seed": 1}
    apply_arm_c_benchmark_fields(record, [0.05])
    assert record == {"seed": 1}


def test_apply_arm_c_benchmark_fields_preserves_other_keys():
    record = {"seed": 1, "model": "sd_xl"}
    result = apply_arm_c_benchmark_fields(record, [0.05])
    assert result["seed"] == 1
    assert result["model"] == "sd_xl"


def test_apply_arm_c_benchmark_fields_rejects_empty_ratios():
    with pytest.raises(ValueError):
        apply_arm_c_benchmark_fields({}, [])
