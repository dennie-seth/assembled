import { promises as fs } from "node:fs";
import path from "node:path";
import { rateLimitInfoFromEvent } from "./usageLimitDetector.js";
import { readTailLines, readHeadLines, numericUtilization, DEFAULT_TAIL_BYTES, DEFAULT_MAX_LOGS_SCANNED } from "./usageWindow.js";

/**
 * The two `rate_limit_info.rateLimitType` values verified on live `claude` CLI telemetry (see
 * docs/usage-telemetry.md): `five_hour` was captured on 2026-08-29/09-04 runs; `seven_day` is
 * re-verified here directly against `tasks/.runs/T-0221-2026-08-23T12-26-17-498Z.jsonl:724` and
 * `tasks/.runs/T-0367-2026-09-11T22-06-33-812Z.jsonl:1`. Both are read independently -- see
 * `readUsageTelemetry` -- because the newest event in a log is sometimes the weekly one, which
 * made a "newest event wins" reader blind to 5-hour pressure and vice versa.
 */
export const WINDOW_KINDS = Object.freeze(["five_hour", "seven_day"]);

/**
 * The four classification buckets every reading falls into. `measured` and `estimated` are both
 * "fresh" (within the window's max staleness); `stale` and `unavailable` both withhold
 * `utilization` (`null`) so unknown or stale capacity can never be silently read as unlimited.
 */
export const READING_STATUS = Object.freeze({
  MEASURED: "measured",
  ESTIMATED: "estimated",
  STALE: "stale",
  UNAVAILABLE: "unavailable"
});

/**
 * Maximum acceptable staleness per window, in ms. Measured, not asserted -- see
 * docs/usage-telemetry.md's "Per-window record" table for the real tasks/.runs/*.jsonl
 * inter-event gaps this is derived from: 15 minutes for `five_hour` sits above the worst observed
 * gap (~2m20s) between consecutive readings in one session; 2 hours for `seven_day` sits above
 * both the observed within-session repeat (~5m8s) and the observed across-run gap (~1h).
 */
export const DEFAULT_MAX_STALENESS_MS = Object.freeze({
  five_hour: 15 * 60 * 1000,
  seven_day: 2 * 60 * 60 * 1000
});

function lastMatchingRateLimitInfoIn(lines, predicate) {
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
    if (info && predicate(info)) return info;
  }
  return null;
}

async function findNewestMatchingRateLimitInfo({
  runsDir,
  predicate,
  tailBytes,
  maxLogsScanned,
  readdirFn,
  statFn,
  openFn
}) {
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
      if (stat.size === 0) continue;
      logs.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // Rotated or deleted between readdir and stat -- nothing to read.
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const log of logs.slice(0, maxLogsScanned)) {
    let info = null;
    let foundVia = null;
    try {
      info = lastMatchingRateLimitInfoIn(await readTailLines(log.filePath, tailBytes, openFn), predicate);
      if (info) {
        foundVia = "tail";
      } else {
        info = lastMatchingRateLimitInfoIn(await readHeadLines(log.filePath, tailBytes, openFn), predicate);
        if (info) foundVia = "head";
      }
    } catch {
      continue;
    }
    if (info) return { info, logPath: log.filePath, observedAtMs: log.mtimeMs, foundVia };
  }
  return null;
}

function toMs(seconds) {
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : null;
}

function unavailableReading(windowKind, reason, maxStalenessMs) {
  return {
    windowKind,
    classification: READING_STATUS.UNAVAILABLE,
    utilization: null,
    status: null,
    surpassedThreshold: null,
    rateLimitType: null,
    resetsAtMs: null,
    resetsAtIso: null,
    resetElapsed: false,
    observedAtMs: null,
    ageMs: null,
    maxStalenessMs,
    logPath: null,
    foundVia: null,
    reason
  };
}

function classifyReading({ windowKind, info, observedAtMs, now, maxStalenessMs, logPath, foundVia }) {
  const ageMs = Math.max(0, now - observedAtMs);
  const stale = ageMs > maxStalenessMs;

  const status = typeof info.status === "string" ? info.status : null;
  const surpassedThreshold = typeof info.surpassedThreshold === "number" ? info.surpassedThreshold : null;
  const resetsAtMs = toMs(info.resetsAt);
  const resetElapsed = resetsAtMs !== null && now >= resetsAtMs;

  let dataKind = null;
  let utilization = null;
  const explicit = numericUtilization(info);

  if (resetElapsed) {
    dataKind = "estimated";
    utilization = 0;
  } else if (explicit !== null) {
    dataKind = "measured";
    utilization = explicit;
  } else if (status === "rejected") {
    dataKind = "estimated";
    utilization = 1;
  } else if (status === "allowed_warning") {
    dataKind = "estimated";
    utilization = 0.9;
  } else if (status === "allowed") {
    dataKind = "estimated";
    utilization = 0;
  }

  const reasonBase = `status=${status} rateLimitType=${info.rateLimitType ?? windowKind} (${logPath})`;

  if (dataKind === null) {
    return {
      windowKind,
      classification: READING_STATUS.UNAVAILABLE,
      utilization: null,
      status,
      surpassedThreshold,
      rateLimitType: typeof info.rateLimitType === "string" ? info.rateLimitType : null,
      resetsAtMs,
      resetsAtIso: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
      resetElapsed,
      observedAtMs,
      ageMs,
      maxStalenessMs,
      logPath,
      foundVia,
      reason: `unrecognized rate-limit status "${status}" ${reasonBase}`
    };
  }

  return {
    windowKind,
    classification: stale ? READING_STATUS.STALE : dataKind,
    utilization: stale ? null : utilization,
    status,
    surpassedThreshold,
    rateLimitType: typeof info.rateLimitType === "string" ? info.rateLimitType : null,
    resetsAtMs,
    resetsAtIso: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
    resetElapsed,
    observedAtMs,
    ageMs,
    maxStalenessMs,
    logPath,
    foundVia,
    reason: stale ? `stale (age ${ageMs}ms > max ${maxStalenessMs}ms) ${reasonBase}` : reasonBase
  };
}

/**
 * Reads the newest telemetry for ONE window (`five_hour` or `seven_day`), scanned independently
 * of any other window's events -- see docs/usage-telemetry.md's "reading independently" section
 * for the bug this fixes (a newest-event-wins reader can miss an exhausted window entirely when
 * the very latest event anywhere belongs to the other window).
 *
 * Never throws on an unreadable runs directory; returns `unavailable` instead, matching
 * `readUsageSnapshot`'s existing fail-safe contract in usageWindow.js.
 */
export async function readWindowUsage({
  runsDir,
  windowKind,
  now = Date.now(),
  maxStalenessMs = DEFAULT_MAX_STALENESS_MS[windowKind],
  tailBytes = DEFAULT_TAIL_BYTES,
  maxLogsScanned = DEFAULT_MAX_LOGS_SCANNED,
  readdirFn = fs.readdir,
  statFn = fs.stat,
  openFn = fs.open
} = {}) {
  if (!WINDOW_KINDS.includes(windowKind)) {
    throw new Error(`unknown usage window kind: ${windowKind}`);
  }
  const effectiveMaxStalenessMs = maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS[windowKind];

  const predicate = (info) => info.rateLimitType === windowKind;

  let found;
  try {
    found = await findNewestMatchingRateLimitInfo({
      runsDir,
      predicate,
      tailBytes,
      maxLogsScanned,
      readdirFn,
      statFn,
      openFn
    });
  } catch (err) {
    return unavailableReading(windowKind, `${windowKind} telemetry unreadable: ${err.message}`, effectiveMaxStalenessMs);
  }

  if (!found) {
    return unavailableReading(windowKind, `no ${windowKind} telemetry found in ${runsDir}/*.jsonl`, effectiveMaxStalenessMs);
  }

  return classifyReading({
    windowKind,
    info: found.info,
    observedAtMs: found.observedAtMs,
    now,
    maxStalenessMs: effectiveMaxStalenessMs,
    logPath: found.logPath,
    foundVia: found.foundVia
  });
}

/**
 * Reads both windows independently and returns `{five_hour, seven_day}`. One window's reading
 * never influences the other's -- each is a completely separate scan for its own `rateLimitType`.
 */
export async function readUsageTelemetry({ runsDir, now = Date.now(), maxStalenessMs = {}, ...ioOverrides } = {}) {
  const readings = {};
  for (const windowKind of WINDOW_KINDS) {
    readings[windowKind] = await readWindowUsage({
      runsDir,
      windowKind,
      now,
      maxStalenessMs: maxStalenessMs[windowKind] ?? DEFAULT_MAX_STALENESS_MS[windowKind],
      ...ioOverrides
    });
  }
  return readings;
}
