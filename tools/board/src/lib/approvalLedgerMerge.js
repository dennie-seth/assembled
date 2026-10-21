/**
 * Pure 3-way merge for `tools/board/approval-ledger.json`'s generated content.
 *
 * The ledger is regenerated (never hand-edited) on every reviewer PASS and on a 4h schedule
 * (`ops/exportApprovalLedgerScheduled.js`), so both sides of nearly every merge touch it -- git's
 * default text merge treats that as a conflict every time, even though the real content decision
 * is almost always "keep every card id from both sides." `mergeApprovalLedgerDriver.js` wraps this
 * as a git merge driver; this module is the part that is actually unit-testable without git.
 *
 * Deliberately conservative: anything that can't be resolved with certainty -- unparseable JSON,
 * a missing/malformed `cards` array, a side whose `cards` array is suspiciously empty, or the same
 * field on the same card changed to two different values by both sides -- reports a conflict
 * rather than guessing. `checkApprovalProvenanceDrift.js` treats this file as authoritative for
 * ids the live task store can't resolve, so a silently-wrong merge here is worse than a conflict a
 * human resolves by hand (today's behaviour).
 */

function parseLedger(text) {
  if (text == null || text === "") return { cards: [], generated_at: null, version: null, empty: true };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.cards)) return null;
  return { cards: parsed.cards, generated_at: parsed.generated_at ?? null, version: parsed.version ?? null, empty: false };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
}

function indexById(cards) {
  const byId = new Map();
  for (const c of cards) {
    if (c && typeof c.id === "string") byId.set(c.id, c);
  }
  return byId;
}

/** Merges one card present on both sides, field by field, against the base (3-way per field). */
function mergeCard(oursCard, theirsCard, baseCard) {
  if (deepEqual(oursCard, theirsCard)) return { ok: true, card: oursCard };
  const keys = new Set([...Object.keys(oursCard), ...Object.keys(theirsCard)]);
  const merged = {};
  for (const key of keys) {
    const ov = oursCard[key];
    const tv = theirsCard[key];
    const bv = baseCard ? baseCard[key] : undefined;
    if (deepEqual(ov, tv)) {
      merged[key] = ov;
    } else if (deepEqual(ov, bv)) {
      merged[key] = tv; // only theirs changed
    } else if (deepEqual(tv, bv)) {
      merged[key] = ov; // only ours changed
    } else {
      return { ok: false }; // both changed this field to different values -- true conflict
    }
  }
  return { ok: true, card: merged };
}

function newerTimestamp(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return null;
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

/**
 * @param {{baseText: string, oursText: string, theirsText: string}} args
 * @returns {{ok: true, merged: object} | {ok: false, reason: string}}
 */
export function mergeApprovalLedgerJson({ baseText, oursText, theirsText }) {
  const base = parseLedger(baseText);
  const ours = parseLedger(oursText);
  const theirs = parseLedger(theirsText);

  if (!ours) return { ok: false, reason: "ours side is not valid JSON with a cards array" };
  if (!theirs) return { ok: false, reason: "theirs side is not valid JSON with a cards array" };
  // An empty cards array is indistinguishable from a truncated/corrupt write -- never trust it
  // enough to let it silently win a union against a non-empty side.
  if (!ours.empty && ours.cards.length === 0) return { ok: false, reason: "ours side has an empty cards array" };
  if (!theirs.empty && theirs.cards.length === 0) return { ok: false, reason: "theirs side has an empty cards array" };

  const baseById = base ? indexById(base.cards) : new Map();
  const oursById = indexById(ours.cards);
  const theirsById = indexById(theirs.cards);
  const ids = new Set([...oursById.keys(), ...theirsById.keys()]);

  const mergedCards = [];
  for (const id of ids) {
    const oursCard = oursById.get(id);
    const theirsCard = theirsById.get(id);
    if (oursCard && !theirsCard) {
      mergedCards.push(oursCard);
    } else if (theirsCard && !oursCard) {
      mergedCards.push(theirsCard);
    } else {
      const result = mergeCard(oursCard, theirsCard, baseById.get(id));
      if (!result.ok) return { ok: false, reason: `card ${id}: conflicting field changes on both sides` };
      mergedCards.push(result.card);
    }
  }
  mergedCards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const generatedAt = newerTimestamp(ours.generated_at, theirs.generated_at);
  const version = Math.max(ours.version ?? 1, theirs.version ?? 1);

  return { ok: true, merged: { version, generated_at: generatedAt, cards: mergedCards } };
}
