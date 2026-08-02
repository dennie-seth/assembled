import { describe, it, expect } from "vitest";
import { splitFrontmatter } from "../../src/runner/frontmatter.js";

describe("splitFrontmatter", () => {
  it("splits an agent-def-style frontmatter block from its body", () => {
    const raw = [
      "---",
      "name: infra",
      "description: Implements board tooling.",
      "tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(git:*)",
      "model: sonnet",
      "---",
      "",
      "# infra",
      "",
      "## Role",
      "Implements and maintains the board tooling."
    ].join("\n");

    const { data, body } = splitFrontmatter(raw);
    expect(data).toEqual({
      name: "infra",
      description: "Implements board tooling.",
      tools: "Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(git:*)",
      model: "sonnet"
    });
    expect(body).toContain("## Role");
    expect(body).toContain("Implements and maintains the board tooling.");
  });

  it("splits a rule-style frontmatter block with a paths array", () => {
    const raw = ['---', 'paths: ["tools/**"]', "---", "", "# JS conventions", "", "- ESM only."].join(
      "\n"
    );

    const { data, body } = splitFrontmatter(raw);
    expect(data).toEqual({ paths: ["tools/**"] });
    expect(body).toContain("# JS conventions");
    expect(body).toContain("- ESM only.");
  });

  it("throws when the frontmatter delimiters are missing", () => {
    expect(() => splitFrontmatter("# no frontmatter here\n")).toThrow(/frontmatter/i);
  });

  it("throws when the frontmatter is not valid YAML", () => {
    const raw = ["---", "name: [unterminated", "---", "body"].join("\n");
    expect(() => splitFrontmatter(raw)).toThrow();
  });

  it("throws when the frontmatter is not a mapping", () => {
    const raw = ["---", "- just", "- a", "- list", "---", "body"].join("\n");
    expect(() => splitFrontmatter(raw)).toThrow(/mapping/i);
  });

  it("handles a body-less file (frontmatter with nothing after the closing delimiter)", () => {
    const raw = ["---", "paths: [\"**\"]", "---"].join("\n");
    const { data, body } = splitFrontmatter(raw);
    expect(data).toEqual({ paths: ["**"] });
    expect(body).toBe("");
  });
});
