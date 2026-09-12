import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });

function numberOr0(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isFiniteNonNegative(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

const USAGE_COUNTER_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

/**
 * Validates a raw provider `usage` object and returns parsed token counts, or `null` when the
 * object is missing, empty, or carries any counter that isn't a finite, nonnegative number
 * (Codex review 2, 2026-09-12, finding 3). A caller MUST treat `null` as "no trustworthy usage
 * data", never coerce it to zero-cost -- an empty `{}` or a negative/NaN counter is malformed
 * data, not evidence of zero consumption.
 */
function validateUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const present = USAGE_COUNTER_FIELDS.filter((field) => field in usage);
  if (present.length === 0) return null;
  for (const field of present) {
    if (!isFiniteNonNegative(usage[field])) return null;
  }
  return {
    input: numberOr0(usage.input_tokens),
    output: numberOr0(usage.output_tokens),
    cacheCreate: numberOr0(usage.cache_creation_input_tokens),
    cacheRead: numberOr0(usage.cache_read_input_tokens)
  };
}

function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead
  };
}

function tokensHaveAnyUsage(tokens) {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheCreate > 0 || tokens.cacheRead > 0;
}

/**
 * Identity for message-level dedup: session + assistant-message id together (Codex review
 * 2026-09-12, P1). A live event stream repeats the same assistant message id multiple times,
 * each occurrence carrying the SAME usage snapshot (not a delta) -- summing every occurrence
 * double- (or triple-) counts a single API call. `null` means "no trustworthy identity", which
 * the caller must treat as incomplete data, never as a zero-cost message.
 */
function assistantMessageDedupKey(event) {
  const messageId = event.message && typeof event.message.id === "string" ? event.message.id : null;
  if (messageId === null) return null;
  const sessionId = typeof event.session_id === "string" ? event.session_id : "";
  return `${sessionId}::${messageId}`;
}

/**
 * Reduces a run's parsed NDJSON events into one usage summary. Pure and total over its input --
 * never throws, treats non-array/malformed events as contributing nothing.
 *
 * The categories (input/output/cache-create/cache-read tokens, model, cost) are defined here
 * because nothing upstream aggregates them yet: `runLog.js`/`streamParser.js` keep raw NDJSON,
 * but never sum it (see docs/usage-telemetry.md).
 *
 * Authority rule -- "never add per-message usage to a cumulative final result": each `assistant`
 * event's `message.usage` reflects one API call; the terminal `result` event's `usage`/
 * `total_cost_usd` is already the session's cumulative total. When a `result` event carries a
 * VALID cumulative usage object, its numbers are the summary, full stop -- the per-message sum
 * is discarded, not added on top. A `result` event with no usage, an empty `usage: {}`, or a
 * malformed counter is NOT authoritative (Codex review 2, 2026-09-12, finding 3): it never
 * masquerades as a measured zero-cost completion. Whenever no valid cumulative total exists --
 * no `result` event at all (a cancel/crash/phase-timeout truncation), or one that failed
 * validation -- the per-message sum becomes the recorded figure, tagged `usageSource:
 * "incremental"` and `usageIncomplete: true` so it reads as a lower bound, not a completed
 * attempt's cost.
 *
 * Within the incremental path, each DISTINCT (session, message id) pair is counted at most once
 * -- see `assistantMessageDedupKey` -- since the CLI's own stream repeats an assistant message
 * verbatim (audited across six real `tasks/.runs/*.jsonl` logs, Codex review 2026-09-12). An
 * event with no usable identity (missing message id, or missing/malformed usage) is never folded
 * in as zero cost; it instead flips `usageIncomplete`, so a caller can tell "measured, low" from
 * "some of this attempt's usage could not be read at all".
 *
 * `costUsd` is `null` ("unknown"), never `0`, whenever no valid provider total cost figure was
 * ever seen -- a measured zero cost (a real `total_cost_usd: 0`) is reported as `0` and must stay
 * distinguishable from "we never got a cost figure at all" (Codex review 2, 2026-09-12, finding 3).
 */
export function summarizeUsageFromEvents(events) {
  const list = Array.isArray(events) ? events : [];

  const perMessageTokens = new Map(); // dedupKey -> tokens; a repeat OVERWRITES, never sums
  const models = new Set();
  let resultInfo = null; // {tokens: tokens|null, valid, costUsd: number|null, terminalReason, apiErrorStatus, resultText}
  let hasIncompleteAssistantEvent = false;

  for (const event of list) {
    if (!event || typeof event !== "object") continue;

    if (event.type === "assistant" && event.message && typeof event.message === "object") {
      if (typeof event.message.model === "string") models.add(event.message.model);
      const dedupKey = assistantMessageDedupKey(event);
      const tokens = validateUsageTokens(event.message.usage);
      if (dedupKey === null || tokens === null) {
        hasIncompleteAssistantEvent = true;
      } else {
        perMessageTokens.set(dedupKey, tokens);
      }
    }

    if (event.type === "result") {
      const tokens = validateUsageTokens(event.usage);
      const hasCost = typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd);
      resultInfo = {
        tokens,
        valid: tokens !== null,
        costUsd: hasCost ? event.total_cost_usd : null,
        terminalReason: typeof event.terminal_reason === "string" ? event.terminal_reason : null,
        apiErrorStatus: typeof event.api_error_status === "number" ? event.api_error_status : null,
        resultText: typeof event.result === "string" ? event.result : null
      };
    }
  }

  let incrementalTokens = ZERO_TOKENS;
  for (const tokens of perMessageTokens.values()) incrementalTokens = addTokens(incrementalTokens, tokens);

  // The final result event is authoritative within its session regardless of any incomplete
  // per-message data seen along the way -- a completed attempt's cumulative total is real,
  // known-good data even if some individual assistant events couldn't be read. But ONLY when
  // its own usage object actually validated -- a bare/empty/malformed `result.usage` is not
  // "the session cost was zero", it's "we don't actually know the session cost".
  if (resultInfo && resultInfo.valid) {
    return {
      tokens: resultInfo.tokens,
      costUsd: resultInfo.costUsd,
      models: Array.from(models),
      usageSource: "result",
      terminalReason: resultInfo.terminalReason,
      apiErrorStatus: resultInfo.apiErrorStatus,
      resultText: resultInfo.resultText,
      usageIncomplete: false
    };
  }

  const resultPresentButInvalid = resultInfo !== null && !resultInfo.valid;
  const usageIncomplete = hasIncompleteAssistantEvent || resultPresentButInvalid;
  const hasIncrementalUsage = models.size > 0 || tokensHaveAnyUsage(incrementalTokens) || perMessageTokens.size > 0;
  const usageSource = hasIncrementalUsage || usageIncomplete ? "incremental" : "none";

  return {
    tokens: incrementalTokens,
    // "none" (literally zero events processed) is a genuinely measured zero; "incremental" means
    // some events were seen but no provider cost figure was ever validated -- unknown, not zero.
    costUsd: usageSource === "incremental" ? null : 0,
    models: Array.from(models),
    usageSource,
    terminalReason: resultInfo ? resultInfo.terminalReason : null,
    apiErrorStatus: resultInfo ? resultInfo.apiErrorStatus : null,
    resultText: resultInfo ? resultInfo.resultText : null,
    usageIncomplete
  };
}

function assertValidExecutionId(executionId) {
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new Error(`usage ledger: executionId is required and must be a non-empty string (got ${JSON.stringify(executionId)})`);
  }
}

/**
 * Rejected up front, exactly like `assertValidExecutionId` (Codex review 3, 2026-09-12,
 * recommendation): a missing/empty invocationId used to silently fall back to a shared
 * `DEFAULT_INVOCATION_ID`, conflating any callers that omitted it onto one key. There is no
 * default any more -- every NEW record must carry a real, caller-supplied invocation identity. A
 * future replay/backfill tool that needs to target a pre-existing legacy identity takes that as
 * its own explicit input, never a silent fallback (see docs/usage-telemetry.md).
 */
function assertValidInvocationId(invocationId) {
  if (typeof invocationId !== "string" || invocationId.length === 0) {
    throw new Error(`usage ledger: invocationId is required and must be a non-empty string (got ${JSON.stringify(invocationId)})`);
  }
}

/**
 * Path to the CANONICAL (card, execution, invocation, attempt, phase, retry) key's usage --
 * an identity, not necessarily the exact file written to disk for any one call (see
 * `recordAttemptUsage`'s immutable-revision publication below).
 *
 * `executionId` (Codex review 2026-09-12, P1) distinguishes separate launches of the SAME card:
 * without it, a rerun that starts a fresh attempt-1 overwrites a previous launch's attempt-1
 * file, and the two launches' totals get silently conflated. See `ensureExecutionId` for how a
 * launch's id is minted/persisted/reused. Rejected up front (before any string is built) when
 * missing or empty -- never write a `…execundefined…`/`…execnull…` path (Codex review 2,
 * 2026-09-12, finding 4).
 *
 * `invocationId` (Codex review 2, 2026-09-12, finding 2) distinguishes separate PROCESS spawns of
 * the same phase within the same execution: after a board crash, a restarted card reuses its
 * persisted executionId (that's what "recovery" means -- the interrupted work is still logically
 * part of the same launch), but the restarted phase is a brand-new child process that must never
 * overwrite the interrupted phase's own entry. The orchestrator mints a fresh one per `_runPhase`
 * call. Also rejected up front when missing or empty (Codex review 3, 2026-09-12) -- there is no
 * shared default key any more.
 */
export function usageLedgerEntryPath(runsDir, { cardId, executionId, invocationId, attempt, phase, retry }) {
  assertValidExecutionId(executionId);
  assertValidInvocationId(invocationId);
  return path.join(runsDir, `${cardId}-exec${executionId}-inv${invocationId}-attempt${attempt}-${phase}-retry${retry}.usage.json`);
}

/**
 * Monotonic call-order counter, assigned synchronously (before any `await`) the instant
 * `recordAttemptUsage` is invoked. Combined with `epoch` (below) into the composite `revision`
 * embedded in the entry. This is what lets two racing writes for the same key agree on which one
 * is "newer" regardless of which one's I/O happens to finish first -- but ALONE it is not enough:
 * it lives only in memory, restarting at 0 every process start, so without `epoch` a pre-restart
 * `rev6` would outrank a post-restart `rev1` for the same entry (Round 6, 2026-09-12).
 */
let nextWriteSequence = 0;

/**
 * Per-`runsDir` cache of this process's persisted, never-decreasing epoch (Round 6, 2026-09-12).
 * `ensureEpoch` is a plain (non-async) function so calling it is synchronous -- the very first
 * call for a given `runsDir` starts `loadAndBumpEpoch` and caches its pending Promise immediately,
 * before any `await` runs, so every racing call within the same tick observes the same cached
 * Promise rather than each separately reading-and-bumping the persisted file. The epoch value
 * itself is therefore identical for every write this process makes against one `runsDir` for its
 * entire lifetime (until `resetUsageLedgerProcessStateForTests` simulates a restart), which is
 * exactly why deferring its resolution past an `await` never reorders same-process writes: two
 * calls sharing one epoch are ordered entirely by their (synchronously assigned) `sequence`.
 */
const epochCache = new Map();

/** Path to a `runsDir`'s persisted epoch sidecar (Round 6, 2026-09-12). */
export function usageLedgerEpochStatePath(runsDir) {
  return path.join(runsDir, ".usage-ledger-epoch.json");
}

/**
 * Reads the persisted epoch for `runsDir` (0 if missing/unreadable/malformed) and persists
 * `previous + 1` before returning it -- "bumped once per process" per entry's `runsDir`. A failed
 * persist is best-effort, same posture as `ensureExecutionId`: this process still uses the bumped
 * value for its own writes, it just won't be recoverable by a later process if the write itself
 * never reached disk.
 */
async function loadAndBumpEpoch(runsDir, { readFileFn, writeFileFn, mkdirFn }) {
  let previous = 0;
  try {
    const raw = await readFileFn(usageLedgerEpochStatePath(runsDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.epoch === "number" && Number.isFinite(parsed.epoch)) {
      previous = parsed.epoch;
    }
  } catch {
    // missing, unreadable, or malformed -- treat as "no process has ever written here"
  }

  const epoch = previous + 1;
  try {
    await mkdirFn(runsDir, { recursive: true });
    await writeFileFn(usageLedgerEpochStatePath(runsDir), JSON.stringify({ epoch }), "utf8");
  } catch {
    // best-effort persist -- see docstring above
  }
  return epoch;
}

function ensureEpoch(runsDir, deps) {
  if (!epochCache.has(runsDir)) {
    epochCache.set(runsDir, loadAndBumpEpoch(runsDir, deps));
  }
  return epochCache.get(runsDir);
}

/**
 * Test-only: simulates a fresh board process for `runsDir` (every `runsDir` if omitted) -- clears
 * the in-memory sequence counter AND the cached epoch, so the next `recordAttemptUsage` call
 * re-derives its epoch from the persisted sidecar (bumping it past whatever this "process" already
 * wrote) exactly as a genuinely restarted board would. Production code never calls this.
 */
export function resetUsageLedgerProcessStateForTests(runsDir) {
  nextWriteSequence = 0;
  if (typeof runsDir === "string") {
    epochCache.delete(runsDir);
  } else {
    epochCache.clear();
  }
}

/** `true` when `a` is a strictly newer revision than `b` -- epoch first, then sequence. */
function revisionIsNewer(a, b) {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  return a.sequence > b.sequence;
}

/** `true` when `a` and `b` are the identical (epoch, sequence) pair. */
function revisionsEqual(a, b) {
  return a.epoch === b.epoch && a.sequence === b.sequence;
}

/**
 * Normalizes a parsed entry's `revision` into `{epoch, sequence}`, falling back to the values
 * embedded in the revision filename itself (`matchEpoch`/`matchSequence`) when the entry's own
 * `revision` field is missing or malformed -- a reader should never throw on a partially-written
 * or hand-crafted fixture file, just fall back to the filename's own identity.
 */
function normalizeRevision(raw, matchEpoch, matchSequence) {
  if (raw && raw.revision && typeof raw.revision === "object" && Number.isFinite(raw.revision.epoch) && Number.isFinite(raw.revision.sequence)) {
    return { epoch: raw.revision.epoch, sequence: raw.revision.sequence };
  }
  return { epoch: matchEpoch, sequence: matchSequence };
}

/** In-flight write promises, so `drainPendingUsageWrites` can wait for all of them to settle. */
const pendingWrites = new Set();

function trackPendingWrite(promise) {
  const settled = promise.then(
    () => {},
    () => {}
  );
  pendingWrites.add(settled);
  settled.finally(() => pendingWrites.delete(settled));
}

/**
 * Waits for every currently in-flight `recordAttemptUsage` write to settle (success or failure).
 * Called on orderly `runCard()` completion and on board shutdown (Codex review 2026-09-12, P2) so
 * a terminal write dispatched fire-and-forget (`void this._recordUsage(...)`, see
 * `runOrchestrator.js`) is guaranteed to have actually reached disk before the run -- or the board
 * process -- is considered done.
 */
export async function drainPendingUsageWrites() {
  await Promise.allSettled([...pendingWrites]);
}

function randomSuffix() {
  return Math.random().toString(36).slice(2);
}

const REVISION_SUFFIX_RE = /\.rev(\d+)-(\d+)\.json$/;

/**
 * Best-effort cleanup: deletes every sibling revision file for `canonicalPath` strictly older
 * than `keepRevision` (`{epoch, sequence}`). Never throws -- a failed prune leaves a harmless
 * stray file behind rather than affecting correctness (readers always select the freshest valid
 * revision regardless of how many older ones still exist on disk).
 */
async function pruneOlderRevisions(runsDir, canonicalPath, keepRevision, { readdirFn, unlinkFn }) {
  const base = path.basename(canonicalPath);
  let names;
  try {
    names = await readdirFn(runsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.rev`)) continue;
    const match = REVISION_SUFFIX_RE.exec(name);
    if (!match) continue;
    const revision = { epoch: Number(match[1]), sequence: Number(match[2]) };
    if (!revisionsEqual(revision, keepRevision) && !revisionIsNewer(revision, keepRevision)) {
      await unlinkFn(path.join(runsDir, name)).catch(() => {});
    }
  }
}

/**
 * Scans `runsDir` for every revision file published under `canonicalPath` and returns the entry
 * with the highest `(epoch, sequence)` revision that still parses -- `null` if none exist.
 */
async function findLatestRevisionEntry(runsDir, canonicalPath, { readdirFn, readFileFn }) {
  const base = path.basename(canonicalPath);
  let names;
  try {
    names = await readdirFn(runsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }

  let best = null;
  for (const name of names) {
    if (!name.startsWith(`${base}.rev`)) continue;
    const match = REVISION_SUFFIX_RE.exec(name);
    if (!match) continue;
    let raw;
    try {
      raw = JSON.parse(await readFileFn(path.join(runsDir, name), "utf8"));
    } catch {
      continue; // rotated/deleted between readdir and read, or malformed -- skip rather than throw
    }
    const revision = normalizeRevision(raw, Number(match[1]), Number(match[2]));
    if (!best || revisionIsNewer(revision, best.revision)) best = { revision, entry: raw };
  }
  return best ? best.entry : null;
}

/**
 * Records (or re-records) usage for one execution/invocation/attempt/phase/retry. Always
 * recomputes the summary from the full `events` list passed in -- this is what makes it
 * idempotent: replaying the same events, or calling again with a longer (growing) events list as
 * a run progresses, produces one correct number, never an accumulated double-count.
 *
 * `outcome` and `complete` are supplied by the caller (the orchestrator knows why an attempt
 * stopped feeding events -- this module does not re-derive that from the events themselves).
 *
 * Publication is monotonic per key by construction (Codex review 3, 2026-09-12, finding 1) AND
 * across board restarts (Round 6, 2026-09-12): each call writes to its OWN immutable revision file
 * (`<canonicalPath>.rev<epoch>-<sequence>.json`). `sequence` is a monotonic per-process counter
 * assigned synchronously in call order at function entry; `epoch` is this process's persisted,
 * never-decreasing epoch for `runsDir` (see `ensureEpoch`/`loadAndBumpEpoch` above), which strictly
 * increases every time the board restarts. A bare in-process sequence would restart at 0 after a
 * crash/restart, letting a pre-restart `rev6` outrank a post-restart `rev1` for the same entry --
 * `epoch` closes that gap: ANY post-restart revision outranks EVERY pre-restart one for the same
 * key, regardless of their sequence numbers, while within one process lifetime (one fixed epoch)
 * ordering is exactly the prior sequence-only behavior. Two racing writes for the same key
 * therefore never contend for the same rename destination at all -- there is no "older rename
 * lands after a newer one and clobbers it" race to guard against, because an older write's
 * revision file, however late it lands (or even if its own publish fails outright), can never
 * overwrite a newer revision's content. `readAttemptUsage`/`listCardUsageEntries` always select
 * the highest-revision file present for a key, so the value they report can only ever advance,
 * never regress, as more revisions land in whatever order their I/O happens to settle. A
 * best-effort prune after each successful publish deletes now-superseded revisions so a long run's
 * many incremental writes don't accumulate unbounded files per key; a failed prune is harmless
 * (readers still pick the freshest valid revision by content, not by "the only file present").
 */
export async function recordAttemptUsage({
  runsDir,
  cardId,
  executionId,
  invocationId,
  attempt,
  phase,
  retry,
  events,
  outcome,
  complete,
  sourceLogPath = null,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  renameFn = fs.rename,
  unlinkFn = fs.unlink,
  readdirFn = fs.readdir
}) {
  const key = { cardId, executionId, invocationId, attempt, phase, retry };
  const canonicalPath = usageLedgerEntryPath(runsDir, key); // throws before any I/O if ids are invalid

  // Both fixed synchronously, before any `await`, so call order alone determines which of two
  // racing writes for this key is "newer": `sequence` via the usual pre-existing counter, and
  // `epochPromise` pinned to the one cached Promise every call against this `runsDir` shares for
  // this process's lifetime (see `ensureEpoch`) -- so its eventual resolved value is identical
  // across every racing call regardless of which one's epoch-lookup I/O happens to settle first.
  // Deliberately uses the REAL fs primitives, never the caller-injected `readFileFn`/
  // `writeFileFn`/`mkdirFn` above -- those exist so a test can gate/fail THIS call's own entry
  // write, and reusing them for the epoch sidecar would gate/fail every OTHER racing call sharing
  // the same cached epoch promise too, deadlocking tests that inject a delay expecting it to
  // affect only their own write.
  const sequence = ++nextWriteSequence;
  const epochPromise = ensureEpoch(runsDir, { readFileFn: fs.readFile, writeFileFn: fs.writeFile, mkdirFn: fs.mkdir });

  const recordedAtMs = now().getTime();
  const summary = summarizeUsageFromEvents(events);
  const entryBase = {
    cardId,
    executionId,
    invocationId,
    attempt,
    phase,
    retry,
    outcome,
    complete,
    tokens: summary.tokens,
    costUsd: summary.costUsd,
    models: summary.models,
    usageSource: summary.usageSource,
    usageIncomplete: summary.usageIncomplete,
    terminalReason: summary.terminalReason,
    apiErrorStatus: summary.apiErrorStatus,
    resultText: summary.resultText,
    sourceLogPath,
    recordedAt: new Date(recordedAtMs).toISOString()
  };

  const tmpPath = `${canonicalPath}.tmp-${process.pid}-${randomSuffix()}`;

  const writePromise = (async () => {
    const epoch = await epochPromise;
    const revision = { epoch, sequence };
    const entry = { ...entryBase, revision };
    const revisionPath = `${canonicalPath}.rev${epoch}-${sequence}.json`;

    await mkdirFn(runsDir, { recursive: true });
    await writeFileFn(tmpPath, JSON.stringify(entry, null, 2), "utf8");
    try {
      await renameFn(tmpPath, revisionPath);
    } catch (err) {
      await unlinkFn(tmpPath).catch(() => {});
      throw err;
    }
    await pruneOlderRevisions(runsDir, canonicalPath, revision, { readdirFn, unlinkFn });
    return entry;
  })();

  trackPendingWrite(writePromise);
  return writePromise;
}

/** Returns `null` (never throws) when the key was never recorded. */
export async function readAttemptUsage({ runsDir, cardId, executionId, invocationId, attempt, phase, retry, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  const canonicalPath = usageLedgerEntryPath(runsDir, { cardId, executionId, invocationId, attempt, phase, retry });
  return findLatestRevisionEntry(runsDir, canonicalPath, { readdirFn, readFileFn });
}

const REVISION_FILENAME_RE = /^(.+)-exec(.+)-inv(.+)-attempt(\d+)-(.+)-retry(\d+)\.usage\.json\.rev(\d+)-(\d+)\.json$/;

/**
 * All recorded usage entries for one card, across every execution/invocation/attempt/phase/retry
 * -- exactly ONE entry per key, the freshest revision published for it (never one entry per
 * revision, which would inflate every total downstream).
 */
export async function listCardUsageEntries({ runsDir, cardId, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  let names;
  try {
    names = await readdirFn(runsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const bestByKey = new Map();
  for (const name of names) {
    const match = REVISION_FILENAME_RE.exec(name);
    if (!match) continue;
    if (match[1] !== cardId) continue;
    let raw;
    try {
      raw = JSON.parse(await readFileFn(path.join(runsDir, name), "utf8"));
    } catch {
      continue; // rotated/deleted between readdir and read, or malformed -- skip rather than throw
    }
    const revision = normalizeRevision(raw, Number(match[7]), Number(match[8]));
    const ks = `${match[1]}::${match[2]}::${match[3]}::${match[4]}::${match[5]}::${match[6]}`;
    const existing = bestByKey.get(ks);
    if (!existing || revisionIsNewer(revision, existing.revision)) bestByKey.set(ks, { revision, entry: raw });
  }
  return Array.from(bestByKey.values()).map((v) => v.entry);
}

/**
 * Aggregates cost as nullable (Codex review 3, 2026-09-12, finding 2): `costUsd: null`
 * ("unknown") whenever ANY contributing entry's own cost is unknown (`null`/non-numeric),
 * alongside `knownCostUsd` (the subtotal of every entry that DID carry a known cost) and
 * `unknownCostEntries` (how many didn't) so a caller can present "known subtotal, N entries
 * unmeasured" instead of a misleadingly precise total. A measured zero (`costUsd: 0`) is reported
 * only when every contributing entry's cost is known -- never a stand-in for "we don't know".
 */
function sumEntries(entries) {
  let tokens = ZERO_TOKENS;
  let knownCostUsd = 0;
  let unknownCostEntries = 0;
  for (const entry of entries) {
    if (entry.tokens) tokens = addTokens(tokens, entry.tokens);
    if (typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd)) {
      knownCostUsd += entry.costUsd;
    } else {
      unknownCostEntries += 1;
    }
  }
  return {
    tokens,
    costUsd: unknownCostEntries > 0 ? null : knownCostUsd,
    knownCostUsd,
    unknownCostEntries
  };
}

/** Sums every phase/retry recorded for one attempt number. Never mixes attempts together. */
export function attemptTotal(entries, attempt) {
  return sumEntries(entries.filter((e) => e.attempt === attempt));
}

/** Sums every attempt/phase/retry recorded for ONE execution (one launch/rerun) of the card. */
export function executionTotal(entries, executionId) {
  return sumEntries(entries.filter((e) => e.executionId === executionId));
}

/**
 * Sums every execution/attempt/phase/retry ever recorded for the card -- the card's LIFETIME
 * total across every separate launch, not just the most recent one. Distinct from
 * `executionTotal`, which scopes to a single launch (Codex review 2026-09-12, P1): two separate
 * launches of the same card must each keep their own total while still contributing to this one.
 */
export function cardCycleTotal(entries) {
  return sumEntries(entries);
}

/** Path to a card's persisted current-execution-id sidecar (separate from runState.js's own). */
export function executionIdStatePath(runsDir, cardId) {
  return path.join(runsDir, `${cardId}.execution.json`);
}

/**
 * Mints (and persists) a unique execution id for a card the FIRST time this is called for it,
 * before its first process is ever spawned -- see `runOrchestrator.js`'s `runCard()`, which calls
 * this immediately after its re-entrancy guard, ahead of worktree setup or any child process.
 * Every ledger entry recorded during that run carries this same id (see `usageLedgerEntryPath`),
 * so a rerun of the same card never collides with a previous launch's attempt-1 file.
 *
 * A replay or recovery of the SAME execution -- the persisted sidecar is still present because a
 * previous `runCard()` call never reached its own cleanup (e.g. the whole board process died
 * mid-run) -- reuses the persisted id rather than minting a new one, which is what "recovery"
 * means here: the ledger keeps recording under the execution that was actually already running.
 * `clearExecutionId` (called from `runCard()`'s own `finally`) is what makes the NEXT genuinely
 * new launch mint a fresh id instead of reusing this one forever.
 *
 * Reusing the execution id on recovery is NOT the same as reusing its ledger entries: each
 * `_runPhase` call still mints its own fresh `invocationId` (Codex review 2, 2026-09-12, finding
 * 2), so a phase restarted after a crash never overwrites the interrupted phase's own entry.
 */
export async function ensureExecutionId({
  runsDir,
  cardId,
  generateIdFn = randomUUID,
  now = () => new Date(),
  readFileFn = fs.readFile,
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir
}) {
  try {
    const raw = await readFileFn(executionIdStatePath(runsDir, cardId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.executionId === "string" && parsed.executionId.length > 0) {
      return parsed.executionId;
    }
  } catch {
    // Missing, unreadable, or malformed -- mint a fresh one below.
  }

  const executionId = generateIdFn();
  try {
    await mkdirFn(runsDir, { recursive: true });
    await writeFileFn(
      executionIdStatePath(runsDir, cardId),
      JSON.stringify({ executionId, createdAt: now().toISOString() }),
      "utf8"
    );
  } catch {
    // Best-effort, same posture as runState.js's writeRunState: an id that can't be persisted
    // still works for THIS run's own in-memory bookkeeping (every ledger entry it produces still
    // carries it) -- it just won't be recoverable by a later replay/recovery call after a crash.
  }
  return executionId;
}

/** Best-effort: clearing the execution-id sidecar must never fail a run's own cleanup. */
export async function clearExecutionId({ runsDir, cardId, unlinkFn = fs.unlink }) {
  try {
    await unlinkFn(executionIdStatePath(runsDir, cardId));
  } catch {
    // already gone -- nothing to clean up
  }
}
