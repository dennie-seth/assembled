"""Checkpoint file hashing for provenance (T-0151).

PLAN.md §0 requires model + license + prompt + seed in every provenance
record; a null model_hash means the exact weights that produced an asset
cannot be proven.  This module provides the utility that computes SHA-256
of a checkpoint file at generation time so the hash travels with the
output from the moment it is created.

Usage in the pipeline (see pipeline.generate)::

    from comfy_client.checkpoint_hash import hash_checkpoint_file
    model_hash = hash_checkpoint_file(Path(checkpoint_dir) / recipe.checkpoint)
"""

from __future__ import annotations

import hashlib
from pathlib import Path

_CHUNK = 8 * 1024 * 1024  # 8 MiB -- keeps memory flat on large safetensors


def hash_checkpoint_file(path: Path | str) -> str:
    """Return the SHA-256 hex digest of the checkpoint file at *path*.

    Reads in 8 MiB chunks so SDXL-sized files (~7 GB) don't require
    loading the whole model into memory.

    Raises:
        FileNotFoundError: if *path* does not exist.
    """
    p = Path(path)
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()
