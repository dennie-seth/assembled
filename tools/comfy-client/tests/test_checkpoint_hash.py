"""Checkpoint file hashing tests (T-0151).

Tests for `comfy_client.checkpoint_hash.hash_checkpoint_file`.
SHA-256 of a checkpoint file must be computed correctly and recorded
in provenance at generation time (PLAN.md §0).
"""

from __future__ import annotations

import hashlib

import pytest

from comfy_client.checkpoint_hash import hash_checkpoint_file


def test_hash_checkpoint_file_returns_sha256_hex(tmp_path):
    f = tmp_path / "model.safetensors"
    f.write_bytes(b"TESTDATA")
    expected = hashlib.sha256(b"TESTDATA").hexdigest()
    assert hash_checkpoint_file(f) == expected


def test_hash_checkpoint_file_accepts_str_path(tmp_path):
    f = tmp_path / "model.safetensors"
    f.write_bytes(b"BYTES")
    expected = hashlib.sha256(b"BYTES").hexdigest()
    assert hash_checkpoint_file(str(f)) == expected


def test_hash_checkpoint_file_is_sha256_length(tmp_path):
    f = tmp_path / "model.safetensors"
    f.write_bytes(b"X" * 10_000)
    result = hash_checkpoint_file(f)
    assert len(result) == 64  # SHA-256 hex digest is 64 hex chars
    assert all(c in "0123456789abcdef" for c in result)


def test_hash_checkpoint_file_raises_for_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        hash_checkpoint_file(tmp_path / "nonexistent.safetensors")


def test_hash_checkpoint_file_large_file_streams_in_chunks(tmp_path):
    """Confirm chunked reading produces the same result as one-shot."""
    data = b"A" * (12 * 1024 * 1024)  # 12 MiB -- forces at least two 8 MiB chunks
    f = tmp_path / "big.safetensors"
    f.write_bytes(data)
    expected = hashlib.sha256(data).hexdigest()
    assert hash_checkpoint_file(f) == expected
