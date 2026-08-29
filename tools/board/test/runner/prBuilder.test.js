import { describe, it, expect } from "vitest";
import { buildPrTitle, buildPrBody } from "../../src/runner/prBuilder.js";

const TASK = {
  id: "T-0200",
  title: "Add finalize step to Agent Runner",
  body: "## Context\nAuto-open a PR on PASS.\n\n## Acceptance\n- [ ] gh pr create runs on PASS\n"
};

describe("buildPrTitle", () => {
  it("formats as 'T-XXXX: <card title>'", () => {
    expect(buildPrTitle({ task: TASK })).toBe("T-0200: Add finalize step to Agent Runner");
  });
});

describe("buildPrBody", () => {
  it("includes the card's own story/acceptance body verbatim", () => {
    const body = buildPrBody({ task: TASK, verdict: { verdict: "PASS", notes: "ran tests, all green" } });
    expect(body).toContain("## Context");
    expect(body).toContain("Auto-open a PR on PASS.");
    expect(body).toContain("## Acceptance");
    expect(body).toContain("gh pr create runs on PASS");
  });

  it("includes the reviewer's PASS verdict and captured test/lint notes", () => {
    const body = buildPrBody({ task: TASK, verdict: { verdict: "PASS", notes: "npm test: 611 passed; lint clean" } });
    expect(body).toMatch(/PASS/);
    expect(body).toContain("npm test: 611 passed; lint clean");
  });

  it("falls back to a placeholder when the verdict has no notes, rather than inventing content", () => {
    const body = buildPrBody({ task: TASK, verdict: { verdict: "PASS", notes: "" } });
    expect(body).toContain("(no notes recorded)");
  });
});

// ---------------------------------------------------------------------------
// PR bodies are a summary, not a paste of the whole card.
//
// buildPrBody used to emit `task.body.trim()` verbatim plus the reviewer's raw `notes`
// field inline. On the Signal Tower room cards that produced 9.7k-16.3k character PR
// descriptions consisting of: implementer-directed instructions ("Map this room's slots
// onto these first", "stop and say so"), accumulated internal bookkeeping (`## Blocked`
// timestamps, `## Amendment` sections), and a 2.5k-4.3k character unbroken paragraph of
// reviewer verdict prose written for the orchestrator's parser, not for a human.
//
// A PR description is read by a person deciding whether to merge. It gets the card's
// descriptive sections and a verdict headline; the raw notes stay available, folded away.
// ---------------------------------------------------------------------------

const ROOM_CARD = {
  id: "T-0241",
  title: "Signal Tower — Storage Cache prop pack (§23-j-e)",
  body: [
    "## Context",
    "",
    "HANDOFF §23, handle **§23-j-e**. Track 2.",
    "",
    "## Prop slots for this room",
    "",
    "| Slot | Class | Resolves to |",
    "|---|---|---|",
    "| Stored crates | cover | `crate_stack_v1` |",
    "",
    "## Reuse before you generate",
    "",
    "**Map this room's slots onto these first.** Generate only what this room genuinely needs.",
    "Re-generating an approved, gate-passing prop is a regression risk, not thoroughness.",
    "",
    "## The gates every prop in this room must clear",
    "",
    "- **DL-5 / P-6 — concept art precedes generation.** Do not repeat it.",
    "",
    "## Pipeline prerequisite — none (amended 2026-08-29)",
    "",
    "If it has not landed, do not re-implement that work here — say so and stop.",
    "",
    "## Story",
    "",
    "As the deciding run, I want Storage Cache's props delivered and proven legible.",
    "",
    "## Acceptance",
    "",
    "- [ ] Every prop slot resolves to a committed prop",
    "- [ ] **Done when:** the manifest is attached",
    "",
    "## Blocked (2026-08-29T11:21:09.500Z)",
    "",
    "no commits on branch — skipping validation",
    "",
    "---",
    "",
    "## Amendment — 2026-08-29",
    "",
    "Two changes, both narrowing requirements that were stricter than the live gates."
  ].join("\n")
};

const LONG_NOTES =
  "Verified this run end to end. Criterion-by-criterion: (1) MET -- asserts crate_stack_v1.png " +
  "exists; (2) no geometry generated, generated_new_props:false, so DL-5 has nothing to violate; " +
  "(3) vacuous, nothing generated; (4) 16px gate met -- cover luma16 112.9 vs hiding 82.0, gap 30.9.";

describe("buildPrBody -- summary, not a paste of the whole card", () => {
  const body = buildPrBody({ task: ROOM_CARD, verdict: { verdict: "PASS", notes: LONG_NOTES } });

  it("keeps the card's descriptive sections", () => {
    expect(body).toContain("## Context");
    expect(body).toContain("HANDOFF §23, handle **§23-j-e**");
    expect(body).toContain("## Story");
    expect(body).toContain("As the deciding run, I want Storage Cache's props delivered");
    expect(body).toContain("## Acceptance");
    expect(body).toContain("**Done when:** the manifest is attached");
  });

  it.each([
    ["## Blocked", "## Blocked (2026-08-29T11:21:09.500Z)"],
    ["## Amendment", "## Amendment — 2026-08-29"]
  ])("strips internal bookkeeping section %s", (_label, heading) => {
    expect(body).not.toContain(heading);
  });

  it("strips the bookkeeping sections' prose too, not just their headings", () => {
    expect(body).not.toContain("no commits on branch");
    expect(body).not.toContain("stricter than the live gates");
  });

  it.each([
    ["Map this room's slots onto these first"],
    ["Re-generating an approved, gate-passing prop is a regression risk"],
    ["do not re-implement that work here"],
    ["Do not repeat it"]
  ])("strips implementer-directed instruction prose: %s", (phrase) => {
    expect(body).not.toContain(phrase);
  });

  it("is materially shorter than pasting the whole card", () => {
    expect(body.length).toBeLessThan(ROOM_CARD.body.length);
  });
});

describe("buildPrBody -- reviewer verdict presentation", () => {
  it("shows the verdict as a headline", () => {
    const body = buildPrBody({ task: ROOM_CARD, verdict: { verdict: "PASS", notes: LONG_NOTES } });
    expect(body).toContain("## Reviewer verdict: PASS");
  });

  it("reports a FAIL verdict as FAIL rather than hardcoding PASS", () => {
    const body = buildPrBody({ task: ROOM_CARD, verdict: { verdict: "FAIL", notes: "nope" } });
    expect(body).toContain("## Reviewer verdict: FAIL");
    expect(body).not.toContain("## Reviewer verdict: PASS");
  });

  it("folds the raw notes into a collapsed <details> block instead of pasting them inline", () => {
    const body = buildPrBody({ task: ROOM_CARD, verdict: { verdict: "PASS", notes: LONG_NOTES } });
    expect(body).toContain("<details>");
    expect(body).toContain("</details>");
    expect(body).toContain("<summary>");
    // The notes are still present -- folded away, never dropped.
    expect(body).toContain(LONG_NOTES);
    // ...and they sit inside the details block, not above it.
    expect(body.indexOf("<details>")).toBeLessThan(body.indexOf(LONG_NOTES));
    expect(body.indexOf(LONG_NOTES)).toBeLessThan(body.indexOf("</details>"));
  });

  it("still folds the placeholder when there are no notes", () => {
    const body = buildPrBody({ task: ROOM_CARD, verdict: { verdict: "PASS", notes: "" } });
    expect(body).toContain("(no notes recorded)");
    expect(body).toContain("<details>");
  });

  it("links back to the card for the full body it no longer pastes", () => {
    const body = buildPrBody({ task: ROOM_CARD, verdict: { verdict: "PASS", notes: LONG_NOTES } });
    expect(body).toContain("T-0241");
  });
});

describe("buildPrBody -- degenerate cards", () => {
  it("does not throw on a card with no recognised sections, and still shows the verdict", () => {
    const task = { id: "T-0001", title: "bare", body: "just a sentence, no headings at all" };
    const body = buildPrBody({ task, verdict: { verdict: "PASS", notes: "fine" } });
    expect(body).toContain("## Reviewer verdict: PASS");
    expect(typeof body).toBe("string");
  });

  it("does not throw on an empty card body", () => {
    const task = { id: "T-0002", title: "empty", body: "" };
    expect(() => buildPrBody({ task, verdict: { verdict: "PASS", notes: "fine" } })).not.toThrow();
  });
});
