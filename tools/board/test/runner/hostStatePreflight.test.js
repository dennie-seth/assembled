import { describe, it, expect } from "vitest";
import { checkHostStatePreflight } from "../../src/runner/hostStatePreflight.js";

const HOST_ISSUE = {
  id: "example-host-issue",
  appliesToAgents: ["assets", "audio"],
  host: "Windows ComfyUI host (F:\\ComfyUI)",
  condition: "ComfyUI is launched without deterministic flags",
  action: "Edit start-comfyui.bat and restart ComfyUI.",
  reason: "No agent has a shell on this host.",
  verify: "Submit the same seed twice across two server lifetimes and confirm identical hashes.",
  resolved: false
};

const RESOLVED_ISSUE = { ...HOST_ISSUE, id: "resolved-issue", resolved: true };

describe("checkHostStatePreflight", () => {
  it("blocks with a structured message when an unresolved issue applies to the assigned agent", () => {
    const result = checkHostStatePreflight({ id: "T-0500" }, "assets", { registry: [HOST_ISSUE] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0500");
    expect(result.message).toContain("host-action-request");
    expect(result.message).toContain(`host: ${HOST_ISSUE.host}`);
    expect(result.message).toContain(`action: ${HOST_ISSUE.action}`);
    expect(result.message).toContain(`reason: ${HOST_ISSUE.reason}`);
    expect(result.message).toContain(`verify: ${HOST_ISSUE.verify}`);
    expect(result.hostAction).toEqual({
      host: HOST_ISSUE.host,
      action: HOST_ISSUE.action,
      reason: HOST_ISSUE.reason,
      verify: HOST_ISSUE.verify
    });
  });

  it("passes when no registry entry applies to the assigned agent", () => {
    const result = checkHostStatePreflight({ id: "T-0500" }, "infra", { registry: [HOST_ISSUE] });
    expect(result.ok).toBe(true);
    expect(result.hostAction).toBeNull();
  });

  it("ignores a resolved entry even when it would otherwise apply", () => {
    const result = checkHostStatePreflight({ id: "T-0500" }, "assets", { registry: [RESOLVED_ISSUE] });
    expect(result.ok).toBe(true);
  });

  it("passes for an empty registry", () => {
    const result = checkHostStatePreflight({ id: "T-0500" }, "assets", { registry: [] });
    expect(result.ok).toBe(true);
  });

  it("defaults to the real known-host-issues registry when none is passed", () => {
    // Exercises the real module wiring without asserting on its (mutable) contents.
    const result = checkHostStatePreflight({ id: "T-0500" }, "infra");
    expect(typeof result.ok).toBe("boolean");
  });

  it("does not block a card whose body does not match the issue's bodyPattern (scoped to the cards actually affected)", () => {
    const scoped = { ...HOST_ISSUE, bodyPattern: /determinism/i };
    const result = checkHostStatePreflight(
      { id: "T-0500", body: "## Context\nGenerate a texture.\n\n## Acceptance\n- [ ] looks right\n" },
      "assets",
      { registry: [scoped] }
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a card whose body matches the issue's bodyPattern", () => {
    const scoped = { ...HOST_ISSUE, bodyPattern: /determinism/i };
    const result = checkHostStatePreflight(
      { id: "T-0500", body: "## Acceptance\n- [ ] output is byte-identical across runs, verifying determinism\n" },
      "assets",
      { registry: [scoped] }
    );
    expect(result.ok).toBe(false);
  });

  it("has no bodyPattern requirement when the entry omits it -- applies to every card the agent matches", () => {
    const result = checkHostStatePreflight({ id: "T-0500", body: "anything at all" }, "assets", { registry: [HOST_ISSUE] });
    expect(result.ok).toBe(false);
  });
});
