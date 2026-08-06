import { describe, it, expect } from "vitest";
import { parseAcceptanceCriteria } from "../src/lib/acceptanceCriteria.js";

describe("parseAcceptanceCriteria", () => {
  it("extracts unchecked checkbox items under ## Acceptance", () => {
    const body = "## Context\nSomething.\n\n## Acceptance\n- [ ] first thing\n- [ ] second thing\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "first thing", checked: false },
      { text: "second thing", checked: false }
    ]);
  });

  it("marks checked items ([x] or [X]) as checked: true", () => {
    const body = "## Acceptance\n- [x] done one\n- [X] done two\n- [ ] not done\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "done one", checked: true },
      { text: "done two", checked: true },
      { text: "not done", checked: false }
    ]);
  });

  it("returns [] when there is no Acceptance section at all", () => {
    expect(parseAcceptanceCriteria("## Context\nJust context, no acceptance.\n")).toEqual([]);
  });

  it("returns [] for an empty body", () => {
    expect(parseAcceptanceCriteria("")).toEqual([]);
  });

  it("returns [] for a non-string body", () => {
    expect(parseAcceptanceCriteria(undefined)).toEqual([]);
    expect(parseAcceptanceCriteria(null)).toEqual([]);
  });

  it("stops at the next ## heading and ignores content after it", () => {
    const body =
      "## Acceptance\n- [ ] in scope\n\n## Validation: PASS (2026-08-04)\n- [ ] not an AC, a stray checkbox in a validation note\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "in scope", checked: false }]);
  });

  it("ignores non-checkbox lines within the Acceptance section", () => {
    const body = "## Acceptance\nSome prose explaining context.\n- [ ] the actual criterion\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "the actual criterion", checked: false }]);
  });

  it("trims surrounding whitespace from criterion text", () => {
    const body = "## Acceptance\n-   [ ]    padded text   \n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "padded text", checked: false }]);
  });

  it("matches the real T-0136 card's Acceptance section shape", () => {
    const body =
      "As the LoRA pipeline...\n\n## Acceptance\n\n- [ ] T-0072's Attachments section shows the fetched corpus images\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "T-0072's Attachments section shows the fetched corpus images", checked: false }
    ]);
  });
});
