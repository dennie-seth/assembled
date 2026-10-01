import { describe, it, expect, vi } from "vitest";

/**
 * T-0425 edge case: "The vet job running with the check unavailable (import error, bad config) --
 * the vet pass still completes and readies cards, degrading to 'check not run' rather than failing
 * the job." Mocking the whole acceptanceVetPreflight.js module to throw is the only way to force
 * that failure mode without also breaking the OTHER vetAndReady rules that read task.body (the
 * superseded-marker and merged-work checks) -- so this lives in its own file, since vi.mock is
 * module-scoped for the whole file it's declared in.
 */
vi.mock("../../src/runner/acceptanceVetPreflight.js", () => ({
  checkAcceptanceAuthoringPreflight: () => {
    throw new Error("simulated: acceptance-authoring preflight unavailable");
  }
}));

const { vetAndReady } = await import("../../src/lib/vetAndReady.js");

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
    body: "## Acceptance\n\n- [ ] Update `src/lib/doTheThing.js` to do the thing.\n",
    ...overrides
  };
}

const NO_GIT_HITS = async () => [];

describe("vetAndReady -- acceptance-authoring preflight unavailable", () => {
  it("still completes the run and readies the card, with a degraded 'not run' flag rather than throwing", async () => {
    const tasks = [makeTask({ id: "T-0080" })];
    const result = await vetAndReady({ tasks, gitLogGrep: NO_GIT_HITS });

    expect(result.readied.map((r) => r.id)).toEqual(["T-0080"]);
    const entry = result.readied[0];
    expect(entry.acceptanceFlags).toHaveLength(1);
    expect(entry.acceptanceFlags[0].reasons[0]).toMatch(/not run/i);
  });
});
