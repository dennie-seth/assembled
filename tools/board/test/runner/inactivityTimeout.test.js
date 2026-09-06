import { describe, it, expect } from "vitest";
import {
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  INACTIVITY_TIMEOUT_MS_BY_AGENT,
  PHASE_TIMEOUT_MS_BY_AGENT,
  resolveInactivityTimeoutMs
} from "../../src/runner/runOrchestrator.js";

/**
 * Per-agent inactivity budgets (T-0309), a structural copy of
 * PHASE_TIMEOUT_MS_BY_AGENT / resolvePhaseTimeoutMs (see phaseTimeout.test.js).
 *
 * DEFAULT_INACTIVITY_TIMEOUT_MS's own docstring justifies 8 minutes against
 * cmake/pip quiet stretches and never considered GPU training. T-0229 measured
 * a ~7-minute SDXL checkpoint load (6.94 GB at ~32 MB/s over the WSL 9p mount)
 * before training even starts, with acknowledged run-to-run variance in that
 * read rate -- close enough to the 8-minute default that a slower-than-usual
 * load could trip the watchdog on a run that was never stuck.
 *
 * This is a cost ceiling, same as PHASE_TIMEOUT_MS_BY_AGENT -- not the hang
 * defence. The mtime-liveness card is what tells a working run apart from a
 * wedged one; this only sizes the residual budget per agent class.
 */
describe("resolveInactivityTimeoutMs", () => {
  it("gives the assets agent a longer inactivity budget than the default", () => {
    expect(resolveInactivityTimeoutMs("assets")).toBe(INACTIVITY_TIMEOUT_MS_BY_AGENT.assets);
    expect(INACTIVITY_TIMEOUT_MS_BY_AGENT.assets).toBeGreaterThan(DEFAULT_INACTIVITY_TIMEOUT_MS);
  });

  it("leaves every other agent on the 8-minute default", () => {
    for (const agent of ["server", "client", "infra", "generic", "reviewer", "planner", "audio"]) {
      expect(resolveInactivityTimeoutMs(agent)).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    }
  });

  it("falls back to the default for an unknown, null or missing agent", () => {
    expect(resolveInactivityTimeoutMs("nonesuch")).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(resolveInactivityTimeoutMs(null)).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(resolveInactivityTimeoutMs(undefined)).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
  });

  it("does not inherit anything from Object.prototype for a prototype-named agent", () => {
    expect(resolveInactivityTimeoutMs("constructor")).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
    expect(resolveInactivityTimeoutMs("toString")).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
  });

  // Precedence: explicit override > per-agent map > default.
  it("lets an explicit override beat the per-agent budget", () => {
    expect(resolveInactivityTimeoutMs("assets", { override: 60 * 1000 })).toBe(60 * 1000);
  });

  it("lets an explicit override beat the default", () => {
    expect(resolveInactivityTimeoutMs("server", { override: 5 * 60 * 1000 })).toBe(5 * 60 * 1000);
  });

  it("ignores a non-positive or unparseable override and keeps the per-agent budget", () => {
    for (const bad of [0, -1, NaN, null, undefined, "abc"]) {
      expect(resolveInactivityTimeoutMs("assets", { override: bad })).toBe(INACTIVITY_TIMEOUT_MS_BY_AGENT.assets);
    }
  });

  it("accepts an injected per-agent map, so future tuning is one line", () => {
    const byAgent = { assets: 1000, audio: 2000 };
    expect(resolveInactivityTimeoutMs("assets", { byAgent })).toBe(1000);
    expect(resolveInactivityTimeoutMs("audio", { byAgent })).toBe(2000);
    expect(resolveInactivityTimeoutMs("server", { byAgent })).toBe(DEFAULT_INACTIVITY_TIMEOUT_MS);
  });

  it("exposes the budgets as a frozen map keyed by agent name", () => {
    expect(INACTIVITY_TIMEOUT_MS_BY_AGENT.assets).toBeGreaterThan(0);
    expect(Object.isFrozen(INACTIVITY_TIMEOUT_MS_BY_AGENT)).toBe(true);
  });

  it("keeps every per-agent inactivity budget at or above the default -- the map raises, never lowers", () => {
    for (const ms of Object.values(INACTIVITY_TIMEOUT_MS_BY_AGENT)) {
      expect(ms).toBeGreaterThanOrEqual(DEFAULT_INACTIVITY_TIMEOUT_MS);
    }
  });

  // A larger inactivity budget than an agent's own phase budget would be a
  // mistake (inactivity is meant to be the tighter, per-phase check inside the
  // wider phase budget) -- the opposite direction (well under the phase
  // budget) is what's expected here, and is documented as harmless either way
  // in INACTIVITY_TIMEOUT_MS_BY_AGENT's own docstring.
  it("keeps the assets inactivity budget well under the assets phase budget", () => {
    expect(INACTIVITY_TIMEOUT_MS_BY_AGENT.assets).toBeLessThan(PHASE_TIMEOUT_MS_BY_AGENT.assets);
  });
});
