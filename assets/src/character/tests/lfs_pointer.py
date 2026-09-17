"""T-0363 CI fix round: detect an un-fetched Git LFS pointer file.

`assets/final/lora/*.safetensors` is tracked by Git LFS (see
`.gitattributes`). A checkout that never ran `git lfs pull` -- e.g. this
package's clean-install CI job, which deliberately never fetches LFS objects
to avoid spending LFS bandwidth on every run (see `ci-character.yml`) -- sees
a small ASCII pointer file in place of the real weights blob:

    version https://git-lfs.github.com/spec/v1
    oid sha256:<...>
    size <...>

Any test that reads the *bytes* of an LFS-tracked file needs to tell that
pointer apart from the real, fetched file: reading it as a safetensors
header or hashing it against a provenance record otherwise fails with a
misleading error (a `struct.error`/`MemoryError` from parsing the pointer
text as a binary header, or a hash mismatch) that reads as a data bug
instead of "this checkout never fetched LFS objects."

Shared by every character-package test that reads an LFS-tracked file's
bytes, so the pointer signature lives in exactly one place.
"""

from __future__ import annotations

from pathlib import Path

LFS_POINTER_HEADER = b"version https://git-lfs.github.com/spec/v1"


def is_lfs_pointer(path: Path) -> bool:
    """True if `path` is an un-fetched Git LFS pointer, not the real file.

    A missing file is not a pointer -- callers that need "does this file
    exist" semantics keep their own existence assertion; this only answers
    "if it exists, is it a pointer or the real blob."
    """
    try:
        with path.open("rb") as f:
            head = f.read(len(LFS_POINTER_HEADER))
    except OSError:
        return False
    return head == LFS_POINTER_HEADER
