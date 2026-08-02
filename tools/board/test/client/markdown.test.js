import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../src/client/markdown.js";

describe("renderMarkdown", () => {
  it("renders ## headings", () => {
    expect(renderMarkdown("## Context")).toBe("<h2>Context</h2>");
  });

  it("renders heading levels matching the number of leading #s", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("### Sub")).toBe("<h3>Sub</h3>");
  });

  it("renders unchecked checklist items as disabled checkboxes", () => {
    const html = renderMarkdown("- [ ] do the thing");
    expect(html).toContain('<ul class="checklist">');
    expect(html).toContain('<input type="checkbox" disabled />');
    expect(html).toContain("do the thing");
  });

  it("renders checked checklist items (both x and X) as checked", () => {
    expect(renderMarkdown("- [x] done")).toContain("checked");
    expect(renderMarkdown("- [X] done")).toContain("checked");
  });

  it("renders plain bullet lines as an unordered list", () => {
    const html = renderMarkdown("- one\n- two");
    expect(html).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
  });

  it("renders a plain paragraph line", () => {
    expect(renderMarkdown("just some text")).toBe("<p>just some text</p>");
  });

  it("renders a full Context/Acceptance body with headings and a checklist", () => {
    const body = "## Context\nSome context here.\n\n## Acceptance\n- [ ] first\n- [x] second";
    const html = renderMarkdown(body);
    expect(html).toBe(
      [
        "<h2>Context</h2>",
        "<p>Some context here.</p>",
        "<h2>Acceptance</h2>",
        '<ul class="checklist">',
        '<li><input type="checkbox" disabled /> first</li>',
        '<li><input type="checkbox" disabled checked /> second</li>',
        "</ul>"
      ].join("\n")
    );
  });

  it("escapes HTML-significant characters to prevent injection", () => {
    const html = renderMarkdown('<script>alert("hi")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns an empty string for an empty or missing body", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(undefined)).toBe("");
  });
});
