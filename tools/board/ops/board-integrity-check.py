#!/usr/bin/env python3
"""
Read-only integrity checker for the assembled board running in db-store mode
(BOARD_TASK_STORE=db). Verifies DB<->API agreement, attachment integrity in
both directions, SQLite health, backup restorability, and staged-export
freshness against the live board at ~/.local/share/assembled-board/.

Strictly read-only against live data: opens board.db with a `mode=ro` URI
connection, never writes under the attachments dir, and never touches the
board service or its source. The only write this script performs is a
scratch copy of the latest backup file into a tempfile.mkdtemp() dir for the
backup-restore check, which is removed before exit even on failure.

Exit code is 0 unless a HARD check (DB<->API agreement, attachment bytes
missing, SQLite health, backup restorability) reports FAIL. Pipeline
freshness (check 5) is WARN-only by design: index.json's task_count only
counts cards with staged attachments, and depends on the hourly
board-assets-sync timer having run recently.
"""
import json
import os
import random
import shutil
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

HOME = Path.home()

API_BASE = os.environ.get("BOARD_API_BASE", "http://127.0.0.1:4173").rstrip("/")
API_TIMEOUT = float(os.environ.get("BOARD_API_TIMEOUT", "15"))

DB_PATH = Path(os.environ.get("BOARD_DB_PATH", str(HOME / ".local" / "share" / "assembled-board" / "board.db")))
DATA_DIR = DB_PATH.parent
ATTACHMENTS_DIR = Path(os.environ.get("BOARD_ATTACHMENTS_DIR", str(DATA_DIR / "attachments")))
BACKUPS_DIR = Path(os.environ.get("BOARD_BACKUPS_DIR", str(DATA_DIR / "backups")))

EXPORT_ROOT = Path(os.environ.get("BOARD_ASSETS_EXPORT_ROOT", "/mnt/f/PetProjects/board-assets-export"))

SAMPLE_SIZE = int(os.environ.get("INTEGRITY_SAMPLE_SIZE", "15"))
FRESHNESS_MAX_AGE_HOURS = float(os.environ.get("INTEGRITY_FRESHNESS_MAX_AGE_HOURS", "2"))
BACKUP_DELTA_MIN = int(os.environ.get("INTEGRITY_BACKUP_DELTA_MIN", "10"))
BACKUP_DELTA_PCT = float(os.environ.get("INTEGRITY_BACKUP_DELTA_PCT", "0.1"))

LOG_DIR = Path(os.environ.get("INTEGRITY_LOG_DIR", str(HOME / ".local" / "state" / "board-integrity-check")))
LOG_FILE = LOG_DIR / "check.log"

CORE_FIELDS = [
    "title", "status", "priority", "phase", "agent", "created",
    "branch", "commit", "pr", "deliverable_type", "attempts", "body",
]

_log_fh = None


def log(msg):
    line = f"[integrity] {msg}"
    print(line, file=sys.stderr)
    if _log_fh:
        _log_fh.write(line + "\n")
        _log_fh.flush()


class CheckResult:
    def __init__(self, name, status, summary, details=None):
        self.name = name
        self.status = status  # PASS | WARN | FAIL
        self.summary = summary
        self.details = details or []


def open_db_readonly(path: Path):
    uri = f"file:{path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=10)
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def api_get(path):
    return requests.get(f"{API_BASE}{path}", timeout=API_TIMEOUT)


def check_db_api_agreement():
    name = "db_api_agreement"
    try:
        conn = open_db_readonly(DB_PATH)
    except Exception as e:
        return CheckResult(name, "FAIL", f"could not open db read-only: {e}")

    try:
        db_count = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        db_ids = [r[0] for r in conn.execute("SELECT id FROM tasks ORDER BY id").fetchall()]

        try:
            resp = api_get("/api/tasks")
        except requests.exceptions.RequestException as e:
            return CheckResult(name, "FAIL", f"GET /api/tasks failed: {e}")
        if resp.status_code != 200:
            return CheckResult(name, "FAIL", f"GET /api/tasks returned HTTP {resp.status_code}")
        api_tasks = resp.json()
        api_count = len(api_tasks)

        details = [f"db tasks={db_count}, api tasks={api_count}"]
        if db_count != api_count:
            return CheckResult(name, "FAIL", f"count mismatch: db={db_count} api={api_count}", details)

        sample_ids = random.sample(db_ids, min(SAMPLE_SIZE, len(db_ids)))
        mismatches = []
        fetch_errors = []
        for tid in sample_ids:
            row = conn.execute(
                "SELECT title, status, priority, phase, agent, created, branch, "
                'commit_sha AS "commit", pr, deliverable_type, attempts, body '
                "FROM tasks WHERE id = ?",
                (tid,),
            ).fetchone()
            expected = dict(zip(CORE_FIELDS, row))
            try:
                r = api_get(f"/api/tasks/{tid}")
            except requests.exceptions.RequestException as e:
                fetch_errors.append(f"{tid}: request failed: {e}")
                continue
            if r.status_code != 200:
                fetch_errors.append(f"{tid}: HTTP {r.status_code}")
                continue
            actual = r.json()
            for field in CORE_FIELDS:
                if actual.get(field) != expected[field]:
                    mismatches.append(f"{tid}.{field}: db={expected[field]!r} api={actual.get(field)!r}")

        details.append(f"sampled {len(sample_ids)}/{db_count} ids individually via GET /api/tasks/:id")
        details.extend(f"FETCH ERROR: {e}" for e in fetch_errors)
        details.extend(f"MISMATCH: {m}" for m in mismatches)

        if fetch_errors or mismatches:
            return CheckResult(
                name, "FAIL",
                f"{len(fetch_errors)} fetch errors, {len(mismatches)} field mismatches across {len(sample_ids)} sampled ids",
                details,
            )
        return CheckResult(
            name, "PASS",
            f"db/api counts match ({db_count}), {len(sample_ids)} sampled ids verified field-for-field",
            details,
        )
    finally:
        conn.close()


def check_attachments():
    name = "attachment_integrity"
    try:
        conn = open_db_readonly(DB_PATH)
        rows = conn.execute("SELECT task_id, filename, size FROM attachments").fetchall()
    except Exception as e:
        return CheckResult(name, "FAIL", f"could not read attachments table: {e}")
    finally:
        conn.close()

    missing = []
    for task_id, filename, size in rows:
        p = ATTACHMENTS_DIR / task_id / filename
        if not p.is_file():
            missing.append(f"{task_id}/{filename}: no file on disk at {p}")
        elif p.stat().st_size != size:
            missing.append(f"{task_id}/{filename}: size mismatch (db={size} disk={p.stat().st_size})")

    db_set = {(t, f) for t, f, _s in rows}
    disk_files = []
    if ATTACHMENTS_DIR.is_dir():
        for task_dir in sorted(ATTACHMENTS_DIR.iterdir()):
            if not task_dir.is_dir():
                continue
            for f in sorted(task_dir.iterdir()):
                if f.is_file():
                    disk_files.append((task_dir.name, f.name))
    orphans = sorted(set(disk_files) - db_set)

    details = [
        f"attachments root: {ATTACHMENTS_DIR}",
        f"db rows={len(rows)}, disk files={len(disk_files)}",
        f"missing/corrupt bytes={len(missing)}, orphaned files={len(orphans)}",
    ]
    details.extend(f"MISSING: {m}" for m in missing[:20])
    details.extend(f"ORPHAN: {t}/{f}" for t, f in orphans[:20])

    if missing:
        return CheckResult(name, "FAIL", f"{len(missing)} attachment rows missing/corrupt bytes on disk", details)
    if orphans:
        return CheckResult(name, "WARN", f"{len(orphans)} orphaned files on disk with no DB row", details)
    return CheckResult(name, "PASS", f"{len(rows)} attachment rows verified against disk, no orphans", details)


def check_sqlite_health():
    name = "sqlite_health"
    try:
        conn = open_db_readonly(DB_PATH)
    except Exception as e:
        return CheckResult(name, "FAIL", f"could not open db read-only: {e}")

    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchall()
        fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    finally:
        conn.close()

    integrity_ok = len(integrity) == 1 and integrity[0][0] == "ok"
    details = [
        f"integrity_check: {[r[0] for r in integrity]}",
        f"foreign_key_check violations: {len(fk)}",
    ]
    details.extend(f"FK VIOLATION: {r}" for r in fk[:20])

    if not integrity_ok:
        return CheckResult(name, "FAIL", "PRAGMA integrity_check reported problems", details)
    if fk:
        return CheckResult(name, "FAIL", f"{len(fk)} foreign_key_check violations", details)
    return CheckResult(name, "PASS", "integrity_check=ok, no foreign key violations", details)


def check_backup():
    name = "backup_restorability"
    if not BACKUPS_DIR.is_dir():
        return CheckResult(
            name, "WARN",
            f"no backups dir at {BACKUPS_DIR}; scripts/backupDb.js has not been run yet",
        )
    backups = sorted(BACKUPS_DIR.glob("board-*.db"))
    if not backups:
        return CheckResult(name, "WARN", f"no backup files found under {BACKUPS_DIR}")
    latest = backups[-1]

    try:
        live_conn = open_db_readonly(DB_PATH)
        live_count = live_conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    finally:
        live_conn.close()

    tmp_dir = tempfile.mkdtemp(prefix="board-integrity-backup-")
    try:
        tmp_copy = Path(tmp_dir) / latest.name
        shutil.copy2(latest, tmp_copy)
        # backupDb.js uses better-sqlite3's online backup API, which produces a single
        # plain file with no -wal/-shm sidecars -- but copy them too if somehow present.
        for suffix in ("-wal", "-shm"):
            sib = latest.with_name(latest.name + suffix)
            if sib.exists():
                shutil.copy2(sib, Path(tmp_dir) / sib.name)

        conn = sqlite3.connect(str(tmp_copy))
        try:
            integrity = conn.execute("PRAGMA integrity_check").fetchall()
            backup_count = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        finally:
            conn.close()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    integrity_ok = len(integrity) == 1 and integrity[0][0] == "ok"
    age_hours = (time.time() - latest.stat().st_mtime) / 3600
    delta = abs(live_count - backup_count)
    allowed_delta = max(BACKUP_DELTA_MIN, round(live_count * BACKUP_DELTA_PCT))

    details = [
        f"latest backup: {latest.name} (age {age_hours:.1f}h)",
        f"backup integrity_check: {[r[0] for r in integrity]}",
        f"backup tasks={backup_count}, live tasks={live_count}, delta={delta} (allowed {allowed_delta})",
    ]

    if not integrity_ok:
        return CheckResult(name, "FAIL", f"backup {latest.name} failed integrity_check", details)
    if delta > allowed_delta:
        return CheckResult(
            name, "FAIL",
            f"backup task count diverges from live by {delta} (> allowed {allowed_delta})",
            details,
        )
    return CheckResult(
        name, "PASS",
        f"backup {latest.name} restored to scratch copy, integrity ok, count within delta ({delta} <= {allowed_delta})",
        details,
    )


def check_pipeline_freshness():
    name = "pipeline_freshness"
    index_path = EXPORT_ROOT / "index.json"
    if not index_path.is_file():
        return CheckResult(name, "WARN", f"no index.json found at {index_path}")

    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as e:
        return CheckResult(name, "WARN", f"could not parse {index_path}: {e}")

    age_hours = (time.time() - index_path.stat().st_mtime) / 3600
    staged_task_count = index.get("totals", {}).get("task_count")

    try:
        resp = api_get("/api/tasks")
        resp.raise_for_status()
        api_tasks = resp.json()
        live_with_attachments = sum(1 for t in api_tasks if t.get("attachments"))
    except Exception as e:
        return CheckResult(name, "WARN", f"could not verify index.json against live API: {e}")

    details = [
        f"index.json: {index_path}",
        f"index.json totals.task_count={staged_task_count} (staged = cards with >=1 attachment)",
        f"live cards with attachments (via API)={live_with_attachments}",
        f"index.json age={age_hours:.2f}h (freshness budget {FRESHNESS_MAX_AGE_HOURS}h, hourly sync)",
    ]

    problems = []
    if staged_task_count != live_with_attachments:
        problems.append(f"task_count mismatch: index={staged_task_count} live={live_with_attachments}")
    if age_hours > FRESHNESS_MAX_AGE_HOURS:
        problems.append(f"index.json is {age_hours:.2f}h old (> {FRESHNESS_MAX_AGE_HOURS}h budget)")

    if problems:
        return CheckResult(name, "WARN", "; ".join(problems), details)
    return CheckResult(name, "PASS", f"index.json fresh ({age_hours:.2f}h) and task_count matches live", details)


CHECKS = [
    check_db_api_agreement,
    check_attachments,
    check_sqlite_health,
    check_backup,
    check_pipeline_freshness,
]


def main():
    global _log_fh
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _log_fh = open(LOG_FILE, "a", encoding="utf-8")

    log(f"=== run {datetime.now(timezone.utc).isoformat(timespec='seconds')} ===")
    log(f"API_BASE={API_BASE} DB_PATH={DB_PATH} ATTACHMENTS_DIR={ATTACHMENTS_DIR} "
        f"BACKUPS_DIR={BACKUPS_DIR} EXPORT_ROOT={EXPORT_ROOT}")

    results = []
    for check in CHECKS:
        try:
            result = check()
        except Exception as e:
            result = CheckResult(check.__name__, "FAIL", f"check crashed: {e!r}")
        results.append(result)
        log(f"{result.status:5s} {result.name}: {result.summary}")
        for d in result.details:
            log(f"    {d}")

    width = max(len(r.name) for r in results)
    log("--- summary ---")
    for r in results:
        log(f"{r.status:5s} {r.name.ljust(width)}  {r.summary}")

    hard_fail = any(r.status == "FAIL" for r in results)
    log(f"=== run done, {'FAIL present -> exit 1' if hard_fail else 'exit 0'} ===")
    _log_fh.close()
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
