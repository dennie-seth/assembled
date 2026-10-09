import { describe, it, expect } from "vitest";
import {
  ELIGIBLE_STATUS,
  ELIGIBLE_AGENT,
  ELIGIBLE_DELIVERABLE_TYPE,
  READY_CAP,
  SUPERSEDED_MARKERS,
  isEligibleAtAll,
  dependencyCheck,
  supersededCheck,
  mergedWorkCheck,
  extractAcceptancePaths,
  revalidateCandidate,
  vetAndReady
} from "../../src/lib/vetAndReady.js";

/**
 * T-0384: the vetting rules ported from the (external, no-WSL) nightly-infra-prep skill, now run
 * natively against the live board + git so every rule is a decision this repo can actually check
 * rather than a browser-side best-effort. See tools/board/ops/vetAndReady.js for the CLI that
 * wires these pure functions to the board API and `git log`.
 */

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    status: "backlog",
    priority: "P1",
    phase: 7,
    agent: "infra",
    depends_on: [],
    created: "2026-09-01",
    deliverable_type: "code",
    requires_approval: false,
    // A checkable acceptance path (rather than bare prose) so the default fixture clears rule 2
    // on real mechanical evidence -- see the dedicated prose-only-body tests below for the
    // "no checkable path at all" case fix-round 2 (T-0384) closes.
    body: "## Acceptance\n\n- [ ] Update `src/lib/doTheThing.js` to do the thing.\n",
    ...overrides
  };
}

const NO_GIT_HITS = async () => [];

describe("constants", () => {
  it("names the eligible-at-all shape and the per-run cap", () => {
    expect(ELIGIBLE_STATUS).toBe("backlog");
    expect(ELIGIBLE_AGENT).toBe("infra");
    expect(ELIGIBLE_DELIVERABLE_TYPE).toBe("code");
    expect(READY_CAP).toBe(4);
  });
});

describe("isEligibleAtAll", () => {
  it("accepts a plain backlog infra code card with no approval gate", () => {
    expect(isEligibleAtAll(makeTask())).toBe(true);
  });

  it("rejects a GPU/assets card -- never eligible regardless of any other rule", () => {
    expect(isEligibleAtAll(makeTask({ agent: "assets" }))).toBe(false);
  });

  it("rejects a card requiring human approval -- never eligible regardless of any other rule", () => {
    expect(isEligibleAtAll(makeTask({ requires_approval: true }))).toBe(false);
  });

  it("rejects an artifact deliverable card", () => {
    expect(isEligibleAtAll(makeTask({ deliverable_type: "artifact" }))).toBe(false);
  });

  it("rejects a card not in backlog", () => {
    expect(isEligibleAtAll(makeTask({ status: "ready" }))).toBe(false);
  });

  it("rejects a dispatch card", () => {
    expect(isEligibleAtAll(makeTask({ agent: "dispatch" }))).toBe(false);
  });
});

describe("dependencyCheck", () => {
  it("passes a card with no dependencies", () => {
    const byId = new Map();
    const result = dependencyCheck(makeTask({ depends_on: [] }), byId);
    expect(result.ok).toBe(true);
  });

  it("passes when every dependency is done or retired", () => {
    const byId = new Map([
      ["T-0010", makeTask({ id: "T-0010", status: "done" })],
      ["T-0011", makeTask({ id: "T-0011", status: "retired" })]
    ]);
    const result = dependencyCheck(makeTask({ depends_on: ["T-0010", "T-0011"] }), byId);
    expect(result.ok).toBe(true);
  });

  it("fails when a dependency is not done or retired", () => {
    const byId = new Map([["T-0010", makeTask({ id: "T-0010", status: "backlog" })]]);
    const result = dependencyCheck(makeTask({ depends_on: ["T-0010"] }), byId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/T-0010/);
    expect(result.reason).toMatch(/backlog/);
  });

  it("fails, uncertainty skips, when a dependency id isn't in the corpus at all", () => {
    const byId = new Map();
    const result = dependencyCheck(makeTask({ depends_on: ["T-9999"] }), byId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/T-9999/);
  });
});

describe("supersededCheck", () => {
  it("passes a body with no superseding/held markers", () => {
    const result = supersededCheck(makeTask({ body: "## Acceptance\n\n- [ ] Ship it\n" }));
    expect(result.ok).toBe(true);
  });

  // T-0420: HELD and SUPERSEDED are no longer bare-word markers (see the dedicated describe block
  // below) -- a bare, unmarked occurrence of either word on its own line is exactly the T-0413/
  // T-0402 shape that must NOT trip any more. The remaining labels are untouched by this card and
  // still trip on the bare word alone, same as before.
  const BARE_WORD_MARKERS = SUPERSEDED_MARKERS.filter((label) => label !== "HELD" && label !== "SUPERSEDED");

  it.each(BARE_WORD_MARKERS)("fails when the body contains the marker %s", (marker) => {
    const result = supersededCheck(makeTask({ body: `## Scope\n\nOriginal plan.\n\n${marker}\n\nNew plan.\n` }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  // Codex review 2026-09-18, finding 1: case-sensitive `body.includes()` over a fixed-case list
  // let `## Held`, lowercase `held`, and `Stop-and-report:` slip through and get readied. Every
  // variant below is one Codex actually reproduced or that the fix-round AC names explicitly.
  //
  // T-0420: the bare-mid-sentence "held"/"superseded" variants that used to live in this list
  // were removed -- they are exactly the ordinary-English-word shape this card stops matching.
  // "## Held\n..." stays: it's a heading, i.e. a directive, not prose.
  it.each([
    ["## Held\nDo not ready this card until a human decision.", /held/i],
    ["Stop-and-report: acceptance already satisfied by the replacement.", /stop.and.report/i],
    ["stop and report -- do not proceed.", /stop.and.report/i],
    ["## Finding\nStop-and-report: acceptance already satisfied by the replacement.", /finding/i],
    ["rescoped by the follow-up card, see T-0400.", /re-?scoped/i],
    ["this section governs the rest of the card.", /this section governs/i]
  ])("recognises the real-world marker variant %j case-insensitively", (body, expectedReasonPattern) => {
    const result = supersededCheck(makeTask({ body }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(expectedReasonPattern);
  });

  it("recognises a bare '## Finding' heading as a recorded outcome even without other marker text", () => {
    const result = supersededCheck(makeTask({ body: "## Finding\n\nAlready implemented by T-0299; nothing left to do here.\n" }));
    expect(result.ok).toBe(false);
  });

  it("still passes a body that merely mentions an unrelated word containing a marker as a substring", () => {
    // "upheld"/"withheld" must not false-trigger the HELD marker -- \bheld\b is word-bounded.
    const result = supersededCheck(makeTask({ body: "## Acceptance\n\nThe API contract is upheld across releases.\n" }));
    expect(result.ok).toBe(true);
  });
});

/**
 * T-0420: `\bheld\b`/`\bsuperseded\b` match the ordinary English word, not just a hold/supersede
 * DIRECTIVE -- a card is skipped forever if its body happens to use either word in prose. Two real
 * cards (T-0413, T-0402) were trapped by this every single night. HELD and SUPERSEDED now only
 * trip when the word appears as a MARKER LINE (a heading, a bold marker, or a line-leading
 * "WORD:" label), the same discipline `approvalGate.js`'s APPROVAL_MARKERS and `roundCap.js`'s
 * RESCOPE_MARKERS already apply to a comment's first line -- adapted here to "any marker-shaped
 * line in the body", since a hold/supersede directive isn't always the body's first line.
 */
describe("supersededCheck -- HELD/SUPERSEDED directive marker, not the bare word (T-0420)", () => {
  // The three regression fixtures: real triggering sentences from T-0413 and T-0402, reproduced
  // verbatim (minus their card-specific numbers), plus a body that only *quotes* the marker as a
  // worked example. All three must be released -- supersededCheck must return ok:true for each.
  const T0413_SENTENCE =
    "Reconciling it (PR #420) found the list held 3 entries while the host had 14.";
  const T0402_SENTENCE =
    "An estimate larger than the remaining budget is held with a reason naming the window.";
  const QUOTED_EXAMPLE_BODY =
    "## Notes\n\nThe nightly vetter's HELD marker looks like this in practice:\n\n" +
    "```\n## HELD\n```\n\nIt must only trip on a marker line, never on prose that discusses it.\n";

  it("releases T-0413 -- 'the list held 3 entries' is prose, not a hold directive", () => {
    const result = supersededCheck(makeTask({ body: `## Acceptance\n\n- [ ] ${T0413_SENTENCE}\n` }));
    expect(result.ok).toBe(true);
  });

  it("releases T-0402 -- 'is held with a reason' is prose, not a hold directive", () => {
    const result = supersededCheck(makeTask({ body: `## Acceptance\n\n- [ ] ${T0402_SENTENCE}\n` }));
    expect(result.ok).toBe(true);
  });

  it("releases a body that only quotes the HELD marker as a worked example", () => {
    const result = supersededCheck(makeTask({ body: QUOTED_EXAMPLE_BODY }));
    expect(result.ok).toBe(true);
  });

  // #445 changes-requested, P2: a ~~~-fenced worked example must be released exactly like the
  // ```-fenced one above -- stripCodeSpans only stripped backtick fences, so a tilde-fenced quote
  // of the marker still tripped the rule.
  const QUOTED_EXAMPLE_BODY_TILDE =
    "## Notes\n\nThe nightly vetter's HELD marker looks like this in practice:\n\n" +
    "~~~\n## HELD\n~~~\n\nIt must only trip on a marker line, never on prose that discusses it.\n";

  it("releases a body that only quotes the HELD marker inside a ~~~-fenced worked example", () => {
    const result = supersededCheck(makeTask({ body: QUOTED_EXAMPLE_BODY_TILDE }));
    expect(result.ok).toBe(true);
  });

  // Real hold-directive shapes (T-0247's own comment shape, markdown headings, bold markers, with
  // trailing punctuation/markdown) must still trip it, in every case variant.
  it.each([
    "**HELD 2026-08-29 per @DennieSeth -- waiting on the art-direction decision.**",
    "## HELD",
    "## held",
    "**HELD --**",
    "## HELD (2026-08-29)"
  ])("still trips on the genuine hold-directive shape %j", (markerLine) => {
    const result = supersededCheck(makeTask({ body: `## Scope\n\n${markerLine}\n\nSee the replacement card instead.\n` }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/held/i);
  });

  // #445 changes-requested, P2: isDirectiveMarkerLine tested heading/bold/label as mutually
  // exclusive alternatives against the raw line, so a COMBINED decoration -- a bold marker inside
  // a heading, or inside a list bullet -- matched none of them and was silently released. Both
  // shapes are plausible genuine-hold forms a human would actually write.
  it.each([
    "## **HELD**",
    "### __SUPERSEDED__",
    "- **HELD -- pending human review**",
    "* **SUPERSEDED**: see T-0338",
    "## HELD: pending",
    "**HELD:**"
  ])("still trips on the combined-decoration directive shape %j", (markerLine) => {
    const result = supersededCheck(makeTask({ body: `## Scope\n\n${markerLine}\n\nSee the replacement card instead.\n` }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/held|superseded/i);
  });

  // SUPERSEDED gets the identical fix -- T-0338's real shape ("spec history", not a hold) must
  // not trip, while a genuine SUPERSEDED directive line still does.
  it("releases T-0338's real shape -- describing a spec section as superseded is not a hold directive", () => {
    const body = "## Scope\n\nThis replaces the limb-reference approach, superseded by the dedicated-legs-panel amendment.\n";
    const result = supersededCheck(makeTask({ body }));
    expect(result.ok).toBe(true);
  });

  it("still trips on a genuine SUPERSEDED directive line", () => {
    const result = supersededCheck(makeTask({ body: "## Scope\n\n## SUPERSEDED\n\nSee T-0400 instead.\n" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/superseded/i);
  });

  // Edge case: a line-leading bare word, with no heading/bold/colon marking, is not a directive --
  // including the exact trap a wrapped line recreates (the word starts the line, nothing else).
  it.each([
    ["held entries were counted again after the reconciliation.", /* word */ "held"],
    ["superseded by the dedicated-legs-panel amendment.", /* word */ "superseded"]
  ])("does not trip on a line-leading bare word with no marker shape: %j", (body) => {
    const result = supersededCheck(makeTask({ body: `## Acceptance\n\n${body}\n` }));
    expect(result.ok).toBe(true);
  });

  it("still fails when a body has both a genuine HELD directive and the ordinary word elsewhere", () => {
    const body =
      "## Scope\n\n## HELD\n\nSee the replacement card.\n\n" +
      "## Acceptance\n\n- [ ] The reconciliation found the list held 3 entries.\n";
    const result = supersededCheck(makeTask({ body }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/held/i);
  });

  it("releases a body that quotes the marker only as inline code", () => {
    const body = "## Notes\n\nA hold directive is written as a line-leading `HELD:` label.\n";
    const result = supersededCheck(makeTask({ body }));
    expect(result.ok).toBe(true);
  });

  it("does not crash and finds no marker on an empty or missing body", () => {
    expect(supersededCheck(makeTask({ body: "" })).ok).toBe(true);
    expect(supersededCheck(makeTask({ body: undefined })).ok).toBe(true);
  });

  // Comments are explicitly out of scope: this check only ever reads task.body.
  it("ignores a marker that only appears in a comment, not the body -- this check never reads comments", () => {
    const result = supersededCheck(
      makeTask({ body: "## Acceptance\n\n- [ ] Ship it\n", comments: [{ text: "## HELD" }] })
    );
    expect(result.ok).toBe(true);
  });
});

describe("mergedWorkCheck", () => {
  it("passes when git log on develop has no commit mentioning the card id", async () => {
    const result = await mergedWorkCheck({ task: makeTask({ id: "T-0042" }), gitLogGrep: NO_GIT_HITS });
    expect(result.ok).toBe(true);
  });

  it("fails, conservatively, when develop already has a commit naming the card id", async () => {
    const gitLogGrep = async (id) => [`abc1234 feat: ${id} landed this already`];
    const result = await mergedWorkCheck({ task: makeTask({ id: "T-0042" }), gitLogGrep });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/T-0042/);
    expect(result.evidence).toMatch(/abc1234/);
  });

  it("fails, conservatively, when the git check itself errors -- uncertainty skips, never a crash", async () => {
    const gitLogGrep = async () => {
      throw new Error("git: not a repository");
    };
    const result = await mergedWorkCheck({ task: makeTask(), gitLogGrep });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/git check failed/);
  });

  // Codex review 2026-09-18, finding 2: mergedWorkCheck returned {ok: true} whenever a card-id
  // grep on the base branch found nothing -- but that only proves commit *messages* lack the id,
  // not that the described change is actually missing. Codex's fixture: develop already contains
  // `feature.js` exporting `featureEnabled = true` via a commit that never mentions the card id
  // at all ("Implement feature flag"). Absence of an id hit must no longer be sufficient to clear
  // a card on its own -- mergedWorkCheck also checks whether any path its acceptance section
  // names already has history on the base branch, via the same injected gitLogGrep (see
  // ops/vetAndReady.js's makeGitLogGrep, which runs a path-scoped `git log -- <path>` instead of
  // `--grep` when the term looks like a path). This is mechanical existence-checking, not prose
  // interpretation: no attempt is made to read *what* the path contains.
  it("fails, conservatively, when a path named in the acceptance section already has history on the base branch even though the card id has no hits", async () => {
    const task = makeTask({
      id: "T-9001",
      body: "## Acceptance\n- feature.js exports featureEnabled = true.\n"
    });
    const gitLogGrep = async (term) =>
      term === "feature.js" ? ["abc1234 Implement feature flag"] : [];
    const result = await mergedWorkCheck({ task, gitLogGrep });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/feature\.js/);
    expect(result.evidence).toMatch(/abc1234/);
  });

  it("passes when neither the card id nor any acceptance path has any hits", async () => {
    const task = makeTask({
      id: "T-9002",
      body: "## Acceptance\n- Add a brand-new src/lib/newThing.js module.\n"
    });
    const result = await mergedWorkCheck({ task, gitLogGrep: NO_GIT_HITS });
    expect(result.ok).toBe(true);
  });

  // reviewer FAIL round, 2026-09-18: AC 10. An absent card-id hit is NOT clearance on its own --
  // it only proves commit *messages* don't mention the id. When the acceptance section names no
  // checkable path at all, there is no mechanical evidence available in either direction, so this
  // must land as skip-as-uncertain, not ok:true. Reproduces the branch's own previously-passing
  // "readies a clean runnable card" fixture shape (a prose-only body with no path-like token).
  it("fails, uncertain, when the acceptance section names no checkable path and the card id has no hits either", async () => {
    const task = makeTask({
      id: "T-9003",
      body: "## Acceptance\n\n- [ ] Does the thing\n"
    });
    const result = await mergedWorkCheck({ task, gitLogGrep: NO_GIT_HITS });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/uncertain/i);
    expect(result.reason).toMatch(/no checkable path/i);
  });
});

describe("extractAcceptancePaths", () => {
  it("extracts a bare filename-looking token from the Acceptance section", () => {
    expect(extractAcceptancePaths("## Acceptance\n- feature.js exports featureEnabled = true.\n")).toEqual([
      "feature.js"
    ]);
  });

  it("extracts a backtick-quoted repo path from the Acceptance section", () => {
    const body = "## Acceptance\n- [ ] `tools/board/ops/vetAndReady.js` implements every rule.\n";
    expect(extractAcceptancePaths(body)).toEqual(["tools/board/ops/vetAndReady.js"]);
  });

  // reviewer FAIL round, 2026-09-18: this repo's own house style (see nearly every card body,
  // including T-0384's own) puts a blank line between the `## Acceptance` heading and its list --
  // "## Acceptance\n\n- [ ] ...". The section-boundary regex's `$` anchor, under the `m` flag,
  // matched at that very first blank line (multiline `$` matches before ANY `\n`, not just at the
  // true end of the body), so the capture group came back empty and every real, standard-style
  // card silently extracted zero paths regardless of what its acceptance actually named.
  it("extracts a path from an Acceptance section with a blank line after the heading (the repo's house style)", () => {
    const body = "## Acceptance\n\n- [ ] Update `src/lib/doTheThing.js` to do the thing.\n";
    expect(extractAcceptancePaths(body)).toEqual(["src/lib/doTheThing.js"]);
  });

  it("ignores paths mentioned outside the Acceptance section (e.g. Links/Pointers)", () => {
    const body =
      "## Acceptance\n- [ ] Ship the thing.\n\n## Links\n\nSee `docs/PLAN.md` for background.\n";
    expect(extractAcceptancePaths(body)).toEqual([]);
  });

  it("returns an empty list when the body has no Acceptance section or no path-like tokens", () => {
    expect(extractAcceptancePaths("## Acceptance\n- [ ] Does the thing\n")).toEqual([]);
    expect(extractAcceptancePaths("")).toEqual([]);
    expect(extractAcceptancePaths(undefined)).toEqual([]);
  });

  it("dedupes repeated path mentions", () => {
    const body = "## Acceptance\n- [ ] Update `feature.js`.\n- [ ] Test `feature.js` too.\n";
    expect(extractAcceptancePaths(body)).toEqual(["feature.js"]);
  });
});

describe("vetAndReady -- end to end selection", () => {
  it("readies a clean runnable card", async () => {
    const tasks = [makeTask({ id: "T-0001", priority: "P1" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.readied.map((r) => r.id)).toEqual(["T-0001"]);
    expect(result.skipped).toEqual([]);
  });

  // T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #1): the write-time comparison this round adds
  // (`ops/vetAndReady.js`'s `findChangedVettedFields`) needs the ORIGINAL, selection-time snapshot
  // of each readied card -- not just its fresh re-fetch -- so a body/acceptance change with no
  // governing marker is caught even when the fresh snapshot alone still looks perfectly vettable.
  it("carries the original selection-time task snapshot forward on every readied entry", async () => {
    const original = makeTask({ id: "T-0001", priority: "P1" });
    const result = await vetAndReady({ tasks: [original], gitLogGrep: NO_GIT_HITS });
    expect(result.readied).toHaveLength(1);
    expect(result.readied[0].originalTask).toEqual(original);
  });

  it("never readies or lists a GPU/assets card -- it stays out of the decision table entirely", async () => {
    const tasks = [makeTask({ id: "T-0002", agent: "assets" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.eligibleCount).toBe(0);
    expect(result.readied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("never readies or lists a requires_approval card", async () => {
    const tasks = [makeTask({ id: "T-0003", requires_approval: true })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.eligibleCount).toBe(0);
    expect(result.readied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("skips a card with an unmet dependency and names the rule", async () => {
    const tasks = [
      makeTask({ id: "T-0004", depends_on: ["T-0099"] }),
      makeTask({ id: "T-0099", status: "backlog" })
    ];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    const t4 = result.skipped.find((r) => r.id === "T-0004");
    expect(t4).toBeTruthy();
    expect(t4.rule).toMatch(/dependency/);
  });

  it("skips a card already satisfied by merged work", async () => {
    const tasks = [makeTask({ id: "T-0005" })];
    const gitLogGrep = async (id) => (id === "T-0005" ? ["deadbee feat: T-0005 already shipped"] : []);
    const result = await vetAndReady({ tasks, gitLogGrep });
    expect(result.readied).toEqual([]);
    const t5 = result.skipped.find((r) => r.id === "T-0005");
    expect(t5.rule).toMatch(/merged/);
  });

  it("skips a card whose acceptance is superseded/held", async () => {
    const tasks = [makeTask({ id: "T-0006", body: "## Scope\n\n**HELD -- see T-0007 instead.**\n" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.readied).toEqual([]);
    const t6 = result.skipped.find((r) => r.id === "T-0006");
    expect(t6.rule).toMatch(/superseded/);
  });

  // T-0420: the regression this card fixes -- a card whose body merely uses "held"/"superseded"
  // as ordinary English prose must be readied, not skipped forever as "superseded".
  it("readies a card whose body merely uses 'held' as an ordinary word, not a hold directive", async () => {
    const tasks = [
      makeTask({
        id: "T-0007",
        body:
          "## Acceptance\n\n- [ ] Reconciling it found the list held 3 entries while the host had 14.\n" +
          "- [ ] Update `src/lib/doTheThing.js` to do the thing.\n"
      })
    ];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.readied.map((r) => r.id)).toEqual(["T-0007"]);
    expect(result.skipped).toEqual([]);
  });

  it("in a dependent pair, readies only the head and skips the dependent", async () => {
    const head = makeTask({ id: "T-0010", priority: "P1" });
    const dependent = makeTask({ id: "T-0011", priority: "P1", depends_on: ["T-0010"] });
    const result = await vetAndReady({ tasks: [head, dependent], gitLogGrep: NO_GIT_HITS });
    expect(result.readied.map((r) => r.id)).toEqual(["T-0010"]);
    expect(result.skipped.map((r) => r.id)).toEqual(["T-0011"]);
  });

  it("enforces the per-run cap of 4, highest priority then lowest numeric id first, deterministically", async () => {
    const tasks = [
      makeTask({ id: "T-0020", priority: "P2" }),
      makeTask({ id: "T-0021", priority: "P1" }),
      makeTask({ id: "T-0005", priority: "P1" }),
      makeTask({ id: "T-0030", priority: "P0" }),
      makeTask({ id: "T-0022", priority: "P3" }),
      makeTask({ id: "T-0023", priority: "P2" })
    ];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    // Selection is priority-first (P0 T-0030 beats every lower-priority, lower-id card); display
    // order is the decision table's own deterministic id-ascending order, not selection order.
    expect(result.readied.map((r) => r.id)).toEqual(["T-0005", "T-0020", "T-0021", "T-0030"]);
    expect(result.skipped.map((r) => r.id).sort()).toEqual(["T-0022", "T-0023"]);
    for (const entry of result.skipped) {
      expect(entry.rule).toMatch(/cap/);
    }
  });

  it("honours a lower cap override", async () => {
    const tasks = [makeTask({ id: "T-0040" }), makeTask({ id: "T-0041" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS, cap: 1 });
    expect(result.readied.map((r) => r.id)).toEqual(["T-0040"]);
    expect(result.skipped.map((r) => r.id)).toEqual(["T-0041"]);
  });

  // Codex review 2026-09-18, finding 4: BOARD_VET_READY_CAP=10 with six clean candidates
  // selected all six. The per-run cap of 4 is a hard upper bound the config can lower but never
  // raise -- enforced here, at the selection boundary itself, not only in ops/vetAndReady.js's
  // config parsing (so a caller of this library function directly gets the same guarantee).
  it("never exceeds the hard cap of 4 even when a larger cap is passed in", async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => makeTask({ id: `T-090${i}`, priority: "P1" }));
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS, cap: 10 });
    expect(result.readied.length).toBeLessThanOrEqual(4);
    expect(result.readied.length).toBe(4);
    expect(result.cap).toBe(4);
  });

  it("never mutates the input tasks array", async () => {
    const tasks = [makeTask({ id: "T-0050" })];
    const snapshot = JSON.stringify(tasks);
    await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });

  // reviewer FAIL round, 2026-09-18: AC 10. A card whose `## Acceptance` section is prose-only
  // (no path-like token at all) must be skipped as uncertain, not readied on an absent id-grep
  // alone -- rule "2-merged" is the one that decides it.
  it("skips, as uncertain, a card whose acceptance section names no checkable path", async () => {
    const tasks = [makeTask({ id: "T-0051", body: "## Acceptance\n\n- [ ] Does the thing\n" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.readied).toEqual([]);
    const t51 = result.skipped.find((r) => r.id === "T-0051");
    expect(t51).toBeTruthy();
    expect(t51.rule).toBe("2-merged");
    expect(t51.reason).toMatch(/uncertain/i);
  });
});

// Codex review 2026-09-18, finding 3: applyReadiedCards must revalidate a candidate's status,
// eligibility scope, approval flag, body markers, and dependencies right before the write --
// this is the pure, injectable core of that re-check (no git, no board API), so ops/vetAndReady.js
// only has to wire it to a fresh fetch. Deliberately does NOT re-run mergedWorkCheck (git-based,
// stable within a run, and expensive to re-run per candidate).
describe("revalidateCandidate", () => {
  it("still passes an unchanged, eligible card with satisfied dependencies and no superseding marker", () => {
    const task = makeTask({ id: "T-0060" });
    const byId = new Map([[task.id, task]]);
    expect(revalidateCandidate(task, byId).ok).toBe(true);
  });

  it("fails when the card no longer exists", () => {
    expect(revalidateCandidate(null, new Map()).ok).toBe(false);
    expect(revalidateCandidate(undefined, new Map()).ok).toBe(false);
  });

  it("fails when the card's status changed out of backlog since it was selected", () => {
    const task = makeTask({ id: "T-0061", status: "done" });
    const byId = new Map([[task.id, task]]);
    const result = revalidateCandidate(task, byId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no longer eligible/);
  });

  it("fails when the card picked up requires_approval since it was selected", () => {
    const task = makeTask({ id: "T-0062", requires_approval: true });
    const byId = new Map([[task.id, task]]);
    expect(revalidateCandidate(task, byId).ok).toBe(false);
  });

  it("fails when a dependency is no longer satisfied at write time", () => {
    const dep = makeTask({ id: "T-0063", status: "in-progress" });
    const task = makeTask({ id: "T-0064", depends_on: ["T-0063"] });
    const byId = new Map([
      [dep.id, dep],
      [task.id, task]
    ]);
    const result = revalidateCandidate(task, byId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/dependency/);
  });

  it("fails when the body picked up a superseding marker since it was selected", () => {
    const task = makeTask({ id: "T-0065", body: "## Held\nDo not ready this card.\n" });
    const byId = new Map([[task.id, task]]);
    const result = revalidateCandidate(task, byId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/body changed/);
  });
});

// T-0425: vetAndReady() now also reads the T-0409 structural-unsatisfiability registry plus the
// new Class B/C over-constraint checks (acceptanceVetPreflight.js) for every card it decides on --
// author-time, before a round is ever launched. This is WARN-only: it must never change which
// cards get readied, only annotate the decision table a human reads.
describe("vetAndReady -- acceptance-authoring flags (T-0425)", () => {
  it("still readies a card carrying every flag class this check can raise", async () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] Update `src/lib/doTheThing.js` to do the thing.\n" +
      "- [ ] `.claude/agents/infra.md` is edited with the new grant.\n" +
      "- [ ] `git diff -- tools/asset-gate/src/` is empty.\n" +
      "- [ ] Edit `tools/asset-gate/src/asset_gate/character_motion_class_baseline.txt` to re-key the exemption.\n" +
      "- [ ] Before/after `[FAIL]` counts are recorded: 14 before, 2 after.\n";
    const tasks = [makeTask({ id: "T-0070", body })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });

    expect(result.readied.map((r) => r.id)).toEqual(["T-0070"]);
    const entry = result.readied[0];
    expect(entry.acceptanceFlags.length).toBeGreaterThanOrEqual(3);
    const allReasons = entry.acceptanceFlags.flatMap((f) => f.reasons).join(" ");
    expect(allReasons).toMatch(/Class A/);
    expect(allReasons).toMatch(/Class B/);
    expect(allReasons).toMatch(/Class C/);
  });

  it("attaches acceptanceFlags to a skipped card too, not only readied ones", async () => {
    const body = "## Acceptance\n\n- [ ] `.claude/agents/infra.md` is edited with the new grant.\n";
    const tasks = [makeTask({ id: "T-0071", body, depends_on: ["T-9999"] })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });

    expect(result.readied).toEqual([]);
    const entry = result.skipped.find((r) => r.id === "T-0071");
    expect(entry.acceptanceFlags.length).toBe(1);
  });

  // See vetAndReady.acceptancePreflightUnavailable.test.js for the "check itself is unavailable"
  // edge case (import error / bad config) -- that needs a module mock, which must live in its own
  // file so it doesn't affect every other test here.

  it("flags nothing for an ordinary, clean acceptance section", async () => {
    const tasks = [makeTask({ id: "T-0073" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.readied[0].acceptanceFlags).toEqual([]);
  });
});
