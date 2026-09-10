import { describe, it, expect } from "vitest";
import {
  ROUND_FIELD,
  ROUND_CAP,
  RESCOPE_MARKERS,
  RESCOPE_RECORD_FIELDS,
  roundsSinceDeliverable,
  roundCapReached,
  isRescopeMarker,
  rescopeRecord,
  roundCapParkedComment,
  rescopeRecordedComment,
  RoundCapExceededError,
  assertRoundCapClear
} from "../../src/lib/roundCap.js";

/**
 * The experiment-round cap (T-0344, docs/board-invariants.md). A "round" is one full re-launch
 * of a card after a settled verdict -- distinct from an "attempt", the bounded implementer/
 * reviewer retry loop *inside* one round (runOrchestrator.js's `attempts`/`max_attempts`,
 * T-0343). Motivated by T-0272/T-0317 (twelve rounds, 84 attempts against a mechanism wrong
 * from round one) and T-0259 (thirteen sessions) -- nothing forced a human to look up until the
 * cost was already spent.
 */

function makeTask(overrides = {}) {
  return { id: "T-0001", round: 0, rescoped_by: null, rescoped_at: null, ...overrides };
}

describe("roundCap constants", () => {
  it("caps rounds at 2 -- the exact bound this card's title specifies", () => {
    expect(ROUND_CAP).toBe(2);
  });

  it("names the frontmatter field as 'round'", () => {
    expect(ROUND_FIELD).toBe("round");
  });

  it("names the rescope record fields", () => {
    expect(RESCOPE_RECORD_FIELDS).toEqual(["rescoped_by", "rescoped_at"]);
  });

  it("names the rescope markers", () => {
    expect(RESCOPE_MARKERS).toEqual(["rescoped", "/rescope"]);
  });
});

describe("roundsSinceDeliverable", () => {
  it("defaults to 0 when the field is absent", () => {
    expect(roundsSinceDeliverable({})).toBe(0);
  });

  it("defaults to 0 when the field is null", () => {
    expect(roundsSinceDeliverable({ round: null })).toBe(0);
  });

  it("defaults to 0 for a non-integer value", () => {
    expect(roundsSinceDeliverable({ round: "2" })).toBe(0);
  });

  it("returns the stored integer", () => {
    expect(roundsSinceDeliverable({ round: 1 })).toBe(1);
    expect(roundsSinceDeliverable({ round: 2 })).toBe(2);
  });
});

describe("roundCapReached", () => {
  it("is false below the cap", () => {
    expect(roundCapReached(makeTask({ round: 0 }))).toBe(false);
    expect(roundCapReached(makeTask({ round: 1 }))).toBe(false);
  });

  it("is true at and above the cap", () => {
    expect(roundCapReached(makeTask({ round: 2 }))).toBe(true);
    expect(roundCapReached(makeTask({ round: 3 }))).toBe(true);
  });

  it("is false for a fresh card with no round history -- never retroactive", () => {
    expect(roundCapReached(makeTask({ round: undefined }))).toBe(false);
  });
});

describe("isRescopeMarker", () => {
  it.each(["rescoped", "RESCOPED", "  Rescoped  ", "/rescope", "/RESCOPE"])(
    "matches %s as the whole first non-empty line",
    (text) => {
      expect(isRescopeMarker(text)).toBe(true);
    }
  );

  it("allows explanatory prose underneath the marker", () => {
    expect(isRescopeMarker("RESCOPED\n\nSwitching to the two-tier compositing approach.")).toBe(true);
  });

  it("does not match a comment that merely discusses re-scoping", () => {
    expect(isRescopeMarker("not rescoped yet -- still deciding the new approach")).toBe(false);
  });

  it("does not match an empty or non-string value", () => {
    expect(isRescopeMarker("")).toBe(false);
    expect(isRescopeMarker(null)).toBe(false);
    expect(isRescopeMarker(undefined)).toBe(false);
  });
});

describe("rescopeRecord", () => {
  it("resets the round counter to 0 and stamps who/when", () => {
    const record = rescopeRecord({ actor: "@DennieSeth", now: new Date("2026-09-10T12:00:00.000Z") });
    expect(record).toEqual({
      round: 0,
      rescoped_by: "@DennieSeth",
      rescoped_at: "2026-09-10T12:00:00.000Z"
    });
  });

  it("falls back to 'unknown' for an empty actor", () => {
    expect(rescopeRecord({ actor: "" }).rescoped_by).toBe("unknown");
  });
});

describe("roundCapParkedComment", () => {
  it("names the card, the round count, and the cap", () => {
    const text = roundCapParkedComment("T-0344", 2);
    expect(text).toContain("T-0344");
    expect(text).toMatch(/2 of 2/);
  });

  it("distinguishes a round (full re-launch) from an attempt (intra-run retry)", () => {
    const text = roundCapParkedComment("T-0344", 2);
    expect(text).toMatch(/round/i);
    expect(text).toMatch(/not auto-retry attempts/i);
  });

  it("names the discoverable human action to unblock the next round", () => {
    const text = roundCapParkedComment("T-0344", 2);
    expect(text).toMatch(/RESCOPED/);
  });
});

describe("rescopeRecordedComment", () => {
  it("names who acknowledged the re-scope and when", () => {
    const text = rescopeRecordedComment({ actor: "@DennieSeth", rescopedAt: "2026-09-10T12:00:00.000Z" });
    expect(text).toContain("@DennieSeth");
    expect(text).toContain("2026-09-10T12:00:00.000Z");
  });
});

describe("RoundCapExceededError", () => {
  it("carries the task id and round count, with a message naming the required human action", () => {
    const err = new RoundCapExceededError("T-0344", 2);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RoundCapExceededError");
    expect(err.taskId).toBe("T-0344");
    expect(err.round).toBe(2);
    expect(err.message).toMatch(/T-0344/);
    expect(err.message).toMatch(/RESCOPED/);
  });
});

describe("assertRoundCapClear", () => {
  function makeStore(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return { get: async (id) => byId.get(id) ?? null };
  }

  it("resolves for a card below the cap", async () => {
    const store = makeStore([makeTask({ id: "T-0001", round: 1 })]);
    await expect(assertRoundCapClear(store, "T-0001")).resolves.toBeUndefined();
  });

  it("resolves for a missing card -- store.update's 404 is the one to report, not this guard's", async () => {
    const store = makeStore([]);
    await expect(assertRoundCapClear(store, "T-9999")).resolves.toBeUndefined();
  });

  it("throws RoundCapExceededError for a card at the cap", async () => {
    const store = makeStore([makeTask({ id: "T-0001", round: 2 })]);
    await expect(assertRoundCapClear(store, "T-0001")).rejects.toBeInstanceOf(RoundCapExceededError);
  });

  it("resolves for a card at the cap that has since been rescoped (round reset to 0)", async () => {
    const store = makeStore([
      makeTask({ id: "T-0001", round: 0, rescoped_by: "@DennieSeth", rescoped_at: "2026-09-10T12:00:00.000Z" })
    ]);
    await expect(assertRoundCapClear(store, "T-0001")).resolves.toBeUndefined();
  });
});
