#!/usr/bin/env python3
"""
Resolve/create the taskDir -> Google Drive folder ID mapping used to push
staged board assets to their per-task Drive subfolder.

Idempotent by construction: before creating a subfolder for a task dir, it
first lists existing subfolders under the parent by name. A folder is only
created if no subfolder with that exact name is already there. The mapping
file is the primary guard (a task already in the map is never re-resolved),
and the by-name lookup is a second guard against duplicate creation if a
previous run crashed after mkdir but before the mapping got saved.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

EXPORT_ROOT = Path(os.environ.get("BOARD_ASSETS_EXPORT_ROOT", "/mnt/f/PetProjects/board-assets-export"))
MAP_FILE = EXPORT_ROOT / ".drive-folders.json"
PARENT_FOLDER_ID = "1yEjRSDejrimg0KBUxbS8S4InQZYFATKW"
RCLONE = str(Path.home() / ".local" / "bin" / "rclone")
RESERVED_DIRNAMES = {"_rclone_logs", ".stage-tmp"}

SEED_MAP = {
    "T-0072": "1LykgKD8W2MGfLC1X6-r0IMMSjqoq4f1X",
    "T-0073": "1wKOJzeCwcLLXpo8pP9VDh1x18bBjZ07c",
    "T-0104": "1nqhRstPWV1i4OMRtmMpbUJeL8yluQk1F",
    "T-0105": "1zFxZBSWzUel4nGOJhIoxU3KqD8zJR8a_",
    "T-0106": "1SI_6i0GhJnIpVaPZeNDvczJeGHEj5zJq",
    "T-0070": "132-7rvF7_2xB_kNIjZDDvsh3cDKx7lla",
    "T-0080": "1aldGjhPoEg7vGzdLQzxfURntlmEdAi_g",
    "T-0081": "1j4jMahl7szc5EUQUn7srS_z_kw9FoTFF",
    "T-0099": "1O8ioAHRUm1epXY7ZSWcS6imjhwkPMn3w",
    "UNTRACKED-keyart": "1ydYaZLVuXT0aJmGZPDTq2XHuyK_PdQOZ",
}


def log(msg):
    print(f"[drivemap] {msg}", file=sys.stderr)


def load_map():
    if MAP_FILE.exists():
        return json.loads(MAP_FILE.read_text(encoding="utf-8"))
    return dict(SEED_MAP)


def save_map(m):
    tmp = MAP_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(m, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(MAP_FILE)


def list_parent_subfolders():
    out = subprocess.run(
        [RCLONE, "lsjson", "gdrive:", "--drive-root-folder-id", PARENT_FOLDER_ID, "--dirs-only"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        log(f"ERROR: rclone lsjson failed: {out.stderr.strip()}")
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return []


def folder_name_for(task_dir_name, index_tasks_by_id):
    entry = index_tasks_by_id.get(task_dir_name)
    title = entry["cardTitle"] if entry and entry.get("cardTitle") else task_dir_name
    title = re.sub(r"\s+", " ", title).strip()
    if len(title) > 60:
        title = title[:57] + "..."
    return f"{task_dir_name} — {title}" if title != task_dir_name else task_dir_name


def create_subfolder(name):
    r = subprocess.run(
        [RCLONE, "mkdir", f"gdrive:{name}", "--drive-root-folder-id", PARENT_FOLDER_ID],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        log(f"ERROR: rclone mkdir failed for '{name}': {r.stderr.strip()}")
        return False
    return True


def main():
    if not EXPORT_ROOT.is_dir():
        log(f"ERROR: {EXPORT_ROOT} not found, nothing to map")
        sys.exit(1)

    mapping = load_map()

    task_dirs = sorted(
        p.name for p in EXPORT_ROOT.iterdir()
        if p.is_dir() and not p.name.startswith(".") and p.name not in RESERVED_DIRNAMES
    )
    missing = [t for t in task_dirs if t not in mapping]
    if not missing:
        log("all staged task dirs already mapped, nothing to create")
        save_map(mapping)  # normalize formatting / merge any seed additions
        return

    index_tasks_by_id = {}
    index_path = EXPORT_ROOT / "index.json"
    if index_path.exists():
        try:
            idx = json.loads(index_path.read_text(encoding="utf-8"))
            index_tasks_by_id = {t["taskId"]: t for t in idx.get("tasks", [])}
        except (json.JSONDecodeError, KeyError):
            pass

    existing_remote = list_parent_subfolders()
    if existing_remote is None:
        log("ERROR: could not list Drive parent folder, skipping folder creation this run")
        return
    by_name = {f["Name"]: f["ID"] for f in existing_remote}

    for tid in missing:
        name = folder_name_for(tid, index_tasks_by_id)
        if name in by_name:
            log(f"{tid}: found existing Drive folder '{name}' by name, reusing (no new folder created)")
            mapping[tid] = by_name[name]
            save_map(mapping)
            continue
        log(f"{tid}: creating Drive folder '{name}'")
        if not create_subfolder(name):
            continue
        refreshed = list_parent_subfolders()
        if refreshed is None:
            log(f"ERROR: created '{name}' but could not re-list to fetch its ID; will retry next run")
            continue
        found = next((f["ID"] for f in refreshed if f["Name"] == name), None)
        if not found:
            log(f"ERROR: created '{name}' but could not find it in the re-listed folders; will retry next run")
            continue
        mapping[tid] = found
        save_map(mapping)
        log(f"{tid}: mapped to Drive folder {found}")


if __name__ == "__main__":
    main()
