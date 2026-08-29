"""Player-identity LoRA v2 training gate — T-0248 (HANDOFF §24-a, round 2).

Same shape as test_identity_lora_training_T0229.py (v1's gate, left intact):
validates the trained weights file and its provenance sidecar independently
of any downstream generation gate. Additionally checks that v1 is left
untouched (acceptance: "v2 is an addition, not a replacement").

RED state: assets/final/lora/player_identity_v2.safetensors absent -> every
           test ERRORs or fails its existence assertion.
GREEN state: a valid safetensors file exists, its sha256 matches the
             provenance sidecar's weights_hash, and the sidecar's
             training_config / curation_manifest / generator fields all
             resolve to committed files in this repo tree (P-7).
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
WEIGHTS_PATH = REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v2.safetensors"
PROVENANCE_PATH = REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v2.provenance.json"

V1_WEIGHTS_PATH = REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v1.safetensors"
V1_PROVENANCE_PATH = REPO_ROOT / "assets" / "final" / "lora" / "player_identity_v1.provenance.json"

CHECKPOINT_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"


def _read_safetensors_header(path: Path) -> dict:
    """Minimal safetensors header parse (no `safetensors` package dependency):
    an 8-byte little-endian header-length prefix followed by that many bytes
    of JSON describing each tensor's dtype/shape/offsets (see
    https://github.com/huggingface/safetensors#format)."""
    with path.open("rb") as f:
        (header_len,) = struct.unpack("<Q", f.read(8))
        header = json.loads(f.read(header_len))
    return header


@pytest.fixture(scope="module")
def provenance() -> dict:
    assert PROVENANCE_PATH.exists(), (
        f"identity LoRA v2 provenance sidecar not found: {PROVENANCE_PATH}\n"
        "Run assets/src/lora/src/lora_train/train.py against "
        "training_config_player_identity_v2.toml to produce the weights, then "
        "write the sidecar."
    )
    return json.loads(PROVENANCE_PATH.read_text())


def test_weights_file_is_valid_safetensors() -> None:
    assert WEIGHTS_PATH.exists(), f"trained identity LoRA v2 not found: {WEIGHTS_PATH}"
    assert WEIGHTS_PATH.stat().st_size > 0, f"weights file is empty: {WEIGHTS_PATH}"
    header = _read_safetensors_header(WEIGHTS_PATH)
    tensor_keys = [k for k in header if k != "__metadata__"]
    assert tensor_keys, "safetensors file has zero tensors"


def test_weights_hash_matches_provenance(provenance: dict) -> None:
    got = hashlib.sha256(WEIGHTS_PATH.read_bytes()).hexdigest()
    expected = provenance.get("weights_hash")
    assert expected, "provenance missing 'weights_hash'"
    assert got == expected, f"weights_hash mismatch:\n  got:      {got}\n  expected: {expected}"


def test_model_hash_present(provenance: dict) -> None:
    """P-7: model_hash (base checkpoint the LoRA was trained against) non-null."""
    assert provenance.get("model_hash") == CHECKPOINT_HASH


def test_generator_field_resolves(provenance: dict) -> None:
    generator = provenance.get("generator")
    assert generator, "generator field missing from provenance JSON"
    resolved = (REPO_ROOT / generator).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"generator '{generator}' does not resolve to a committed file"


def test_training_config_field_resolves(provenance: dict) -> None:
    training_config = provenance.get("training_config")
    assert training_config, "training_config field missing from provenance JSON"
    resolved = (REPO_ROOT / training_config).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"training_config '{training_config}' does not resolve"


def test_curation_manifest_field_resolves(provenance: dict) -> None:
    manifest_path = provenance.get("curation_manifest")
    assert manifest_path, "curation_manifest field missing from provenance JSON"
    resolved = (REPO_ROOT / manifest_path).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"curation_manifest '{manifest_path}' does not resolve"


def test_training_cost_fields_present(provenance: dict) -> None:
    """Acceptance: actual GPU-minutes/attempts/wall-clock are recorded for the
    §23-c cost table (recorded, not deciding, per the round-2 override)."""
    assert isinstance(provenance.get("gpu_seconds"), (int, float)), (
        "provenance missing numeric 'gpu_seconds' for the training run"
    )
    assert provenance.get("gpu_seconds", 0) > 0
    assert isinstance(provenance.get("steps"), int) and provenance["steps"] > 0


def test_v1_weights_and_provenance_left_intact() -> None:
    """Acceptance: player_identity_v1 and its provenance stay in place -- v2
    is an addition, so round 1 stays reproducible."""
    assert V1_WEIGHTS_PATH.exists(), f"v1 weights missing: {V1_WEIGHTS_PATH}"
    assert V1_PROVENANCE_PATH.exists(), f"v1 provenance missing: {V1_PROVENANCE_PATH}"
