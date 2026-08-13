#!/usr/bin/env python3
"""Backfill model_hash in provenance sidecar files (T-0151).

Scans a directory tree for ``*.provenance.json`` files whose ``model_hash``
field is null, hashes the corresponding checkpoint from ``checkpoint_dir``,
and writes the hash in-place.

Usage (from the repo root, with the venv activated)::

    python tools/comfy-client/scripts/backfill_model_hash.py \\
        --checkpoint-dir /mnt/f/ComfyUI/models/checkpoints \\
        --scan-dir assets

This is a one-time fix for assets generated before T-0151 added the
hashing requirement.  All future generation via ``pipeline.generate()``
or ``concept.generate_concept()`` will populate the hash automatically.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add the comfy_client src to sys.path so we can import checkpoint_hash
# without requiring the package to be installed.
_SCRIPT_DIR = Path(__file__).resolve().parent
_SRC = _SCRIPT_DIR.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from comfy_client.checkpoint_hash import hash_checkpoint_file  # noqa: E402


def backfill(checkpoint_dir: Path, scan_dir: Path, dry_run: bool = False) -> int:
    provenance_files = sorted(scan_dir.rglob("*.provenance.json"))
    updated = 0
    skipped = 0
    errors = 0

    for prov_path in provenance_files:
        prov = json.loads(prov_path.read_text())

        if prov.get("model_hash"):
            skipped += 1
            continue

        model_name = prov.get("model")
        if not model_name:
            print(f"  SKIP {prov_path} -- no 'model' field", file=sys.stderr)
            skipped += 1
            continue

        ckpt_path = checkpoint_dir / model_name
        if not ckpt_path.exists():
            print(f"  ERROR {prov_path} -- checkpoint not found: {ckpt_path}", file=sys.stderr)
            errors += 1
            continue

        print(f"  hashing {ckpt_path} ...")
        model_hash = hash_checkpoint_file(ckpt_path)
        print(f"    -> {model_hash}")

        prov["model_hash"] = model_hash

        if dry_run:
            print(f"  DRY-RUN would update {prov_path}")
        else:
            prov_path.write_text(json.dumps(prov, indent=2) + "\n")
            print(f"  updated {prov_path}")

        updated += 1

    print(f"\nDone: {updated} updated, {skipped} skipped, {errors} errors.")
    return 1 if errors else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint-dir",
        required=True,
        type=Path,
        help="Directory containing checkpoint files (e.g. /mnt/f/ComfyUI/models/checkpoints)",
    )
    parser.add_argument(
        "--scan-dir",
        default=Path("assets"),
        type=Path,
        help="Root directory to scan for *.provenance.json (default: assets/)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be done without writing any files",
    )
    args = parser.parse_args(argv)
    return backfill(
        checkpoint_dir=args.checkpoint_dir,
        scan_dir=args.scan_dir,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    sys.exit(main())
