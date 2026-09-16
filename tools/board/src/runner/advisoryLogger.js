import { promises as fs } from "node:fs";
import path from "node:path";
import { READING_STATUS, readUsageTelemetry } from "./usageTelemetry.js";
import { UsageLedgerReadIndeterminateError, listCardUsageEntries } from "./usageLedger.js";
import { DEFAULT_COVERAGE_TARGET, observationFromAttemptEntry, estimateCost, indeterminateEstimate } from "./costEstimator.js";

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

/**
 * Builds the `{estimate, telemetryReadings, reason}` triple `recordAdvisoryDecision` persists, by
 * reading this card's own ledger history and current telemetry -- the concrete `decide()` a real
 * launch passes to `withAdvisoryLogging` (T-0367 consumer contract 1, Codex review 0913,
 * 2026-09-13). That contract names both "the estimator" (`costEstimator.js`'s
 * `collectObservationsFromLedger`, for the many-card calibration pool) AND "the advisory logger"
 * as places a `UsageLedgerReadIndeterminateError` must never become a silent zero/empty read --
 * this is the advisory logger's own half of that. A card whose own ledger read is indeterminate
 * gets an explicit `classification: "indeterminate"` estimate (never `estimateCost([])`, which
 * would read as a confident zero-cost/no-history result) and a `reason` that names the read as
 * indeterminate, so the persisted record shows *why* the prediction is unreliable.
 */
export async function decideLaunchAdvisory({
  runsDir,
  cardId,
  type,
  coverageTarget = DEFAULT_COVERAGE_TARGET,
  fitDate = null,
  now = Date.now(),
  listCardUsageEntriesFn = listCardUsageEntries,
  readUsageTelemetryFn = readUsageTelemetry
}) {
  const telemetryReadings = await readUsageTelemetryFn({ runsDir, now });

  let entries;
  try {
    entries = await listCardUsageEntriesFn({ runsDir, cardId });
  } catch (err) {
    if (!(err instanceof UsageLedgerReadIndeterminateError)) throw err;
    return {
      estimate: indeterminateEstimate(),
      telemetryReadings,
      type,
      fitDate,
      reason: `ledger read indeterminate for ${cardId}: ${err.message}`
    };
  }

  const observations = entries.map(observationFromAttemptEntry);
  const estimate = estimateCost({ type, observations, coverageTarget });
  return {
    estimate,
    telemetryReadings,
    type,
    fitDate,
    reason: `estimate for ${cardId} (${type}) from ${observations.length} prior observation(s), source ${estimate.estimateSource}`
  };
}

/** Path to one launch decision's advisory record -- mirrors usageLedger.js's key convention. */
export function advisoryLogPath(runsDir, { cardId, executionId, invocationId }) {
  return path.join(runsDir, `${cardId}-exec${executionId}-inv${invocationId}.advisory.json`);
}

/**
 * Path to a launch identity's durably-retained outcome, awaiting a decision record to attach to
 * (T-0370 round 3). Deliberately a DIFFERENT suffix than `advisoryLogPath` -- `measureRecordedCoverage`
 * only ever globs `.advisory.json`, so a pending marker can never be mistaken for a scoreable
 * decision record.
 */
export function pendingOutcomePath(runsDir, { cardId, executionId, invocationId }) {
  return path.join(runsDir, `${cardId}-exec${executionId}-inv${invocationId}.outcome-pending.json`);
}

/** Thrown by `recordAdvisoryOutcome` when no decision has been recorded yet for a launch identity -- distinguishable from any other failure so callers can route it to `retainOutcomeUntilDecisionRecorded` instead of just logging a discard. */
export class AdvisoryDecisionMissingError extends Error {}

const VALID_OUTCOME_COST_KINDS = new Set(["exact", "lower_bound"]);

/**
 * An outcome is scoreable only when it names which kind of number it carries (`costKind: "exact"`
 * or `"lower_bound"`) and that number is a finite, non-negative `actualCostUsd` -- no coercion of
 * strings, no null/undefined standing in for zero. Anything else, including a shape nobody has
 * written yet, fails safe as unresolved rather than being scored as a met or missed prediction
 * (recorded coverage fail-safe round, 2026-09-13). A genuinely unknown actual cost should be
 * recorded as a `lower_bound` at the known subtotal (>= 0, per T-0367 consumer contract 2), never
 * as a null exact cost.
 */
function isScoreableOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return false;
  if (!VALID_OUTCOME_COST_KINDS.has(outcome.costKind)) return false;
  const { actualCostUsd } = outcome;
  return typeof actualCostUsd === "number" && Number.isFinite(actualCostUsd) && actualCostUsd >= 0;
}

/**
 * A scoreable prediction value is a finite, non-negative number -- the same rule
 * `isScoreableOutcome` already applies to `actualCostUsd`, mirrored here for the prediction side
 * (Codex review 2026-09-14). No coercion of strings ("100" is not 100); `Infinity` (round-trips
 * from JSON `1e400`) and `NaN` are rejected too. `null`/`undefined` are NOT handled here -- those
 * mean "indeterminate estimate" and keep their own `excludedIndeterminate` handling upstream.
 */
function isScoreablePredictionValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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

async function writeExclusive(filePath, data, { writeFileFn, mkdirFn, linkFn, unlinkFn, readFileFn }) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await mkdirFn(path.dirname(filePath), { recursive: true });
  await writeFileFn(tmpPath, JSON.stringify(data, null, 2), "utf8");
  try {
    await linkFn(tmpPath, filePath);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return JSON.parse(await readFileFn(filePath, "utf8"));
    }
    throw err;
  } finally {
    await unlinkFn(tmpPath).catch(() => {});
  }
  return data;
}

/**
 * Attaches a durably-retained outcome marker (if one exists for this launch identity) to the
 * decision record now on disk (T-0370 round 3: "a finished launch's terminal outcome is never
 * discarded because its advisory decision was not yet on disk"). Deleting the marker file IS the
 * ownership token -- whichever caller (`recordAdvisoryDecision`'s own post-write check, or
 * `retainOutcomeUntilDecisionRecorded`'s own re-check right after it writes the marker) actually
 * succeeds at unlinking it is the one that applies the outcome, so both orderings -- and the case
 * where they race -- converge on exactly one attach. A decision record that already carries a
 * non-null outcome is never overwritten; the marker is still cleared either way, so it never
 * outlives its use.
 */
async function consumePendingOutcome({ runsDir, cardId, executionId, invocationId, now, readFileFn, unlinkFn, writeFileFn, mkdirFn, renameFn }) {
  const markerPath = pendingOutcomePath(runsDir, { cardId, executionId, invocationId });
  let marker;
  try {
    marker = JSON.parse(await readFileFn(markerPath, "utf8"));
  } catch {
    return null;
  }
  const filePath = advisoryLogPath(runsDir, { cardId, executionId, invocationId });
  let existing;
  try {
    existing = JSON.parse(await readFileFn(filePath, "utf8"));
  } catch {
    // No decision published yet -- leave the marker exactly as it is for a future check (this
    // one's own re-check, or `recordAdvisoryDecision`'s, whichever comes next) to find.
    return null;
  }
  if (existing.outcome !== null && existing.outcome !== undefined) {
    // Someone else already attached an outcome -- never overwrite it, but the marker has served
    // its purpose (or was always stray); clear it so it doesn't outlive its use.
    await unlinkFn(markerPath).catch(() => {});
    return null;
  }
  // Ownership token: only the caller that actually succeeds at unlinking the marker attaches the
  // outcome -- a concurrent caller racing the same check backs off instead of double-attaching.
  try {
    await unlinkFn(markerPath);
  } catch {
    return null;
  }
  const updated = { ...existing, outcome: marker.outcome, updatedAt: now().toISOString() };
  await writeAtomic(filePath, updated, { writeFileFn, mkdirFn, renameFn, unlinkFn });
  return updated;
}

/**
 * Records one launch decision's advisory evidence (spec §10 step 3): the cost prediction, each
 * telemetry window's freshness classification, the estimator version, and the reason the decision
 * was made -- with `outcome: null` (pending) until `recordAdvisoryOutcome` attaches what actually
 * happened. This function only ever writes a record; it never returns anything a caller could use
 * to gate the launch it describes (see `withAdvisoryLogging`, which enforces that structurally).
 *
 * Rejects, writing nothing, an `estimate.value` that is neither exactly `null` (a valid
 * hold-for-sizing/indeterminate decision) nor a finite, non-negative number -- the write-time twin
 * of `isScoreablePredictionValue`, so the logger itself can never persist a malformed prediction
 * for `measureRecordedCoverage` to later have to fail safe against (Codex review 2026-09-14).
 *
 * Written via exclusive create (`fs.link`, mirroring `launchReservation.js`'s `reserveLaunchSlot`),
 * not an unconditional overwrite (T-0370 fix round 2 finding 2: "a write already in flight when
 * cancellation happens leaves nothing behind ... a late advisory-decision write never replaces the
 * fallback record or an outcome already attached"). `launchAdvisory.js`'s `buildLaunchDecide` can
 * race two writes for the SAME launch identity -- its own happy-path persist, and
 * `withBoundedDecide`'s timeout/error fallback persist -- with no coordination between them beyond
 * whichever one's write actually lands on disk first; exclusive create makes that race safe by
 * construction: the FIRST write to actually complete wins, and every later one for the same key
 * (whatever its content) is silently discarded in favor of what's already there, so an outcome
 * `recordAdvisoryOutcome` later attaches to the winning record can never be clobbered by a
 * straggler. Returns the WINNING on-disk record either way -- the caller cannot tell, and does not
 * need to tell, whether it was the write that landed or one that already existed.
 */
export async function recordAdvisoryDecision({
  runsDir,
  cardId,
  executionId,
  invocationId,
  type = null,
  fitDate = null,
  estimate,
  telemetryReadings,
  reason,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  linkFn = fs.link,
  unlinkFn = fs.unlink,
  readFileFn = fs.readFile,
  renameFn = fs.rename
}) {
  if (estimate.value !== null && !isScoreablePredictionValue(estimate.value)) {
    throw new Error(
      `advisory logger: malformed estimate.value for ${cardId}/${executionId}/${invocationId} -- requires exactly null or a finite, non-negative number, got ${JSON.stringify(estimate.value)}`
    );
  }
  const recordedAt = now().toISOString();
  const entry = {
    cardId,
    executionId,
    invocationId,
    type,
    fitDate,
    prediction: estimate,
    telemetryFreshness: buildTelemetryFreshness(telemetryReadings),
    estimatorVersion: estimate.estimatorVersion,
    reason,
    outcome: null,
    recordedAt,
    updatedAt: recordedAt
  };
  const filePath = advisoryLogPath(runsDir, { cardId, executionId, invocationId });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await mkdirFn(path.dirname(filePath), { recursive: true });
  await writeFileFn(tmpPath, JSON.stringify(entry, null, 2), "utf8");
  let winning;
  try {
    await linkFn(tmpPath, filePath);
    winning = entry;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      winning = JSON.parse(await readFileFn(filePath, "utf8"));
    } else {
      throw err;
    }
  } finally {
    await unlinkFn(tmpPath).catch(() => {});
  }

  // T-0370 round 3: an outcome may already be durably retained for this launch identity (it
  // arrived before any decision existed -- see `retainOutcomeUntilDecisionRecorded`). Whichever
  // decision write actually wins above, attach it now rather than leaving the outcome stranded.
  let attached = null;
  try {
    attached = await consumePendingOutcome({ runsDir, cardId, executionId, invocationId, now, readFileFn, unlinkFn, writeFileFn, mkdirFn, renameFn });
  } catch {
    attached = null;
  }
  return attached ?? winning;
}

/**
 * Attaches the eventual outcome to a previously recorded advisory decision (spec §10 step 3: "and
 * the eventual outcome"). Throws `AdvisoryDecisionMissingError` if the decision was never recorded
 * (yet) -- an outcome with nothing to attach to. Callers on the launch path (`cardLaunch.js`'s
 * `reconcileLaunchOutcome`) catch that specific error and retain the outcome durably instead of
 * discarding it (T-0370 round 3) -- see `retainOutcomeUntilDecisionRecorded`.
 *
 * Also throws, writing nothing, if `outcome` isn't a scoreable shape (`isScoreableOutcome`) -- the
 * logger itself must never produce a malformed outcome (recorded coverage fail-safe round,
 * 2026-09-13). `measureRecordedCoverage`'s own fail-safe handling of a malformed outcome remains,
 * for older or hand-written record files this validation didn't cover.
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
    throw new AdvisoryDecisionMissingError(
      `advisory logger: no decision recorded for ${cardId}/${executionId}/${invocationId}, cannot attach outcome (${err.message})`
    );
  }
  if (!isScoreableOutcome(outcome)) {
    throw new Error(
      `advisory logger: malformed outcome for ${cardId}/${executionId}/${invocationId} -- requires costKind "exact" or "lower_bound" and a finite, non-negative actualCostUsd, got ${JSON.stringify(outcome)}`
    );
  }
  const updated = { ...existing, outcome, updatedAt: now().toISOString() };
  await writeAtomic(filePath, updated, { writeFileFn, mkdirFn, renameFn, unlinkFn });
  return updated;
}

/**
 * Retains an outcome durably when `reconcileLaunchOutcome` runs before any decision record exists
 * yet for this launch identity (T-0370 round 3: the outer launch timeout, `cardLaunch.js`'s own
 * bound around `decide()`, can fire and let the run proceed before `buildLaunchDecide`'s own
 * (separately bounded) timeout fallback has finished persisting ITS decision record). Writes a
 * marker keyed to the launch identity -- distinct from an advisory record, so it is never mistaken
 * for one by `measureRecordedCoverage` -- then immediately re-checks whether the decision has
 * landed concurrently (right after `recordAdvisoryOutcome`'s own read failed but before this
 * marker existed for `recordAdvisoryDecision`'s own check to find), attaching right away rather
 * than leaving the outcome stranded until nothing ever rechecks. Coordination is independent of
 * any timeout: it holds whichever write lands first, and the two orderings converging concurrently
 * (see `consumePendingOutcome`'s unlink-as-ownership-token) are both race-safe.
 */
export async function retainOutcomeUntilDecisionRecorded({
  runsDir,
  cardId,
  executionId,
  invocationId,
  outcome,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  linkFn = fs.link,
  unlinkFn = fs.unlink,
  readFileFn = fs.readFile,
  renameFn = fs.rename
}) {
  if (!isScoreableOutcome(outcome)) {
    throw new Error(
      `advisory logger: malformed outcome for ${cardId}/${executionId}/${invocationId} -- requires costKind "exact" or "lower_bound" and a finite, non-negative actualCostUsd, got ${JSON.stringify(outcome)}`
    );
  }
  const markerPath = pendingOutcomePath(runsDir, { cardId, executionId, invocationId });
  const recordedAt = now().toISOString();
  await writeExclusive(markerPath, { cardId, executionId, invocationId, outcome, recordedAt }, { writeFileFn, mkdirFn, linkFn, unlinkFn, readFileFn });
  return consumePendingOutcome({ runsDir, cardId, executionId, invocationId, now, readFileFn, unlinkFn, writeFileFn, mkdirFn, renameFn });
}

/**
 * Measures real coverage: how often a RECORDED, immutable pre-launch prediction was exceeded by
 * what actually happened (Codex WIP-gate batch review finding 6, 2026-09-13). This never refits an
 * estimate from the realized costs and scores them against that fresh fit -- that would be a
 * fit-on-training-data check (see costEstimator.js's `inSampleFitDiagnostic`), not coverage of a
 * prediction made before the outcome was known. Every advisory record already carries the
 * estimator version and fit identity (`fitDate`) its `prediction` came from
 * (`recordAdvisoryDecision`); results are grouped by that pair so a later re-fit's coverage is
 * never blended with an earlier one's.
 *
 * A record's `outcome` (attached by `recordAdvisoryOutcome`, itself never mutating `prediction`)
 * is scored only when it's a valid exact outcome (`costKind: "exact"` with a finite, non-negative
 * numeric `actualCostUsd`) or a valid lower-bound outcome (`costKind: "lower_bound"`, same numeric
 * constraint) -- see `isScoreableOutcome`. Every other shape -- a null or non-numeric cost, a
 * numeric string, a negative or non-finite cost, a missing or unknown `costKind`, a non-object
 * outcome -- is UNRESOLVED and never enters `evaluated` or `exceeded` (recorded coverage fail-safe
 * round, 2026-09-13). `recordAdvisoryOutcome` now rejects these at write time, but this reader must
 * still tolerate them in older or hand-written record files.
 *
 * An exact actual exceeds when it's greater than `prediction.value`. A lower-bound actual whose
 * bound already exceeds the prediction is a PROVEN overrun; one whose bound is still below is
 * UNRESOLVED -- its true cost may yet be higher, so it is never counted as a proven non-overrun.
 * Records with no `outcome` yet are pending, not scored. Records whose `prediction` is
 * indeterminate/null (no numeric value) are excluded from scoring entirely and counted separately
 * -- there is nothing to compare an actual against. A record file that can't be read or parsed
 * can't be attributed to any estimator/fit group, so it's skipped and counted in its own top-level
 * `unreadable` tally instead of aborting the whole calculation -- every other record is still
 * scored. Content that parses as JSON but isn't a plain record object (`null`, an array, or a bare
 * scalar like `42`/`"x"`) is treated the same as a parse failure -- counted `unreadable`, never
 * dereferenced (which would throw on `null`) and never miscounted as `pending` (2026-09-13).
 *
 * A record's `prediction.value` is scored only when it's a finite, non-negative number
 * (`isScoreablePredictionValue`) -- a non-null value that's a string, negative, `Infinity`
 * (JSON `1e400`) or `NaN` is reported in its own `invalidPrediction` tally and never enters
 * `evaluated`/`exceeded`/`fraction`; a `null`/`undefined` value keeps the existing
 * `excludedIndeterminate` handling (Codex review 2026-09-14). Only a missing outcome (the key is
 * `null`, `undefined`, or simply absent) counts as `pending` -- `false`, `0` and `""` are
 * present-but-malformed values that reach `isScoreableOutcome` and land in `unresolved` instead.
 */
export async function measureRecordedCoverage({ runsDir, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  let files;
  try {
    files = await readdirFn(runsDir);
  } catch (err) {
    if (err.code === "ENOENT") return { groups: {}, excludedIndeterminate: 0, invalidPrediction: 0, pending: 0, unreadable: 0 };
    throw err;
  }

  const groups = {};
  let excludedIndeterminate = 0;
  let invalidPrediction = 0;
  let pending = 0;
  let unreadable = 0;

  for (const file of files.filter((f) => f.endsWith(".advisory.json"))) {
    let record;
    try {
      record = JSON.parse(await readFileFn(path.join(runsDir, file), "utf8"));
    } catch {
      unreadable += 1;
      continue;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      unreadable += 1;
      continue;
    }
    if (record.outcome === null || record.outcome === undefined) {
      pending += 1;
      continue;
    }
    const prediction = record.prediction;
    if (!prediction || prediction.value === null || prediction.value === undefined) {
      excludedIndeterminate += 1;
      continue;
    }
    if (!isScoreablePredictionValue(prediction.value)) {
      invalidPrediction += 1;
      continue;
    }

    const estimatorVersion = record.estimatorVersion ?? prediction.estimatorVersion ?? "unknown";
    const fitIdentity = record.fitDate ?? "unversioned";
    const key = `${estimatorVersion}::${fitIdentity}`;
    groups[key] ??= { estimatorVersion, fitDate: record.fitDate ?? null, evaluated: 0, exceeded: 0, unresolved: 0 };
    const group = groups[key];

    if (!isScoreableOutcome(record.outcome)) {
      group.unresolved += 1;
      continue;
    }

    const { actualCostUsd, costKind } = record.outcome;
    if (costKind === "lower_bound") {
      if (actualCostUsd > prediction.value) {
        group.evaluated += 1;
        group.exceeded += 1;
      } else {
        group.unresolved += 1;
      }
    } else {
      group.evaluated += 1;
      if (actualCostUsd > prediction.value) group.exceeded += 1;
    }
  }

  for (const group of Object.values(groups)) {
    group.fraction = group.evaluated === 0 ? null : group.exceeded / group.evaluated;
  }

  return { groups, excludedIndeterminate, invalidPrediction, pending, unreadable };
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
