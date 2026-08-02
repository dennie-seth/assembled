import { describe, it, expect } from "vitest";
import { buildUpdateBody } from "../../src/client/detail.js";

function original(overrides = {}) {
  return {
    id: "T-0001",
    title: "Original title",
    status: "backlog",
    priority: "P2",
    phase: 1,
    agent: null,
    depends_on: [],
    created: "2026-07-31",
    body: "## Context\noriginal body",
    ...overrides
  };
}

describe("buildUpdateBody", () => {
  it("returns an empty object when nothing changed", () => {
    const orig = original();
    expect(buildUpdateBody(orig, { ...orig })).toEqual({});
  });

  it("includes only the fields that actually changed", () => {
    const orig = original();
    const patch = buildUpdateBody(orig, { ...orig, title: "New title", priority: "P0" });
    expect(patch).toEqual({ title: "New title", priority: "P0" });
  });

  it("supports changing status via the same diff path as a drag", () => {
    const orig = original();
    expect(buildUpdateBody(orig, { ...orig, status: "review" })).toEqual({ status: "review" });
  });

  it("supports editing the markdown body", () => {
    const orig = original();
    const patch = buildUpdateBody(orig, { ...orig, body: "## Context\nedited" });
    expect(patch).toEqual({ body: "## Context\nedited" });
  });

  it("ignores fields not present in EDITABLE_FIELDS such as id", () => {
    const orig = original();
    const patch = buildUpdateBody(orig, { ...orig, id: "T-9999" });
    expect(patch).toEqual({});
  });

  it("includes agent when changed", () => {
    const orig = original({ agent: null });
    const patch = buildUpdateBody(orig, { ...orig, agent: "infra" });
    expect(patch).toEqual({ agent: "infra" });
  });

  it("includes phase when changed", () => {
    const orig = original({ phase: 1 });
    const patch = buildUpdateBody(orig, { ...orig, phase: 2 });
    expect(patch).toEqual({ phase: 2 });
  });

  it("includes depends_on when its contents change", () => {
    const orig = original({ depends_on: ["T-0002"] });
    const patch = buildUpdateBody(orig, { ...orig, depends_on: ["T-0002", "T-0003"] });
    expect(patch).toEqual({ depends_on: ["T-0002", "T-0003"] });
  });

  it("does not include depends_on when it is unchanged, even as a new array instance", () => {
    const orig = original({ depends_on: ["T-0002", "T-0003"] });
    const patch = buildUpdateBody(orig, { ...orig, depends_on: ["T-0002", "T-0003"] });
    expect(patch).toEqual({});
  });

  it("ignores an edited field that is explicitly undefined", () => {
    const orig = original();
    const patch = buildUpdateBody(orig, { ...orig, title: undefined });
    expect(patch).toEqual({});
  });
});
