/**
 * T-0434: the decision this card has to make, factored out as pure functions so the claim
 * "a scheduled refresh keeps the committed ledger under `BOARD_APPROVAL_LEDGER_STALE_HOURS`"
 * is something a test proves, not something a comment asserts.
 *
 * Two naive policies both fail (see the card body for the incident -- #440, #439):
 *   - commit every run: `generated_at` changes on every export, so this commits a no-op diff
 *     every single run -- daily churn in the repo history for nothing.
 *   - commit only when the cards changed: a quiet week never refreshes `generated_at`, so the
 *     ledger ages past the gate's threshold anyway -- the exact incident this card exists to fix.
 *
 * The chosen policy, "refresh-before-it-bites": commit when the cards changed, OR when the
 * currently committed ledger is already older than `refreshThresholdHours` -- a threshold well
 * under the gate's own `BOARD_APPROVAL_LEDGER_STALE_HOURS` (24h). On the normal schedule, with no
 * run ever missed, this bounds the ledger's worst-case age by `refreshThresholdHours +
 * intervalHours` (see `simulateWorstCaseAgeHours`), at the cost of a commit roughly every
 * `refreshThresholdHours` during a totally quiet period -- bounded churn, not zero churn, and
 * nowhere near "every run." An outage of consecutive missed runs erodes that bound further --
 * `worstCaseAgeForOutage` searches every possible alignment of an N-miss outage against the
 * schedule and returns the true worst case, rather than trusting one hand-picked offset (an
 * earlier round did exactly that and got the wrong answer -- see that function's own docstring).
 */

export const DEFAULT_REFRESH_THRESHOLD_HOURS = 12;

/**
 * @param {object} args
 * @param {boolean} args.cardsChanged - whether the freshly exported ledger's `cards` differ from
 *   the committed one (ignoring `generated_at`/`version`, the same comparison
 *   `regenerateApprovalLedgerIfChanged` already uses for its own per-PASS regeneration).
 * @param {number} args.ledgerAgeHours - age of the CURRENTLY COMMITTED ledger, in hours.
 *   `Infinity` (no committed ledger, or an unparseable/clock-skewed `generated_at`) always commits.
 * @param {number} [args.refreshThresholdHours]
 * @returns {{shouldCommit: boolean, reason: "cards-changed"|"refresh-threshold"|"fresh-no-change"}}
 */
export function decideLedgerExport({
  cardsChanged,
  ledgerAgeHours,
  refreshThresholdHours = DEFAULT_REFRESH_THRESHOLD_HOURS
}) {
  if (cardsChanged) {
    return { shouldCommit: true, reason: "cards-changed" };
  }
  if (!(ledgerAgeHours <= refreshThresholdHours)) {
    // Covers both "actually older than the threshold" and "NaN/Infinity" (no comparable age at
    // all) -- either way there's nothing on record proving the ledger is fresh, so it refreshes.
    return { shouldCommit: true, reason: "refresh-threshold" };
  }
  return { shouldCommit: false, reason: "fresh-no-change" };
}

/**
 * Simulates a quiet period -- cards never change -- under a fixed run cadence, and returns the
 * worst-case age the committed ledger ever reaches (the instant just before the run that finally
 * refreshes it). This is the "worked timeline" the card's acceptance criteria ask for: a test can
 * assert this stays under `BOARD_APPROVAL_LEDGER_STALE_HOURS` for the chosen interval/threshold,
 * including when one scheduled run is missed entirely (the box was off).
 *
 * @param {object} args
 * @param {number} args.intervalHours - nominal time between scheduled runs.
 * @param {number} args.refreshThresholdHours
 * @param {number} args.totalHours - how long to simulate.
 * @param {Set<number>} [args.missedRunTicks] - 1-based run indices that silently do not execute
 *   at all (e.g. the box was off), modeling `Persistent=true` catching up only at the NEXT tick
 *   rather than running exactly on schedule.
 * @returns {{maxAgeHours: number, commitCount: number, runCount: number}}
 */
export function simulateWorstCaseAgeHours({
  intervalHours,
  refreshThresholdHours = DEFAULT_REFRESH_THRESHOLD_HOURS,
  totalHours,
  missedRunTicks = new Set()
}) {
  let lastCommitTime = 0;
  let maxAgeHours = 0;
  let commitCount = 1; // tick 0: the ledger always starts from some initial committed state
  let runCount = 0;

  const runTicks = Math.floor(totalHours / intervalHours);
  for (let tick = 1; tick <= runTicks; tick++) {
    const time = tick * intervalHours;
    if (missedRunTicks.has(tick)) continue; // this run never executed -- age keeps growing
    runCount += 1;
    const ageAtThisRun = time - lastCommitTime;
    maxAgeHours = Math.max(maxAgeHours, ageAtThisRun);
    const decision = decideLedgerExport({
      cardsChanged: false,
      ledgerAgeHours: ageAtThisRun,
      refreshThresholdHours
    });
    if (decision.shouldCommit) {
      lastCommitTime = time;
      commitCount += 1;
    }
  }
  return { maxAgeHours, commitCount, runCount };
}

/**
 * The worst-case ledger age for an outage of `missCount` consecutive missed runs, searching
 * EVERY possible alignment of that outage against the schedule rather than trusting one
 * hand-picked offset. This exists because hand-picking was tried first and got it wrong: an
 * earlier round asserted missedRunTicks `{3,4}` (two misses) tops out at 20h and `{3,4,5}` (three
 * misses) is "the real edge" at exactly 24h -- but `{4,5}` (also two misses, started one tick
 * later) reaches that same 24h, because starting the outage right after the tick that sits
 * exactly AT the refresh threshold (age === refreshThresholdHours, which `decideLedgerExport`
 * treats as still fresh, strict `>` not `>=`) wastes the one run that would otherwise have forced
 * a refresh before the outage began. Three examples cannot rule out a worse fourth; searching the
 * full cycle can.
 *
 * `searchTicks` only needs to cover one steady-state cycle (`refreshThresholdHours /
 * intervalHours`, rounded up, plus one) for the search to see every distinct phase -- the
 * schedule repeats after that -- but defaults wider so a caller never has to reason about cycle
 * length to get a correct answer.
 *
 * @param {object} args
 * @param {number} args.intervalHours
 * @param {number} [args.refreshThresholdHours]
 * @param {number} args.missCount - length of the consecutive-miss run to search over.
 * @param {number} [args.totalHours] - simulated duration; must be long enough for the outage
 *   (placed at the latest search offset) to fully resolve and for a steady state to establish
 *   beforehand.
 * @param {number} [args.searchTicks] - number of candidate outage-start ticks to try.
 * @returns {number} the maximum `maxAgeHours` over every candidate start offset.
 */
export function worstCaseAgeForOutage({
  intervalHours,
  refreshThresholdHours = DEFAULT_REFRESH_THRESHOLD_HOURS,
  missCount,
  totalHours = 400,
  searchTicks = 40
}) {
  let worst = -Infinity;
  for (let start = 1; start <= searchTicks; start++) {
    const missedRunTicks = new Set();
    for (let offset = 0; offset < missCount; offset++) {
      missedRunTicks.add(start + offset);
    }
    const { maxAgeHours } = simulateWorstCaseAgeHours({
      intervalHours,
      refreshThresholdHours,
      totalHours,
      missedRunTicks
    });
    worst = Math.max(worst, maxAgeHours);
  }
  return worst;
}
