import { describe, it, expect } from "vitest";
import { checkEdgeCasesPreflight } from "../../src/runner/edgeCasesPreflight.js";

function task(body, overrides = {}) {
  return { id: "T-0900", body, ...overrides };
}

describe("checkEdgeCasesPreflight -- no Acceptance section", () => {
  it("returns no warnings (that's acceptancePreflight.js's job, not this one's)", () => {
    const result = checkEdgeCasesPreflight(task("## Context\nnothing here\n"));
    expect(result.warnings).toEqual([]);
  });

  it("returns no warnings for an empty body", () => {
    const result = checkEdgeCasesPreflight(task(""));
    expect(result.warnings).toEqual([]);
  });

  it("returns no warnings when body is missing entirely", () => {
    const result = checkEdgeCasesPreflight({ id: "T-0900" });
    expect(result.warnings).toEqual([]);
  });
});

describe("checkEdgeCasesPreflight -- Acceptance section with no Edge cases block", () => {
  it("warns when the Acceptance section has checklist items but no **Edge cases:** line", () => {
    const body = "## Context\nDo it.\n\n## Acceptance\n- [ ] works\n- [ ] also works\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Edge cases/);
    expect(result.warnings[0]).toMatch(/planner\.md/);
  });

  it("warns when a later section exists but Acceptance itself has no Edge cases block", () => {
    const body =
      "## Context\nDo it.\n\n## Acceptance\n- [ ] works\n\n## Story\nAs a player...\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toHaveLength(1);
  });
});

describe("checkEdgeCasesPreflight -- Acceptance section with an Edge cases block", () => {
  it("returns no warnings when **Edge cases:** is present", () => {
    const body =
      "## Acceptance\n- [ ] works\n\n**Edge cases:**\n- [ ] handles the empty-input case\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toEqual([]);
  });

  it("matches the label case-insensitively and tolerates a missing trailing colon inside the bold", () => {
    const body = "## Acceptance\n- [ ] works\n\n**edge cases**\n- [ ] boundary case\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toEqual([]);
  });

  it("does not require the Edge cases block to be the very next line, as long as it's before the next heading", () => {
    const body =
      "## Acceptance\n- [ ] works\n- [ ] also works\n\nSome prose in between.\n\n**Edge cases:**\n- [ ] boundary case\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toEqual([]);
  });

  it("does not credit an Edge cases block that appears in a later section, past the next heading", () => {
    const body =
      "## Acceptance\n- [ ] works\n\n## Notes\n**Edge cases:**\n- [ ] too late, this is a different section\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toHaveLength(1);
  });
});
