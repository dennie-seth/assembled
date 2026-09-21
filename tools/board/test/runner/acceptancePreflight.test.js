import { describe, it, expect } from "vitest";
import { checkAcceptancePreflight } from "../../src/runner/acceptancePreflight.js";
import { T0403_ACCEPTANCE_BODY } from "../fixtures/t0403AcceptanceBody.js";

describe("checkAcceptancePreflight", () => {
  it("returns ok:false when body has no ## Acceptance section", () => {
    const result = checkAcceptancePreflight({ id: "T-0001", body: "## Context\nsome context\n" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0001");
    expect(result.message).toContain("Acceptance");
  });

  it("returns ok:false when body is an empty string", () => {
    const result = checkAcceptancePreflight({ id: "T-0002", body: "" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0002");
  });

  it("returns ok:false when body is null", () => {
    const result = checkAcceptancePreflight({ id: "T-0003", body: null });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when ## Acceptance section exists but contains no checkbox items", () => {
    const body = "## Acceptance\n\nsome prose but no checkboxes\n";
    const result = checkAcceptancePreflight({ id: "T-0004", body });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0004");
  });

  it("returns ok:true when body has ## Acceptance with at least one unchecked item", () => {
    const body = "## Context\n...\n\n## Acceptance\n\n- [ ] something must pass\n";
    const result = checkAcceptancePreflight({ id: "T-0005", body });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("");
  });

  it("returns ok:true when body has ## Acceptance with already-checked items", () => {
    const body = "## Acceptance\n\n- [x] already done\n- [ ] another\n";
    const result = checkAcceptancePreflight({ id: "T-0006", body });
    expect(result.ok).toBe(true);
  });

  it("is case-insensitive for the Acceptance heading", () => {
    const body = "## ACCEPTANCE\n\n- [ ] works\n";
    const result = checkAcceptancePreflight({ id: "T-0007", body });
    expect(result.ok).toBe(true);
  });

  it("handles task with no id gracefully", () => {
    const result = checkAcceptancePreflight({ body: "" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unknown");
  });

  it("stops at the next heading after ## Acceptance — items after it are not counted", () => {
    const body = "## Acceptance\n\n## Next Section\n\n- [ ] not part of acceptance\n";
    const result = checkAcceptancePreflight({ id: "T-0009", body });
    expect(result.ok).toBe(false);
  });

  // T-0405: a card whose ## Acceptance heading carries a qualifier ("(story-level -- planner
  // expands)", "criteria", a trailing colon, ...) used to parse as having no acceptance section at
  // all and hard-block here before the implementer did any work. T-0403 hit this twice.
  it("returns ok:true when the ## Acceptance heading carries a qualifier", () => {
    const body = "## Acceptance (story-level -- planner expands)\n\n- [ ] something must pass\n";
    const result = checkAcceptancePreflight({ id: "T-0010", body });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("");
  });

  it("does not block on the T-0403 regression fixture (qualified heading, 8 items, Edge cases item)", () => {
    const result = checkAcceptancePreflight({ id: "T-0403", body: T0403_ACCEPTANCE_BODY });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("");
  });
});
