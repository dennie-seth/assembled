"""generator_hash correctness gate tests (T-0238).

Tests for `asset_gate.generator.check_generator_hash_matches`.

Root cause (flow-stats self-improvement trigger, 61% rework rate over the
last 404 validation notes): the `assets` agent has no granted way to
compute a sha256 digest at all -- neither `sha256sum` nor `python3` (unlike
the `audio` agent, which has both). Every `model_hash`/`generator_hash`
value the implementer writes into a `*.provenance.json` sidecar is
therefore typed from memory or estimation rather than computed-and-verified
against the actual committed file. Two of the four evidence cards hit
exactly this failure shape:

* T-0230, commit 37d6d80 "fix(provenance): correct fabricated Arm C
  hashes": "ASSET_PROVENANCE.md:88 recorded a model_hash ... that matched
  no committed version of ... the file, contradicting the correct values
  already in the JSON sidecar."
* T-0232, commit 27fb50d: "the recorded hashes did not match the actual
  sha256 of tile_gen/fields.py or tile_gen/signal_tower_sheet.py" (9
  occurrences corrected, both `model_hash` and `generator_hash`).
* T-0232, commit 7203d64 (a *second* hash correction on the same card):
  "Previous commit computed the transitions sidecar's model_hash against
  fields.py before its final ruff line-length fix landed, so the recorded
  hash didn't match the committed file."

`generator_hash` is the one provenance field in this repo that is
*structurally* unambiguous about which file it pins: every sidecar that
sets it documents it as "pins the sheet-composition script itself" (see
`transitions_16px.provenance.json`'s own `model_hash_note`) -- i.e. it
must always equal `sha256(<the file the sidecar's own "generator" field
names>)`. That makes it mechanically verifiable without guessing, unlike
`model_hash`, which sometimes pins an external, uncommitted checkpoint and
sometimes pins a different committed file entirely (documented only in
free-text notes) -- deliberately out of scope for this check.

Implements docs/design/13-asset-pipeline.md §2 (validation gate, T-0102),
extending the same "writer-agnostic, sweep the committed tree" shape as
`asset_gate.provenance.check_provenance_model_hash` and
`asset_gate.generator.check_provenance_generator_resolvable`.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from asset_gate.generator import check_generator_hash_matches, sweep_generator_hash_matches

# tools/asset-gate/tests/  ->  tools/asset-gate/  ->  tools/  ->  repo root
REPO_ROOT = Path(__file__).resolve().parents[3]

# ---- check_generator_hash_matches unit tests ----


def test_passes_when_generator_hash_matches_the_actual_file(tmp_path):
    script = tmp_path / "assets" / "src" / "tiles" / "sheet.py"
    script.parent.mkdir(parents=True)
    script.write_text("# a real generator recipe\n")
    actual_hash = hashlib.sha256(script.read_bytes()).hexdigest()

    prov = {"generator": "assets/src/tiles/sheet.py", "generator_hash": actual_hash}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.passed


def test_fails_when_generator_hash_is_stale(tmp_path):
    """T-0232 commit 7203d64: the generator file was edited (a ruff fix) after the hash
    was computed, and nothing caught the resulting mismatch until a human noticed."""
    script = tmp_path / "assets" / "src" / "tiles" / "fields.py"
    script.parent.mkdir(parents=True)
    script.write_text("original content\n")
    stale_hash = hashlib.sha256(script.read_bytes()).hexdigest()

    script.write_text("edited after the hash was recorded\n")  # e.g. a ruff --fix pass

    prov = {"generator": "assets/src/tiles/fields.py", "generator_hash": stale_hash}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert not result.passed
    assert "does not match" in result.reason.lower()


def test_fails_when_generator_hash_is_fabricated(tmp_path):
    """T-0230 commit 37d6d80: a hash that never corresponded to any committed version
    of the file at all, not just a stale one."""
    script = tmp_path / "assets" / "src" / "character" / "gen.py"
    script.parent.mkdir(parents=True)
    script.write_text("real recipe\n")

    prov = {
        "generator": "assets/src/character/gen.py",
        "generator_hash": "0" * 64,  # never computed from anything real
    }
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert not result.passed


def test_not_applicable_when_generator_hash_field_absent(tmp_path):
    """Most sidecars only record model_hash for an external, uncommitted checkpoint --
    this check must not newly fail every one of them."""
    prov = {"generator": "assets/src/gen.py", "model_hash": "abc123"}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.passed
    assert result.details.get("applicable") is False


def test_not_applicable_when_generator_hash_is_null(tmp_path):
    prov = {"generator": "assets/src/gen.py", "generator_hash": None}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.passed
    assert result.details.get("applicable") is False


def test_not_applicable_when_generator_field_missing(tmp_path):
    """Deliberately does not duplicate provenance_generator_resolvable's own failure --
    that check already fails a missing generator field on its own."""
    prov = {"generator_hash": "abc123"}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.passed
    assert result.details.get("applicable") is False


def test_not_applicable_when_generator_does_not_resolve(tmp_path):
    prov = {"generator": "tools/nonexistent/script.py", "generator_hash": "abc123"}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.passed
    assert result.details.get("applicable") is False


def test_not_applicable_when_generator_escapes_repo_tree(tmp_path):
    prov = {"generator": "../outside.py", "generator_hash": "abc123"}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.passed
    assert result.details.get("applicable") is False


def test_result_check_name_is_generator_hash_matches(tmp_path):
    prov = {"generator": "assets/src/gen.py"}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.check == "generator_hash_matches"


def test_failure_details_include_recorded_and_actual_hash(tmp_path):
    script = tmp_path / "gen.py"
    script.write_text("real\n")

    prov = {"generator": "gen.py", "generator_hash": "notreal"}
    result = check_generator_hash_matches(prov, repo_root=tmp_path)
    assert result.details["recorded"] == "notreal"
    assert result.details["actual"] == hashlib.sha256(script.read_bytes()).hexdigest()


# ---- sweep tests ----


def _write_prov(path, **fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"model": "x.safetensors", "seed": 1, **fields}))


def test_sweep_passes_when_no_sidecar_uses_generator_hash(tmp_path):
    repo_root = tmp_path / "repo"
    assets_root = repo_root / "assets"
    _write_prov(assets_root / "a.provenance.json", generator="assets/src/gen.py")

    results = sweep_generator_hash_matches(assets_root, repo_root=repo_root)

    assert len(results) == 1
    assert all(r.passed for r in results)


def test_sweep_fails_for_sidecar_with_stale_generator_hash(tmp_path):
    repo_root = tmp_path / "repo"
    script = repo_root / "assets" / "src" / "gen.py"
    script.parent.mkdir(parents=True)
    script.write_text("real content\n")
    actual = hashlib.sha256(script.read_bytes()).hexdigest()

    assets_root = repo_root / "assets"
    _write_prov(
        assets_root / "good.provenance.json", generator="assets/src/gen.py", generator_hash=actual
    )
    _write_prov(
        assets_root / "bad.provenance.json",
        generator="assets/src/gen.py",
        generator_hash="f" * 64,
    )

    results = sweep_generator_hash_matches(assets_root, repo_root=repo_root)

    assert len(results) == 2
    by_pass = {r.passed for r in results}
    assert by_pass == {True, False}
    failing = [r for r in results if not r.passed]
    assert "bad.provenance.json" in failing[0].reason


def test_sweep_of_empty_tree_returns_no_results(tmp_path):
    assert sweep_generator_hash_matches(tmp_path, repo_root=tmp_path) == []


# ---- Regression: the real committed T-0232 sidecar this check exists for ----


def test_transitions_16px_generator_hash_matches_the_real_committed_generator_file():
    """T-0232's own committed sidecar is the sidecar whose two rounds of hash
    corrections (27fb50d, 7203d64) motivated this check. Recomputes the real
    sha256 of the real committed generator file and compares against the
    real committed generator_hash -- this is the exact check that would have
    caught both of T-0232's FAIL rounds before a human had to notice by hand.
    """
    sidecar_path = (
        REPO_ROOT / "assets" / "final" / "tiles" / "signal_tower" / "transitions_16px.provenance.json"
    )
    assert sidecar_path.exists(), f"sidecar not found: {sidecar_path}"
    prov = json.loads(sidecar_path.read_text())

    result = check_generator_hash_matches(prov, repo_root=REPO_ROOT)
    assert result.passed, result.reason
