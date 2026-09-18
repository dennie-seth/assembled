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
    body: "## Acceptance\n\n- [ ] Does the thing\n",
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

  it.each(SUPERSEDED_MARKERS)("fails when the body contains the marker %s", (marker) => {
    const result = supersededCheck(makeTask({ body: `## Scope\n\nOriginal plan.\n\n${marker}\n\nNew plan.\n` }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  // Codex review 2026-09-18, finding 1: case-sensitive `body.includes()` over a fixed-case list
  // let `## Held`, lowercase `held`, and `Stop-and-report:` slip through and get readied. Every
  // variant below is one Codex actually reproduced or that the fix-round AC names explicitly.
  it.each([
    ["## Held\nDo not ready this card until a human decision.", /held/i],
    ["lowercase held mid-sentence: the fix is being held for review.", /held/i],
    ["Stop-and-report: acceptance already satisfied by the replacement.", /stop.and.report/i],
    ["stop and report -- do not proceed.", /stop.and.report/i],
    ["## Finding\nStop-and-report: acceptance already satisfied by the replacement.", /finding/i],
    ["rescoped by the follow-up card, see T-0400.", /re-?scoped/i],
    ["superseded by T-0400.", /superseded/i],
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
});

describe("vetAndReady -- end to end selection", () => {
  it("readies a clean runnable card", async () => {
    const tasks = [makeTask({ id: "T-0001", priority: "P1" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.readied.map((r) => r.id)).toEqual(["T-0001"]);
    expect(result.skipped).toEqual([]);
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
    const tasks = [makeTask({ id: "T-0006", body: "## Scope\n\nHELD -- see T-0007 instead.\n" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(result.readied).toEqual([]);
    const t6 = result.skipped.find((r) => r.id === "T-0006");
    expect(t6.rule).toMatch(/superseded/);
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

  it("never mutates the input tasks array", async () => {
    const tasks = [makeTask({ id: "T-0050" })];
    const snapshot = JSON.stringify(tasks);
    await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});
