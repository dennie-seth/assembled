import { promises as fs } from "node:fs";
import path from "node:path";
import { READING_STATUS } from "./usageTelemetry.js";

/**
 * A window's telemetry counts as verified available capacity ONLY when T-0367's reader classified
 * it `measured` (T-0367 consumer contract 3, Codex review 0913, 2026-09-13). `estimated` (a
 * status-only `allowed` event, or an elapsed reset), `stale`, and `unavailable` all withhold a
 * real number and must never be presented as proof of headroom another consumer hasn't already
 * spent.
 */
export function classifyWindowCapacity(reading) {
  return {
    windowKind: reading.windowKind,
    classification: reading.classification,
    verifiedAvailable: reading.classification === READING_STATUS.MEASURED,
    utilization: reading.classification === READING_STATUS.MEASURED ? reading.utilization : null
  };
}

/** Applies `classifyWindowCapacity` to every window in a `readUsageTelemetry()`-shaped result. */
export function buildTelemetryFreshness(telemetryReadings) {
  const freshness = {};
  for (const [windowKind, reading] of Object.entries(telemetryReadings)) {
    freshness[windowKind] = classifyWindowCapacity(reading);
  }
  return freshness;
}

/** Path to one launch decision's advisory record -- mirrors usageLedger.js's key convention. */
export function advisoryLogPath(runsDir, { cardId, executionId, invocationId }) {
  return path.join(runsDir, `${cardId}-exec${executionId}-inv${invocationId}.advisory.json`);
}

async function writeAtomic(filePath, data, { writeFileFn, mkdirFn, renameFn, unlinkFn }) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await mkdirFn(path.dirname(filePath), { recursive: true });
  await writeFileFn(tmpPath, JSON.stringify(data, null, 2), "utf8");
  try {
    await renameFn(tmpPath, filePath);
  } catch (err) {
    await unlinkFn(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Records one launch decision's advisory evidence (spec §10 step 3): the cost prediction, each
 * telemetry window's freshness classification, the estimator version, and the reason the decision
 * was made -- with `outcome: null` (pending) until `recordAdvisoryOutcome` attaches what actually
 * happened. This function only ever writes a record; it never returns anything a caller could use
 * to gate the launch it describes (see `withAdvisoryLogging`, which enforces that structurally).
 */
export async function recordAdvisoryDecision({
  runsDir,
  cardId,
  executionId,
  invocationId,
  estimate,
  telemetryReadings,
  reason,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  renameFn = fs.rename,
  unlinkFn = fs.unlink
}) {
  const recordedAt = now().toISOString();
  const entry = {
    cardId,
    executionId,
    invocationId,
    prediction: estimate,
    telemetryFreshness: buildTelemetryFreshness(telemetryReadings),
    estimatorVersion: estimate.estimatorVersion,
    reason,
    outcome: null,
    recordedAt,
    updatedAt: recordedAt
  };
  await writeAtomic(advisoryLogPath(runsDir, { cardId, executionId, invocationId }), entry, { writeFileFn, mkdirFn, renameFn, unlinkFn });
  return entry;
}

/**
 * Attaches the eventual outcome to a previously recorded advisory decision (spec §10 step 3: "and
 * the eventual outcome"). Throws if the decision was never recorded -- an outcome with nothing to
 * attach to is a caller bug, not a record this module should silently invent.
 */
export async function recordAdvisoryOutcome({
  runsDir,
  cardId,
  executionId,
  invocationId,
  outcome,
  now = () => new Date(),
  readFileFn = fs.readFile,
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  renameFn = fs.rename,
  unlinkFn = fs.unlink
}) {
  const filePath = advisoryLogPath(runsDir, { cardId, executionId, invocationId });
  let existing;
  try {
    existing = JSON.parse(await readFileFn(filePath, "utf8"));
  } catch (err) {
    throw new Error(`advisory logger: no decision recorded for ${cardId}/${executionId}/${invocationId}, cannot attach outcome (${err.message})`);
  }
  const updated = { ...existing, outcome, updatedAt: now().toISOString() };
  await writeAtomic(filePath, updated, { writeFileFn, mkdirFn, renameFn, unlinkFn });
  return updated;
}

/**
 * Structurally guarantees the advisory logger changes no launch (spec §10 step 3 / this card's
 * "Do not" list): `launch()` always runs and its result is always returned untouched, regardless
 * of what `decide()` predicts or whether `decide()` throws outright. Advisory failures are
 * swallowed (never rethrown) precisely because instrumentation must never delay or block the
 * launch it's describing -- the same posture `usageLedger.js`'s fire-and-forget recording already
 * takes for the same reason.
 */
export async function withAdvisoryLogging({ decide, launch }) {
  let advisory = null;
  try {
    advisory = await decide();
  } catch {
    advisory = null;
  }
  const result = await launch();
  return { advisory, result };
}
