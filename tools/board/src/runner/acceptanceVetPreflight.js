import { parseAcceptanceCriteria } from "../lib/acceptanceCriteria.js";
import { classifyAcceptanceItem, EDIT_CUE_RE } from "./structuralUnsatisfiability.js";

/**
 * T-0425: the author-time half of the warning T-0424's retro asked for. T-0409's
 * structuralUnsatisfiability.js registry (Class A below) and impossibleAcceptancePreflight.js that
 * reads it both only ever run inside a launched attempt, after `vetAndReady.js` has already readied
 * the card and a round has already been spent reaching that point. This module gives the nightly
 * vet-and-ready pass (`src/lib/vetAndReady.js`) the SAME Class-A read, plus two new checks (Class B,
 * Class C) for the over-constraint shapes T-0424 actually hit, so a human reading the morning
 * summary sees the warning before a round burns on it, not after.
 *
 * Class A -- structurally unsatisfiable by the running agent. Classified by
 * `structuralUnsatisfiability.js`'s own registry; never re-derived here. See that module.
 *
 * Class B -- a diff-empty/"unchanged" assertion on a path that another acceptance criterion in the
 * SAME card requires editing inside (T-0424 criterion 4's shape: `tools/asset-gate/src/` asserted
 * unchanged while the card's own fix needed a line edited there). Detection rule: extract path-like
 * tokens (at least one `/`) from every criterion; for a criterion whose text also carries a
 * diff-empty cue ("diff ... empty", "empty ... diff", "unchanged"), check every OTHER criterion's
 * own path tokens for an exact match or a directory-prefix relationship, where that OTHER criterion
 * also carries an edit cue (`structuralUnsatisfiability.js`'s `EDIT_CUE_RE`, reused not copied).
 * Limits, stated plainly: this only catches the shape across two DISTINCT acceptance items, the
 * same shape the real incident had -- a single criterion that both asserts and contradicts itself
 * in one sentence is not covered. It also only compares path tokens found inside `## Acceptance`
 * itself (parseAcceptanceCriteria's own scope) -- an edit requirement stated only in `## Scope` or
 * `## Do not` is invisible to it, by the same "only criteria are graded" rule the edge cases ask
 * for. Detecting whether two ARBITRARY criteria's literal conjunction is unsatisfiable is
 * undecidable in general; this detects exactly the one tractable shape named above, nothing more.
 *
 * Class C -- a hardcoded count or "before" state (`"14 before, 2 after"`, `"N failures"`, `"reports
 * X passing"`). Not wrong per se -- sometimes a count IS the right criterion -- so this is always a
 * reason to re-check, never a reason to reject. The message tells the author what T-0424 actually
 * needed: verify the number against the card's own base branch, or restate it as a branch-relative
 * invariant.
 *
 * **What this module does NOT do**, stated here so a clean pass is never mistaken for proof of a
 * sound acceptance section: it catches exactly the mechanically-detectable shapes documented above
 * and nothing else. It cannot and does not evaluate whether a criterion's natural-language INTENT
 * is achievable, well-scoped, or even coherent -- T-0424's real defect (a count measured on the
 * wrong branch, `feature/T-0359`, rather than the one the card was cut from) is only partly visible
 * here: Class C flags the hardcoded number as worth re-checking, but confirming WHICH branch it was
 * actually measured against is a judgment call this module cannot make. A card with zero flags from
 * this check has not been proven to have sound acceptance criteria -- only to be free of these
 * specific, narrow shapes.
 *
 * WARN-only, mirroring impossibleAcceptancePreflight.js / edgeCasesPreflight.js's own posture: this
 * module never returns a pass/fail verdict and must never gate anything. `vetAndReady.js` attaches
 * its `flags` to a card's decision-table entry regardless of verdict; the card still readies.
 */

// Class B: the diff-empty / "unchanged" cue a criterion uses to assert a path has no changes.
const DIFF_EMPTY_CUE_RE =
  /\bdiff\b[\s\S]{0,100}?\b(?:is\s+|stays\s+|remains\s+|must\s+be\s+)?empty\b|\bempty\b[\s\S]{0,100}?\bdiff\b|\bunchanged\b/i;

// Class B: a candidate repo-path token -- at least one `/`, optionally backtick-quoted and/or
// `./`-prefixed. Capture group 2 is already normalised (no leading `./`, no trailing `/`), so
// `./tools/asset-gate/src` and `tools/asset-gate/src/` both extract to the same string.
const PATH_TOKEN_RE = /`?(\.\/)?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/?`?/g;

function extractPathTokens(text) {
  const paths = new Set();
  for (const match of text.matchAll(new RegExp(PATH_TOKEN_RE))) {
    paths.add(match[2]);
  }
  return [...paths];
}

/** Equal, or one a path-segment-boundary prefix of the other (both already normalised). */
function pathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Class B over the whole criteria set at once (it's inherently cross-item): returns
 * `Map<itemIndex, Set<reason>>` for every criterion that asserts a diff-empty/unchanged path also
 * named, as something to edit, by a DIFFERENT criterion in the same set.
 */
function detectDiffEmptyOverConstraint(items) {
  const pathsByIndex = items.map((item) => extractPathTokens(item.text));
  const flagsByIndex = new Map();

  items.forEach((item, i) => {
    if (!DIFF_EMPTY_CUE_RE.test(item.text)) return;
    const diffPaths = pathsByIndex[i];
    if (diffPaths.length === 0) return;

    items.forEach((other, j) => {
      if (j === i || !EDIT_CUE_RE.test(other.text)) return;
      for (const diffPath of diffPaths) {
        for (const editPath of pathsByIndex[j]) {
          if (!pathsOverlap(diffPath, editPath)) continue;
          const reason =
            `Class B (over-constraint) -- asserts \`${diffPath}\` is unchanged/empty-diff, but another ` +
            `acceptance criterion ("${other.text}") requires editing \`${editPath}\` -- these two ` +
            "criteria's literal conjunction is unsatisfiable (the T-0424 criterion-4 shape).";
          if (!flagsByIndex.has(i)) flagsByIndex.set(i, new Set());
          flagsByIndex.get(i).add(reason);
        }
      }
    });
  });

  return flagsByIndex;
}

// Class C: a hardcoded count or "before" state. Each pattern is deliberately narrow (a number
// attached to one of "before"/"after", "failures", or a "reports N passing/failing" shape) rather
// than "any digit" -- an ordinary fixed config value (a cap, a port, a version) has no before/after
// or pass/fail wording nearby and must not be flagged (see the false-positive test for this).
const HARDCODED_COUNT_PATTERNS = [
  { re: /\b\d+\s+before\b[\s\S]{0,80}?\b\d+\s+after\b/i, label: "a hardcoded before/after count" },
  { re: /\b\d+\s+failures?\b/i, label: "a hardcoded failure count" },
  { re: /\breports?\s+\d+\s+(?:passing|failing)\b/i, label: "a hardcoded suite-report count" }
];

function detectHardcodedCounts(text) {
  return HARDCODED_COUNT_PATTERNS.filter(({ re }) => re.test(text)).map(
    ({ label }) =>
      `Class C (hardcoded stateful claim) -- asserts ${label} -- verify this against the card's OWN base ` +
      'branch before relying on it, or restate as a branch-relative invariant (e.g. "nothing that passed ' +
      'before now fails") instead of a fixed number (T-0424: "14 before, 2 after" was only real on a ' +
      "sibling branch, feature/T-0359 -- the same gate reported 0 on the branch T-0424 was actually cut from)."
  );
}

/**
 * The single entry point `vetAndReady.js` calls. Returns `{ flags: [{ text, reasons }] }` --
 * `text` is the flagged criterion's own text (or `null` for the "no parseable Acceptance section"
 * finding below), `reasons` is every reason this check has for flagging it, deduplicated, never
 * split across more than one entry per criterion.
 *
 * `ctx.agentName`/`ctx.taskStoreKind` are passed straight through to
 * `structuralUnsatisfiability.js`'s `classifyAcceptanceItem` -- see that module for why both
 * matter. `taskStoreKind` defaults to `"db"`: the live board this job actually runs the nightly
 * pass against runs `BOARD_TASK_STORE=db` (see `approvalLedger.js`'s own note on this), so that is
 * the correct default for THIS call site specifically, not a repo-wide default.
 */
export function checkAcceptanceAuthoringPreflight(task, ctx = {}) {
  const { agentName, taskStoreKind = "db" } = ctx;
  const body = task?.body ?? "";
  const items = parseAcceptanceCriteria(body);

  if (items.length === 0) {
    return {
      flags: [
        {
          text: null,
          reasons: [
            'no parseable "## Acceptance" heading/checklist found in this card\'s body -- nothing for the ' +
              "acceptance-authoring preflight to check (reported as its own finding rather than thrown or " +
              "silently passed)."
          ]
        }
      ]
    };
  }

  const diffEmptyFlags = detectDiffEmptyOverConstraint(items);
  const flags = [];

  items.forEach((item, idx) => {
    const reasons = [];

    const structural = classifyAcceptanceItem(item.text, { agentName, taskStoreKind });
    if (structural) {
      reasons.push(
        `Class A (structurally unsatisfiable) -- ${structural.reason} (owner: ${structural.owner}; ` +
          `class: ${structural.classId}; see structuralUnsatisfiability.js).`
      );
    }

    const bReasons = diffEmptyFlags.get(idx);
    if (bReasons) reasons.push(...bReasons);

    reasons.push(...detectHardcodedCounts(item.text));

    if (reasons.length > 0) {
      flags.push({ text: item.text, reasons });
    }
  });

  return { flags };
}
