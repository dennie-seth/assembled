import { describe, it, expect } from "vitest";
import { formatHostActionRequest, parseHostActionRequest, HOST_ACTION_REQUEST_FIELDS } from "../../src/lib/hostActionRequest.js";

const REQUEST = {
  host: "Windows ComfyUI host (F:\\ComfyUI)",
  action: "Edit start-comfyui.bat to set CUBLAS_WORKSPACE_CONFIG=:4096:8, then restart ComfyUI.",
  reason: "No agent has a shell on this host; the launch flags live in a .bat file only a human can edit.",
  verify: "Submit the same seed twice across two server lifetimes and confirm identical output hashes."
};

describe("formatHostActionRequest", () => {
  it("renders a fenced host-action-request block carrying all four fields", () => {
    const text = formatHostActionRequest(REQUEST);
    expect(text).toContain("```host-action-request");
    expect(text).toContain(`host: ${REQUEST.host}`);
    expect(text).toContain(`action: ${REQUEST.action}`);
    expect(text).toContain(`reason: ${REQUEST.reason}`);
    expect(text).toContain(`verify: ${REQUEST.verify}`);
    expect(text.trim().endsWith("```")).toBe(true);
  });

  it("exposes the required field set", () => {
    expect(HOST_ACTION_REQUEST_FIELDS).toEqual(["host", "action", "reason", "verify"]);
  });
});

describe("parseHostActionRequest", () => {
  it("round-trips a block produced by formatHostActionRequest", () => {
    const text = formatHostActionRequest(REQUEST);
    expect(parseHostActionRequest(text)).toEqual(REQUEST);
  });

  it("finds the block embedded inside surrounding prose", () => {
    const text = `Some reviewer chatter first.\n\n${formatHostActionRequest(REQUEST)}\n\nAnd trailing notes too.`;
    expect(parseHostActionRequest(text)).toEqual(REQUEST);
  });

  it("returns null when no fenced block is present", () => {
    expect(parseHostActionRequest("plain permission denied writing to /etc")).toBeNull();
  });

  it("returns null when the block is missing a required field", () => {
    const text = ["```host-action-request", `host: ${REQUEST.host}`, `action: ${REQUEST.action}`, "```"].join("\n");
    expect(parseHostActionRequest(text)).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseHostActionRequest(null)).toBeNull();
    expect(parseHostActionRequest(undefined)).toBeNull();
  });
});
