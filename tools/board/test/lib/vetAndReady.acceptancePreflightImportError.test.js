import { describe, it, expect, vi } from "vitest";

/**
 * T-0425 FIX ROUND (reviewer FAIL, 2026-10-01): the companion test
 * vetAndReady.acceptancePreflightUnavailable.test.js only exercises a RUNTIME throw from inside an
 * otherwise-successfully-loaded acceptanceVetPreflight.js module -- that passes even with a static
 * top-level `import` of it at the head of vetAndReady.js, because the import itself never fails.
 *
 * A genuine "import error" (the edge case's own words) fails at module EVALUATION time, before any
 * exported function is ever called. `import { x } from "./y.js"` throws synchronously if `y.js` (or
 * any of its own transitive deps, e.g. structuralUnsatisfiability.js) throws while loading -- and
 * that abort propagates to the importING module (vetAndReady.js) too, before vetAndReady.js's own
 * try/catch -- which lives inside a function body, not at module scope -- ever gets a chance to run.
 * The whole nightly vet job then crashes rather than degrading.
 *
 * This file's mock factory itself throws (rather than returning a working module whose export
 * throws), which is what actually simulates a module-load failure for an import of
 * acceptanceVetPreflight.js, static or dynamic.
 */
vi.mock("../../src/runner/acceptanceVetPreflight.js", () => {
  throw new Error("simulated: acceptanceVetPreflight.js itself fails to load");
});

describe("vetAndReady -- acceptance-authoring preflight fails to even load (not just to run)", () => {
  it("vetAndReady.js itself still loads", async () => {
    await expect(import("../../src/lib/vetAndReady.js")).resolves.toBeTruthy();
  });

  it("still completes the run and readies the card, degrading rather than crashing the job", async () => {
    const { vetAndReady } = await import("../../src/lib/vetAndReady.js");
    const tasks = [
      {
        id: "T-0081",
        title: "A card",
        status: "backlog",
        priority: "P1",
        phase: 7,
        agent: "infra",
        depends_on: [],
        created: "2026-09-01",
        deliverable_type: "code",
        requires_approval: false,
        body: "## Acceptance\n\n- [ ] Update `src/lib/doTheThing.js` to do the thing.\n"
      }
    ];
    const result = await vetAndReady({ tasks, gitLogGrep: async () => [] });

    expect(result.readied.map((r) => r.id)).toEqual(["T-0081"]);
    const entry = result.readied[0];
    expect(entry.acceptanceFlags).toHaveLength(1);
    expect(entry.acceptanceFlags[0].reasons[0]).toMatch(/not run/i);
  });
});
