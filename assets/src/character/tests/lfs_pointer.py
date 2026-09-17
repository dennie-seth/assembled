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

Codex review (2026-09-17): a genuine pointer is trusted only when it is a
*complete, well-formed* pointer per the Git LFS spec
(https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md) -- exact version
line, a 64-hex-char `oid sha256:` line, an integer `size` line, all
newline-terminated, and a pointer-sized file. A header-only or otherwise
truncated/malformed file is not a pointer -- it's a corrupt weights file,
and callers must let it fail like any other bad data instead of skipping.
"""

from __future__ import annotations

import re
from pathlib import Path

LFS_POINTER_HEADER = b"version https://git-lfs.github.com/spec/v1"

# A real Git LFS pointer file is always tiny (the spec caps it at 1024
# bytes); anything larger cannot be one, no matter how it starts.
_POINTER_MAX_BYTES = 1024

_OID_LINE_RE = re.compile(rb"^oid sha256:[0-9a-f]{64}$")
_SIZE_LINE_RE = re.compile(rb"^size [0-9]+$")


def is_lfs_pointer(path: Path) -> bool:
    """True if `path` is a complete, well-formed, un-fetched Git LFS
    pointer, not the real file.

    A missing file is not a pointer -- callers that need "does this file
    exist" semantics keep their own existence assertion; this only answers
    "if it exists, is it a pointer or the real blob." Likewise, a file that
    merely *starts* with the pointer header but is truncated, malformed, or
    too large is not a pointer either -- it's corrupt or real data, and must
    be allowed to fail like any other bad file rather than being skipped.
    """
    try:
        if path.stat().st_size > _POINTER_MAX_BYTES:
            return False
        data = path.read_bytes()
    except OSError:
        return False

    if not data.endswith(b"\n"):
        return False
    lines = data.split(b"\n")[:-1]  # drop the trailing empty element from the final \n
    if len(lines) != 3:
        return False
    version_line, oid_line, size_line = lines
    if version_line != LFS_POINTER_HEADER:
        return False
    if not _OID_LINE_RE.match(oid_line):
        return False
    if not _SIZE_LINE_RE.match(size_line):
        return False
    return True
