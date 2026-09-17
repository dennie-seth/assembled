import { describe, it, expect } from "vitest";
import { KNOWN_HOST_ISSUES } from "../../src/runner/knownHostIssues.js";

describe("knownHostIssues", () => {
  it("no longer seeds the comfyui-determinism-flags entry (T-0346: withdrawn finding removed outright, not just withdrawn)", () => {
    const entry = KNOWN_HOST_ISSUES.find((i) => i.id === "comfyui-determinism-flags");
    expect(entry).toBeUndefined();
  });

  it("gives every entry the full required shape", () => {
    for (const entry of KNOWN_HOST_ISSUES) {
      expect(typeof entry.id).toBe("string");
      expect(Array.isArray(entry.appliesToAgents)).toBe(true);
      expect(entry.appliesToAgents.length).toBeGreaterThan(0);
      expect(typeof entry.host).toBe("string");
      expect(typeof entry.condition).toBe("string");
      expect(typeof entry.action).toBe("string");
      expect(typeof entry.reason).toBe("string");
      expect(typeof entry.verify).toBe("string");
      expect(typeof entry.resolved).toBe("boolean");
    }
  });

  it("freezes the registry so a preflight run can never mutate the shared list", () => {
    expect(Object.isFrozen(KNOWN_HOST_ISSUES)).toBe(true);
  });
});
