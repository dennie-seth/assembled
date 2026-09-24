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

describe("checkEdgeCasesPreflight -- Edge cases label present but empty (planner.md requires its own checklist items)", () => {
  it("warns when the label is immediately followed by the next heading, with no checklist items under it", () => {
    const body = "## Acceptance\n- [ ] works\n\n**Edge cases:**\n\n## Story\nAs a player...\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Edge cases/);
  });

  it("warns when the label is followed only by prose, with no `- [ ]` items before the end of the section", () => {
    const body =
      "## Acceptance\n- [ ] works\n\n**Edge cases:**\nWe considered some cases but didn't list any.\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toHaveLength(1);
  });

  it("returns no warnings once the label has at least one `- [ ]` item under it, even after intervening prose", () => {
    const body =
      "## Acceptance\n- [ ] works\n\n**Edge cases:**\nDerived from the card's own logic:\n- [ ] boundary case\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toEqual([]);
  });
});

// T-0405: this preflight has its own local, strict "## Acceptance" heading regex to find where
// the section starts (separate from parseAcceptanceCriteria's own now-tolerant one). Before this
// fix that meant a qualified heading passed parseAcceptanceCriteria (so items.length > 0, past the
// early-return) but then failed this file's OWN section-start scan -- startIdx stayed -1, and the
// function silently returned no warnings even for a card missing its Edge cases block entirely.
describe("checkEdgeCasesPreflight -- qualified heading (T-0403 failure mode)", () => {
  it("still warns when a qualified '## Acceptance (...)' heading has checklist items but no Edge cases block", () => {
    const body = "## Context\nDo it.\n\n## Acceptance (story-level -- planner expands)\n- [ ] works\n- [ ] also works\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Edge cases/);
  });

  it("returns no warnings when a qualified heading's section has a compliant Edge cases block", () => {
    const body =
      "## Acceptance criteria\n- [ ] works\n\n**Edge cases:**\n- [ ] handles the empty-input case\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings).toEqual([]);
  });
});

describe("checkEdgeCasesPreflight -- warning text stays observation-only (T-0388, T-0365 follow-up)", () => {
  const body = "## Context\nDo it.\n\n## Acceptance\n- [ ] works\n";

  it("does not assert or imply an effect on the rework rate", () => {
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings[0]).not.toMatch(/rework/i);
  });

  it("does not tell the reader what the reviewer will do", () => {
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings[0]).not.toMatch(/reviewer/i);
  });

  it("still says which section is missing the block and what a compliant block looks like", () => {
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.warnings[0]).toMatch(/## Acceptance/);
    expect(result.warnings[0]).toMatch(/\*\*Edge cases:\*\*/);
    expect(result.warnings[0]).toMatch(/- \[ \]/);
  });
});

// T-0408: this preflight must stay warn-only forever -- @DennieSeth was explicit that promoting
// it to a blocking gate is out of scope, permanently, regardless of what else changes about how
// reliably the planner authors the block. This is a structural regression test on the return
// shape itself (not just the caller's behavior, which runOrchestrator.edgeCasesPreflight.test.js
// already covers end-to-end): a later change that quietly adds an `ok`/`blocked`/`severity`
// field -- the shape every OTHER preflight in this file's sibling modules uses to signal a real
// gate -- would flip this from "advisory" to "actionable" without touching a single call site,
// and this test exists to catch exactly that.
describe("checkEdgeCasesPreflight -- return shape can never carry a blocking signal (T-0408 regression)", () => {
  it("returns an object with only a `warnings` key, for a card missing the block", () => {
    const body = "## Context\nDo it.\n\n## Acceptance\n- [ ] works\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(Object.keys(result)).toEqual(["warnings"]);
  });

  it("returns an object with only a `warnings` key, for a compliant card", () => {
    const body = "## Acceptance\n- [ ] works\n\n**Edge cases:**\n- [ ] handles empty input\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(Object.keys(result)).toEqual(["warnings"]);
  });

  it("never sets ok: false, blocked: true, or a severity/level field on its result", () => {
    const body = "## Context\nDo it.\n\n## Acceptance\n- [ ] works\n";
    const result = checkEdgeCasesPreflight(task(body));
    expect(result.ok).toBeUndefined();
    expect(result.blocked).toBeUndefined();
    expect(result.severity).toBeUndefined();
    expect(result.level).toBeUndefined();
  });
});
