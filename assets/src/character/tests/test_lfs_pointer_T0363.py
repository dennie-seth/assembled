"""T-0363 CI fix round: `tests.lfs_pointer.is_lfs_pointer` must tell an
un-fetched Git LFS pointer file apart from a real fetched blob.

RED state: `tests/lfs_pointer.py` does not exist -> collection fails with
ModuleNotFoundError.
GREEN state: a pointer file (the literal
`version https://git-lfs.github.com/spec/v1` header Git LFS writes in place
of a not-yet-fetched object) is detected; a file that merely starts like a
real binary blob is not.

Deliberately does not read the actual `assets/final/lora/*.safetensors`
committed in this repo -- whether that file is a real blob or a pointer
depends on whether the environment running these tests fetched LFS objects,
which is exactly the ambiguity this test must not depend on. Both cases are
built from synthetic bytes instead.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

from tests.lfs_pointer import is_lfs_pointer


def _fake_safetensors_bytes() -> bytes:
    """A structurally-real (if minimal) safetensors byte layout: an 8-byte
    little-endian header-length prefix, that many bytes of header JSON, then
    the tensor payload it describes -- see
    https://github.com/huggingface/safetensors#format."""
    header = {"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
    header_bytes = json.dumps(header).encode()
    return struct.pack("<Q", len(header_bytes)) + header_bytes + b"\x00\x00\x00\x00"


def test_lfs_pointer_file_is_detected(tmp_path: Path) -> None:
    pointer = tmp_path / "player_identity_v1.safetensors"
    pointer.write_bytes(
        b"version https://git-lfs.github.com/spec/v1\n"
        b"oid sha256:" + b"0" * 64 + b"\n" + b"size 151097032\n"
    )
    assert is_lfs_pointer(pointer) is True


def test_real_safetensors_bytes_are_not_a_pointer(tmp_path: Path) -> None:
    real = tmp_path / "player_identity_v1.safetensors"
    real.write_bytes(_fake_safetensors_bytes())
    assert is_lfs_pointer(real) is False


def test_missing_file_is_not_a_pointer(tmp_path: Path) -> None:
    assert is_lfs_pointer(tmp_path / "does-not-exist.safetensors") is False
