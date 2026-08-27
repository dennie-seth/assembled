import { describe, it, expect } from "vitest";
import {
  DEFAULT_PHASE_TIMEOUT_MS,
  PHASE_TIMEOUT_MS_BY_AGENT,
  resolvePhaseTimeoutMs
} from "../../src/runner/runOrchestrator.js";

/**
 * Per-agent phase budgets (T-0228).
 *
 * T-0228 (Arm A of the §23 bake-off) was killed twice by the 40-minute phase
 * watchdog while making steady progress: 1136 and 661 logged events, max
 * inter-event gap 120s and 287s, and 26/26 ComfyUI executions succeeded with no
 * errors or OOM. It was not hung -- the card's own acceptance criteria mandate up
 * to 8 generation attempts, and Arm A's full stack (SDXL + style LoRA +
 * IP-Adapter + OpenPose ControlNet) measured ~240s per attempt, so ~32 minutes of
 * GPU alone before any setup, tests, image inspection or provenance work. The card
 * was unsatisfiable inside a 40-minute bound.
 *
 * A single global constant could not express that: raising it would equally relax
 * server/client/infra phases that have no business running for two hours.
 */
describe("resolvePhaseTimeoutMs", () => {
  it("gives the assets agent 120 minutes", () => {
    expect(resolvePhaseTimeoutMs("assets")).toBe(120 * 60 * 1000);
  });

  it("leaves every other agent on the 40-minute default", () => {
    for (const agent of ["server", "client", "infra", "generic", "reviewer", "planner", "audio"]) {
      expect(resolvePhaseTimeoutMs(agent)).toBe(DEFAULT_PHASE_TIMEOUT_MS);
    }
    expect(DEFAULT_PHASE_TIMEOUT_MS).toBe(40 * 60 * 1000);
  });

  it("falls back to the default for an unknown, null or missing agent", () => {
    expect(resolvePhaseTimeoutMs("nonesuch")).toBe(DEFAULT_PHASE_TIMEOUT_MS);
    expect(resolvePhaseTimeoutMs(null)).toBe(DEFAULT_PHASE_TIMEOUT_MS);
    expect(resolvePhaseTimeoutMs(undefined)).toBe(DEFAULT_PHASE_TIMEOUT_MS);
  });

  it("does not inherit anything from Object.prototype for a prototype-named agent", () => {
    expect(resolvePhaseTimeoutMs("constructor")).toBe(DEFAULT_PHASE_TIMEOUT_MS);
    expect(resolvePhaseTimeoutMs("toString")).toBe(DEFAULT_PHASE_TIMEOUT_MS);
  });

  // Precedence: explicit override > per-agent map > default.
  it("lets an explicit override beat the per-agent budget", () => {
    expect(resolvePhaseTimeoutMs("assets", { override: 5 * 60 * 1000 })).toBe(5 * 60 * 1000);
  });

  it("lets an explicit override beat the default", () => {
    expect(resolvePhaseTimeoutMs("server", { override: 90 * 60 * 1000 })).toBe(90 * 60 * 1000);
  });

  it("ignores a non-positive or unparseable override and keeps the per-agent budget", () => {
    for (const bad of [0, -1, NaN, null, undefined, "abc"]) {
      expect(resolvePhaseTimeoutMs("assets", { override: bad })).toBe(120 * 60 * 1000);
    }
  });

  it("accepts an injected per-agent map, so future tuning is one line", () => {
    const byAgent = { assets: 1000, audio: 2000 };
    expect(resolvePhaseTimeoutMs("assets", { byAgent })).toBe(1000);
    expect(resolvePhaseTimeoutMs("audio", { byAgent })).toBe(2000);
    expect(resolvePhaseTimeoutMs("server", { byAgent })).toBe(DEFAULT_PHASE_TIMEOUT_MS);
  });

  it("exposes the budgets as a frozen map keyed by agent name", () => {
    expect(PHASE_TIMEOUT_MS_BY_AGENT.assets).toBe(120 * 60 * 1000);
    expect(Object.isFrozen(PHASE_TIMEOUT_MS_BY_AGENT)).toBe(true);
  });

  it("keeps every per-agent budget at or above the default -- the map raises, never lowers", () => {
    for (const ms of Object.values(PHASE_TIMEOUT_MS_BY_AGENT)) {
      expect(ms).toBeGreaterThanOrEqual(DEFAULT_PHASE_TIMEOUT_MS);
    }
  });
});
