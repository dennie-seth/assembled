import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });

function numberOr0(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function tokensFromUsageObj(usage) {
  if (!usage || typeof usage !== "object") return null;
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
 * `total_cost_usd` is already the session's cumulative total. When a `result` event is present,
 * ITS numbers are the summary, full stop -- the per-message sum is discarded, not added on top.
 * Only when no `result` event exists at all (a cancel/crash/phase-timeout truncation) does the
 * per-message sum become the recorded figure, tagged `usageSource: "incremental"` so it reads as
 * a lower bound rather than a completed attempt's cost.
 *
 * Within the incremental path, each DISTINCT (session, message id) pair is counted at most once
 * -- see `assistantMessageDedupKey` -- since the CLI's own stream repeats an assistant message
 * verbatim (audited across six real `tasks/.runs/*.jsonl` logs, Codex review 2026-09-12). An
 * event with no usable identity (missing message id, or missing/malformed usage) is never folded
 * in as zero cost; it instead flips `usageIncomplete`, so a caller can tell "measured, low" from
 * "some of this attempt's usage could not be read at all".
 */
export function summarizeUsageFromEvents(events) {
  const list = Array.isArray(events) ? events : [];

  const perMessageTokens = new Map(); // dedupKey -> tokens; a repeat OVERWRITES, never sums
  const models = new Set();
  let resultUsage = null; // {tokens, costUsd, terminalReason, apiErrorStatus, resultText}
  let hasIncompleteAssistantEvent = false;

  for (const event of list) {
    if (!event || typeof event !== "object") continue;

    if (event.type === "assistant" && event.message && typeof event.message === "object") {
      if (typeof event.message.model === "string") models.add(event.message.model);
      const dedupKey = assistantMessageDedupKey(event);
      const tokens = tokensFromUsageObj(event.message.usage);
      if (dedupKey === null || tokens === null) {
        hasIncompleteAssistantEvent = true;
      } else {
        perMessageTokens.set(dedupKey, tokens);
      }
    }

    if (event.type === "result") {
      resultUsage = {
        tokens: tokensFromUsageObj(event.usage) ?? ZERO_TOKENS,
        costUsd: numberOr0(event.total_cost_usd),
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
  // known-good data even if some individual assistant events couldn't be read.
  if (resultUsage) {
    return {
      tokens: resultUsage.tokens,
      costUsd: resultUsage.costUsd,
      models: Array.from(models),
      usageSource: "result",
      terminalReason: resultUsage.terminalReason,
      apiErrorStatus: resultUsage.apiErrorStatus,
      resultText: resultUsage.resultText,
      usageIncomplete: false
    };
  }

  const hasIncrementalUsage = models.size > 0 || tokensHaveAnyUsage(incrementalTokens) || perMessageTokens.size > 0;
  return {
    tokens: incrementalTokens,
    costUsd: 0,
    models: Array.from(models),
    usageSource: hasIncrementalUsage || hasIncompleteAssistantEvent ? "incremental" : "none",
    terminalReason: null,
    apiErrorStatus: null,
    resultText: null,
    usageIncomplete: hasIncompleteAssistantEvent
  };
}

/**
 * Path to the one JSON sidecar recording a given (card, execution, attempt, phase, retry) key's
 * usage. `executionId` (Codex review 2026-09-12, P1) distinguishes separate launches of the SAME
 * card: without it, a rerun that starts a fresh attempt-1 overwrites a previous launch's
 * attempt-1 file, and the two launches' totals get silently conflated. See `ensureExecutionId`
 * for how a launch's id is minted/persisted/reused.
 */
export function usageLedgerEntryPath(runsDir, { cardId, executionId, attempt, phase, retry }) {
  return path.join(runsDir, `${cardId}-exec${executionId}-attempt${attempt}-${phase}-retry${retry}.usage.json`);
}

/**
 * Monotonic call-order counter, assigned synchronously (before any `await`) the instant
 * `recordAttemptUsage` is invoked -- this is the actual "monotonic revision" the write-ordering
 * guard below compares on, NOT `recordedAtMs`: wall-clock time is coarse enough (millisecond
 * resolution) that two calls issued back-to-back in the same test tick can tie, and a tie must
 * still resolve deterministically by call order, never by whichever write's I/O merely finishes
 * first.
 */
let nextWriteSequence = 0;

/**
 * The highest write sequence number that has actually been committed (renamed into place) for a
 * given ledger key, in-process only. Backs the monotonic-revision guard in `recordAttemptUsage`:
 * a write whose own sequence number is older than what's already landed for its key is dropped
 * rather than allowed to regress the file (Codex review 2026-09-12, P2).
 */
const lastCommittedSequenceByKey = new Map();

function ledgerKeyString({ cardId, executionId, attempt, phase, retry }) {
  return `${cardId}::${executionId}::${attempt}::${phase}::${retry}`;
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

/**
 * Records (or re-records) usage for one execution/attempt/phase/retry. Always recomputes the
 * summary from the full `events` list passed in and overwrites the sidecar file -- this is what
 * makes it idempotent: replaying the same events, or calling again with a longer (growing) events
 * list as a run progresses, produces one file with one correct number, never an accumulated
 * double-count.
 *
 * `outcome` and `complete` are supplied by the caller (the orchestrator knows why an attempt
 * stopped feeding events -- this module does not re-derive that from the events themselves).
 *
 * Publishes via write-temp-file-then-atomic-rename, never a direct `writeFile` to the real path,
 * so a concurrent reader never observes a half-written file (Codex review 2026-09-12, P2): POSIX
 * rename onto an existing path is atomic, so `usageLedgerEntryPath`'s file is always either the
 * complete previous entry or the complete new one.
 *
 * Guards against out-of-order completion with a monotonic-revision check rather than a strict
 * per-key write queue: a call-order sequence number is assigned synchronously at call time
 * (before any I/O), and the decision "am I still the newest write for this key" is made
 * synchronously too, right after this call's own temp-file write finishes and before its rename --
 * so two racing writes can never both believe they're the winner, and a write that started
 * earlier but whose I/O happens to finish later (an earlier in-progress record delayed behind a
 * later terminal one) is dropped instead of regressing the file. A strict queue would instead have
 * forced the later (terminal) call to wait behind the earlier (slower) one, which is the wrong
 * outcome here.
 */
export async function recordAttemptUsage({
  runsDir,
  cardId,
  executionId,
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
  unlinkFn = fs.unlink
}) {
  const sequence = ++nextWriteSequence;
  const recordedAtMs = now().getTime();
  const summary = summarizeUsageFromEvents(events);
  const entry = {
    cardId,
    executionId,
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

  const key = { cardId, executionId, attempt, phase, retry };
  const filePath = usageLedgerEntryPath(runsDir, key);
  const ks = ledgerKeyString(key);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;

  const writePromise = (async () => {
    await mkdirFn(runsDir, { recursive: true });
    await writeFileFn(tmpPath, JSON.stringify(entry, null, 2), "utf8");

    // Synchronous compare-and-set: no `await` between reading and updating
    // `lastCommittedSequenceByKey`, so two concurrent callers can never both conclude they're the
    // winner for the same key.
    const currentBest = lastCommittedSequenceByKey.get(ks) ?? -Infinity;
    if (sequence < currentBest) {
      await unlinkFn(tmpPath).catch(() => {});
      return entry;
    }
    lastCommittedSequenceByKey.set(ks, sequence);

    await renameFn(tmpPath, filePath);
    return entry;
  })();

  trackPendingWrite(writePromise);
  return writePromise;
}

/** Returns `null` (never throws) when the key was never recorded. */
export async function readAttemptUsage({ runsDir, cardId, executionId, attempt, phase, retry, readFileFn = fs.readFile }) {
  try {
    const raw = await readFileFn(usageLedgerEntryPath(runsDir, { cardId, executionId, attempt, phase, retry }), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

const ENTRY_FILENAME_RE = /^(.+)-exec(.+)-attempt(\d+)-(.+)-retry(\d+)\.usage\.json$/;

/** All recorded usage entries for one card, across every execution/attempt/phase/retry. */
export async function listCardUsageEntries({ runsDir, cardId, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  let names;
  try {
    names = await readdirFn(runsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const entries = [];
  for (const name of names) {
    const match = ENTRY_FILENAME_RE.exec(name);
    if (!match) continue;
    if (match[1] !== cardId) continue;
    try {
      const raw = await readFileFn(path.join(runsDir, name), "utf8");
      entries.push(JSON.parse(raw));
    } catch {
      // Rotated/deleted between readdir and read, or malformed -- skip rather than throw.
    }
  }
  return entries;
}

function sumEntries(entries) {
  let tokens = ZERO_TOKENS;
  let costUsd = 0;
  for (const entry of entries) {
    if (entry.tokens) tokens = addTokens(tokens, entry.tokens);
    costUsd += numberOr0(entry.costUsd);
  }
  return { tokens, costUsd };
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
