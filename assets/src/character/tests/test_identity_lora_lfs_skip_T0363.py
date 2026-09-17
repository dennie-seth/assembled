"""T-0363 CI fix round: the LoRA identity-weight tests must skip -- not
fail -- when the weights file they read is an un-fetched Git LFS pointer,
and must behave exactly as before when it is a real file.

Exercises `test_identity_lora_training_T0229.py` (the same shape as the
T-0248 and profile_T0274 siblings) as a subprocess against a temporary
repo copy, the same technique `test_conftest_no_synthesis_T0363.py` uses,
so the two tests under check run for real against a real file on disk
instead of being reasoned about in the abstract.

RED state: `test_weights_file_is_valid_safetensors` /
`test_weights_hash_matches_provenance` read `WEIGHTS_PATH` unconditionally
-> a pointer file makes them ERROR (struct/MemoryError) or FAIL (hash
mismatch), not SKIP.
GREEN state: both SKIP with a message naming the pointer path when it's a
pointer, PASS when it's a real file with a matching hash, and FAIL (not
skipped) when it's a real file with a wrong hash.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

_CHAR_TESTS_DIR = Path(__file__).resolve().parent
_TEST_MODULE_NAME = "test_identity_lora_training_T0229.py"
_NODE_IDS = (
    f"{_TEST_MODULE_NAME}::test_weights_file_is_valid_safetensors",
    f"{_TEST_MODULE_NAME}::test_weights_hash_matches_provenance",
)

_POINTER_BYTES = (
    b"version https://git-lfs.github.com/spec/v1\n"
    b"oid sha256:" + b"0" * 64 + b"\n" + b"size 151097032\n"
)


def _fake_safetensors_bytes() -> bytes:
    header = {"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
    header_bytes = json.dumps(header).encode()
    return struct.pack("<Q", len(header_bytes)) + header_bytes + b"\x00\x00\x00\x00"


def _build_temp_repo(tmp_path: Path, *, weights_bytes: bytes, weights_hash: str) -> Path:
    root = tmp_path / "repo"
    tests_dst = root / "assets" / "src" / "character" / "tests"
    tests_dst.mkdir(parents=True)
    for name in ("conftest.py", "__init__.py", "lfs_pointer.py", _TEST_MODULE_NAME):
        shutil.copy2(_CHAR_TESTS_DIR / name, tests_dst / name)

    lora_dir = root / "assets" / "final" / "lora"
    lora_dir.mkdir(parents=True)
    (lora_dir / "player_identity_v1.safetensors").write_bytes(weights_bytes)
    (lora_dir / "player_identity_v1.provenance.json").write_text(
        json.dumps({"weights_hash": weights_hash})
    )

    return root


def _run_pytest_in(root: Path) -> subprocess.CompletedProcess[str]:
    test_dir = root / "assets" / "src" / "character" / "tests"
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-rs", *_NODE_IDS],
        cwd=test_dir,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_pointer_weights_file_skips_with_clear_reason(tmp_path: Path) -> None:
    root = _build_temp_repo(tmp_path, weights_bytes=_POINTER_BYTES, weights_hash="unused")

    result = _run_pytest_in(root)

    combined = result.stdout + result.stderr
    assert "2 skipped" in combined, f"expected both tests to skip, got:\n{combined}"
    assert "player_identity_v1.safetensors" in combined, (
        f"expected the skip reason to name the pointer file, got:\n{combined}"
    )


def test_real_weights_file_runs_and_passes_as_before(tmp_path: Path) -> None:
    real_bytes = _fake_safetensors_bytes()
    real_hash = hashlib.sha256(real_bytes).hexdigest()
    root = _build_temp_repo(tmp_path, weights_bytes=real_bytes, weights_hash=real_hash)

    result = _run_pytest_in(root)

    assert result.returncode == 0, (
        f"expected a clean pass with a real matching file, got:\n"
        f"{result.stdout}\n{result.stderr}"
    )
    combined = result.stdout + result.stderr
    assert "skipped" not in combined, f"a real file must not be treated as a pointer:\n{combined}"


def test_header_only_weights_file_still_fails(tmp_path: Path) -> None:
    """Codex review 2026-09-17: a header with no oid/size is a corrupt file,
    not a genuine un-fetched pointer -- it must FAIL like any other bad
    weights file, not silently skip."""
    root = _build_temp_repo(
        tmp_path,
        weights_bytes=b"version https://git-lfs.github.com/spec/v1",
        weights_hash="unused",
    )

    result = _run_pytest_in(root)

    combined = result.stdout + result.stderr
    assert result.returncode != 0, (
        f"a header-only file must not be treated as a pointer:\n{combined}"
    )
    assert "skipped" not in combined, f"a header-only file must not skip:\n{combined}"


def test_malformed_pointer_weights_file_still_fails(tmp_path: Path) -> None:
    """A pointer-shaped file with a bad oid must FAIL, not skip -- only a
    complete, well-formed pointer is trusted to mean "un-fetched"."""
    root = _build_temp_repo(
        tmp_path,
        weights_bytes=(
            b"version https://git-lfs.github.com/spec/v1\n"
            b"oid sha256:not-a-real-hash\n"
            b"size 151097032\n"
        ),
        weights_hash="unused",
    )

    result = _run_pytest_in(root)

    combined = result.stdout + result.stderr
    assert result.returncode != 0, (
        f"a malformed pointer must not be treated as a genuine pointer:\n{combined}"
    )
    assert "skipped" not in combined, f"a malformed pointer must not skip:\n{combined}"


def test_real_weights_file_with_wrong_hash_still_fails(tmp_path: Path) -> None:
    real_bytes = _fake_safetensors_bytes()
    root = _build_temp_repo(tmp_path, weights_bytes=real_bytes, weights_hash="deadbeef")

    result = _run_pytest_in(root)

    assert result.returncode != 0, (
        f"expected the hash-mismatch test to fail, got a clean pass:\n"
        f"{result.stdout}\n{result.stderr}"
    )
    combined = result.stdout + result.stderr
    assert "skipped" not in combined, (
        f"a real file with a wrong hash must fail, not skip:\n{combined}"
    )
    assert "weights_hash mismatch" in combined, (
        f"expected the original mismatch message:\n{combined}"
    )
