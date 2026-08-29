import { promises as fs } from "node:fs";
import path from "node:path";
import { rateLimitInfoFromEvent, rateLimitInfoRejects } from "./usageLimitDetector.js";

/**
 * Utilization stand-ins for the three `rate_limit_info.status` values the `claude` CLI emits.
 *
 * The CLI's `rate_limit_event` telemetry does NOT currently carry a numeric utilization -- a live
 * run log's payload is exactly
 * `{status, resetsAt, rateLimitType, overageStatus, overageDisabledReason, isUsingOverage}`
 * (captured verbatim from `tasks/.runs/T-0248-*.jsonl` on 2026-08-29). `status` is therefore the
 * only usage signal actually available, and these constants map it onto the same 0..1 scale a
 * real utilization would use, so `AUTO_LAUNCH_USAGE_MAX` compares against one thing either way.
 * If a future CLI version starts emitting a real number, `utilizationFromRateLimitInfo` prefers
 * it and these become dead weight rather than wrong.
 *
 * `allowed_warning` is pinned at 0.9 rather than "always blocking": the CLI only warns when the
 * window is genuinely near its cap, so it must sit above the 0.80 default, but an operator who
 * deliberately raises the threshold to 0.95 should still get launches during a warning.
 */
export const ALLOWED_UTILIZATION = 0;
export const WARNING_UTILIZATION = 0.9;
export const REJECTED_UTILIZATION = 1;

const STATUS_UTILIZATION = new Map([
  ["allowed", ALLOWED_UTILIZATION],
  ["allowed_warning", WARNING_UTILIZATION],
  ["rejected", REJECTED_UTILIZATION]
]);

/**
 * How much of a run log's tail to read when hunting for the newest `rate_limit_event`. A live log
 * reaches tens of megabytes (13 MB and growing, on the T-0248 run this was built against), and
 * the poller re-reads on every tick -- so this reads the end of the file rather than parsing the
 * whole thing. The CLI emits a `rate_limit_event` roughly once per assistant turn, so 256 KB of
 * tail covers many turns' worth of events even on a chatty run.
 */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

/** Cap on how many run logs to fall through before giving up and reporting usage as undetermined. */
export const DEFAULT_MAX_LOGS_SCANNED = 5;

function numericUtilization(info) {
  const raw = info.utilization;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

/**
 * Reads a `rate_limit_info` payload as a 0..1 utilization of the current limit window, or `null`
 * when it says nothing usable (a status this code has never seen -- deliberately *not* guessed
 * at, so the caller can skip rather than launch on a misread signal).
 *
 * `resetsAt` (unix seconds) is checked first and overrides everything else: once that instant has
 * passed, the window the event describes is over. Whatever pressure it recorded -- up to and
 * including a hard `rejected` -- belongs to a window that no longer exists, and the fresh one it
 * rolled into has had nothing charged against it by an idle board. Reading stale telemetry as
 * still-saturated would leave the poller permanently wedged after any rate-limit stop, which is
 * the one state it most needs to recover from on its own.
 */
export function utilizationFromRateLimitInfo(info, { now = Date.now() } = {}) {
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;

  if (typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) && now >= info.resetsAt * 1000) {
    return ALLOWED_UTILIZATION;
  }

  const explicit = numericUtilization(info);
  if (explicit !== null) return explicit;

  if (rateLimitInfoRejects(info)) return REJECTED_UTILIZATION;

  const byStatus = STATUS_UTILIZATION.get(info.status);
  return byStatus === undefined ? null : byStatus;
}

/**
 * Reads the last `tailBytes` of a file and returns its complete lines. The first line of a
 * partial read is dropped -- it is almost certainly a fragment of an NDJSON record that started
 * before the read offset, and a fragment parses as garbage rather than as anything meaningful.
 */
async function readTailLines(filePath, tailBytes, openFn) {
  const handle = await openFn(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return [];
    const length = Math.min(size, tailBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

function lastRateLimitInfoIn(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const info = rateLimitInfoFromEvent(event);
    if (info) return info;
  }
  return null;
}

/**
 * Finds the newest `rate_limit_info` payload the runner has recorded, by walking
 * `tasks/.runs/*.jsonl` newest-mtime-first and reading each log's tail. Returns
 * `{info, logPath, mtimeMs}`, or `null` when no telemetry is reachable.
 *
 * Falls through to the next-newest log when a log has no telemetry in its tail (a zero-byte log
 * from a run that died on spawn, a short log from a run that never got an assistant turn), up to
 * `maxLogsScanned` files. A missing runs directory means nothing has ever run: `null`, not an
 * error.
 */
export async function readNewestRateLimitInfo({
  runsDir,
  tailBytes = DEFAULT_TAIL_BYTES,
  maxLogsScanned = DEFAULT_MAX_LOGS_SCANNED,
  readdirFn = fs.readdir,
  statFn = fs.stat,
  openFn = fs.open
} = {}) {
  let entries;
  try {
    entries = await readdirFn(runsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }

  const logs = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = path.join(runsDir, name);
    try {
      const stat = await statFn(filePath);
      logs.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // Rotated or deleted between readdir and stat -- nothing to read.
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const log of logs.slice(0, maxLogsScanned)) {
    let info = null;
    try {
      info = lastRateLimitInfoIn(await readTailLines(log.filePath, tailBytes, openFn));
    } catch {
      continue;
    }
    if (info) return { info, logPath: log.filePath, mtimeMs: log.mtimeMs };
  }
  return null;
}

/**
 * The auto-launch poller's usage gate input: `{utilization, status, logPath, reason}`, where a
 * `null` utilization means "could not be determined" and `reason` is a human-readable line for
 * the tick log. Never throws -- an unreadable runs directory is an undetermined reading, and the
 * poller's fail-safe contract turns that into a skipped tick, so an I/O error must not be able
 * to short-circuit into "no signal, therefore fine".
 */
export async function readUsageSnapshot({ runsDir, now = Date.now(), ...ioOverrides } = {}) {
  let newest;
  try {
    newest = await readNewestRateLimitInfo({ runsDir, ...ioOverrides });
  } catch (err) {
    return { utilization: null, status: null, logPath: null, reason: `rate-limit telemetry unreadable: ${err.message}` };
  }

  if (!newest) {
    return {
      utilization: null,
      status: null,
      logPath: null,
      reason: `no rate-limit telemetry found in ${runsDir}/*.jsonl`
    };
  }

  const status = typeof newest.info.status === "string" ? newest.info.status : null;
  const utilization = utilizationFromRateLimitInfo(newest.info, { now });
  const reason =
    utilization === null
      ? `unrecognized rate-limit status "${status}" in ${newest.logPath}`
      : `status=${status} utilization=${utilization} (${newest.logPath})`;

  return { utilization, status, logPath: newest.logPath, reason };
}
