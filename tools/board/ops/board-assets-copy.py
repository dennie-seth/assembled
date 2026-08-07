#!/usr/bin/env python3
"""
COPY step: push every staged, mapped task dir to its Google Drive folder.
Idempotent (rclone copy only transfers new/changed files). A failure on one
task dir is logged and does not block the others.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

EXPORT_ROOT = Path(os.environ.get("BOARD_ASSETS_EXPORT_ROOT", "/mnt/f/PetProjects/board-assets-export"))
MAP_FILE = EXPORT_ROOT / ".drive-folders.json"
RCLONE = str(Path.home() / ".local" / "bin" / "rclone")


def log(msg):
    print(f"[copy] {msg}", file=sys.stderr)


def main():
    if not MAP_FILE.exists():
        log("no .drive-folders.json found, skipping copy")
        return 0

    mapping = json.loads(MAP_FILE.read_text(encoding="utf-8"))
    failures = 0
    for tid, folder_id in sorted(mapping.items()):
        src = EXPORT_ROOT / tid
        if not src.is_dir():
            log(f"skip {tid}: no local staged dir")
            continue
        r = subprocess.run(
            [RCLONE, "copy", f"{src}/", "gdrive:", "--drive-root-folder-id", folder_id,
             "--transfers", "4", "-q"],
            capture_output=True, text=True, timeout=600,
        )
        if r.returncode != 0:
            failures += 1
            log(f"ERROR copying {tid} -> {folder_id}: {r.stderr.strip()}")
        else:
            log(f"copied {tid} -> {folder_id}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
