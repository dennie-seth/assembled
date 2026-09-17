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


_VERSION_LINE = b"version https://git-lfs.github.com/spec/v1"
_VALID_OID_LINE = b"oid sha256:" + b"0" * 64
_VALID_SIZE_LINE = b"size 151097032"


def _write(tmp_path: Path, data: bytes) -> Path:
    path = tmp_path / "player_identity_v1.safetensors"
    path.write_bytes(data)
    return path


def test_header_only_no_newline_is_not_a_pointer(tmp_path: Path) -> None:
    """Codex review 2026-09-17: a header with no newline, no oid, no size is
    a truncated/corrupt file, not a genuine un-fetched pointer -- it must not
    be treated as one, or a real data problem would silently skip instead of
    failing."""
    assert is_lfs_pointer(_write(tmp_path, _VERSION_LINE)) is False


def test_header_plus_newline_only_is_not_a_pointer(tmp_path: Path) -> None:
    assert is_lfs_pointer(_write(tmp_path, _VERSION_LINE + b"\n")) is False


def test_missing_oid_is_not_a_pointer(tmp_path: Path) -> None:
    data = _VERSION_LINE + b"\n" + _VALID_SIZE_LINE + b"\n"
    assert is_lfs_pointer(_write(tmp_path, data)) is False


def test_oid_not_64_hex_is_not_a_pointer(tmp_path: Path) -> None:
    data = _VERSION_LINE + b"\n" + b"oid sha256:deadbeef\n" + _VALID_SIZE_LINE + b"\n"
    assert is_lfs_pointer(_write(tmp_path, data)) is False


def test_oid_not_sha256_is_not_a_pointer(tmp_path: Path) -> None:
    data = _VERSION_LINE + b"\n" + b"oid md5:" + b"0" * 64 + b"\n" + _VALID_SIZE_LINE + b"\n"
    assert is_lfs_pointer(_write(tmp_path, data)) is False


def test_missing_size_is_not_a_pointer(tmp_path: Path) -> None:
    data = _VERSION_LINE + b"\n" + _VALID_OID_LINE + b"\n"
    assert is_lfs_pointer(_write(tmp_path, data)) is False


def test_non_integer_size_is_not_a_pointer(tmp_path: Path) -> None:
    data = _VERSION_LINE + b"\n" + _VALID_OID_LINE + b"\n" + b"size not-a-number\n"
    assert is_lfs_pointer(_write(tmp_path, data)) is False


def test_oversized_file_starting_with_header_is_not_a_pointer(tmp_path: Path) -> None:
    """A real (large) file that happens to start with the pointer header
    text must never be mistaken for a pointer -- pointer files are always
    well under 1 KB."""
    data = _VERSION_LINE + b"\n" + _VALID_OID_LINE + b"\n" + _VALID_SIZE_LINE + b"\n"
    data += b"\x00" * (2 * 1024 * 1024)
    assert is_lfs_pointer(_write(tmp_path, data)) is False


def test_well_formed_pointer_is_detected(tmp_path: Path) -> None:
    data = _VERSION_LINE + b"\n" + _VALID_OID_LINE + b"\n" + _VALID_SIZE_LINE + b"\n"
    assert is_lfs_pointer(_write(tmp_path, data)) is True
