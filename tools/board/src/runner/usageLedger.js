import { promises as fs } from "node:fs";
import path from "node:path";

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

/** Path to the one JSON sidecar recording a given (card, attempt, phase, retry) key's usage. */
export function usageLedgerEntryPath(runsDir, { cardId, attempt, phase, retry }) {
  return path.join(runsDir, `${cardId}-attempt${attempt}-${phase}-retry${retry}.usage.json`);
}

/**
 * Records (or re-records) usage for one attempt/phase/retry. Always recomputes the summary from
 * the full `events` list passed in and overwrites the sidecar file -- this is what makes it
 * idempotent: replaying the same events, or calling again with a longer (growing) events list as
 * a run progresses, produces one file with one correct number, never an accumulated double-count.
 *
 * `outcome` and `complete` are supplied by the caller (the orchestrator knows why an attempt
 * stopped feeding events -- this module does not re-derive that from the events themselves).
 */
export async function recordAttemptUsage({
  runsDir,
  cardId,
  attempt,
  phase,
  retry,
  events,
  outcome,
  complete,
  sourceLogPath = null,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir
}) {
  const summary = summarizeUsageFromEvents(events);
  const entry = {
    cardId,
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
    recordedAt: now().toISOString()
  };

  await mkdirFn(runsDir, { recursive: true });
  await writeFileFn(usageLedgerEntryPath(runsDir, { cardId, attempt, phase, retry }), JSON.stringify(entry, null, 2), "utf8");
  return entry;
}

/** Returns `null` (never throws) when the key was never recorded. */
export async function readAttemptUsage({ runsDir, cardId, attempt, phase, retry, readFileFn = fs.readFile }) {
  try {
    const raw = await readFileFn(usageLedgerEntryPath(runsDir, { cardId, attempt, phase, retry }), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

const ENTRY_FILENAME_RE = /^(.+)-attempt(\d+)-(.+)-retry(\d+)\.usage\.json$/;

/** All recorded usage entries for one card, across every attempt/phase/retry. */
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

/** Sums every attempt/phase/retry recorded for the card -- the whole current work cycle. */
export function cardCycleTotal(entries) {
  return sumEntries(entries);
}
