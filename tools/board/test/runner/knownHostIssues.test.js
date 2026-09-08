import { describe, it, expect } from "vitest";
import { KNOWN_HOST_ISSUES } from "../../src/runner/knownHostIssues.js";

describe("knownHostIssues", () => {
  it("seeds the T-0272/T-0317 ComfyUI determinism-flags entry as the worked example, unresolved", () => {
    const entry = KNOWN_HOST_ISSUES.find((i) => i.id === "comfyui-determinism-flags");
    expect(entry).toBeTruthy();
    expect(entry.resolved).toBe(false);
    expect(entry.appliesToAgents).toEqual(expect.arrayContaining(["assets", "audio"]));
    expect(entry.host).toMatch(/ComfyUI/);
    expect(entry.action.length).toBeGreaterThan(0);
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.verify.length).toBeGreaterThan(0);
  });

  it("scopes the ComfyUI determinism entry to cards that actually mention reproducibility, not every assets/audio card", () => {
    const entry = KNOWN_HOST_ISSUES.find((i) => i.id === "comfyui-determinism-flags");
    expect(entry.bodyPattern).toBeInstanceOf(RegExp);
    expect(entry.bodyPattern.test("## Acceptance\n- [ ] render is byte-identical across two runs")).toBe(true);
    expect(entry.bodyPattern.test("## Acceptance\n- [ ] the sprite looks good")).toBe(false);
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
