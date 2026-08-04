import { describe, it, expect } from "vitest";
import { parseTask, serializeTask } from "../src/lib/taskParser.js";

const VALID_TASK = {
  id: "T-0011",
  title: "Task md parser/serializer",
  status: "backlog",
  priority: "P1",
  phase: 1,
  agent: "infra",
  depends_on: ["T-0002"],
  created: "2026-07-31",
  branch: null,
  commit: null,
  pr: null,
  body: "## Context\nParse frontmatter.\n\n## Acceptance\n- [ ] round-trips\n"
};

function frontmatter(overrides = {}, body = VALID_TASK.body) {
  const fields = { ...VALID_TASK, ...overrides };
  delete fields.body;
  const lines = Object.entries(fields)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${lines}\n---\n${body}`;
}

describe("parseTask / serializeTask round-trip", () => {
  it("round-trips a valid task", () => {
    const raw = serializeTask(VALID_TASK);
    const parsed = parseTask(raw);
    expect(parsed).toEqual(VALID_TASK);
  });

  it("round-trips depends_on: []", () => {
    const task = { ...VALID_TASK, depends_on: [] };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("round-trips agent: null", () => {
    const task = { ...VALID_TASK, agent: null };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("round-trips unicode in title and body", () => {
    const task = {
      ...VALID_TASK,
      title: "タスク: 日本語タイトル 🎮 — assemblé",
      body: "## Context\nUnicode: héllo wörld 日本語 emoji 🚀\n\n## Acceptance\n- [ ] 完了\n"
    };
    const parsed = parseTask(serializeTask(task));
    expect(parsed).toEqual(task);
  });

  it("preserves empty body", () => {
    const task = { ...VALID_TASK, body: "" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("accepts status: validation (Agent Runner VALIDATION lifecycle state)", () => {
    const task = { ...VALID_TASK, status: "validation" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("parses the PLAN.md example format with unquoted YAML scalars", () => {
    const raw = [
      "---",
      "id: T-0007",
      "title: Implement TaskStore parser",
      "status: backlog",
      "priority: P1",
      "phase: 1",
      "agent: infra",
      "depends_on: [T-0002]",
      "created: 2026-07-31",
      "---",
      "## Context",
      "...",
      "## Acceptance",
      "- [ ] ...",
      ""
    ].join("\n");
    const parsed = parseTask(raw);
    expect(parsed).toMatchObject({
      id: "T-0007",
      title: "Implement TaskStore parser",
      status: "backlog",
      priority: "P1",
      phase: 1,
      agent: "infra",
      depends_on: ["T-0002"],
      created: "2026-07-31"
    });
    expect(typeof parsed.created).toBe("string");
  });
});

describe("branch / commit (review metadata)", () => {
  it("round-trips a task with branch and commit set", () => {
    const task = { ...VALID_TASK, branch: "feature/T-0011", commit: "abc1234def5678" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("defaults branch and commit to null when absent from the frontmatter", () => {
    const raw = [
      "---",
      "id: T-0007",
      "title: Implement TaskStore parser",
      "status: backlog",
      "priority: P1",
      "phase: 1",
      "agent: infra",
      "depends_on: [T-0002]",
      "created: 2026-07-31",
      "---",
      "body"
    ].join("\n");
    const parsed = parseTask(raw);
    expect(parsed.branch).toBeNull();
    expect(parsed.commit).toBeNull();
  });

  it("throws when branch is not a string or null", () => {
    expect(() => parseTask(frontmatter({ branch: 42 }))).toThrow(/branch/i);
  });

  it("throws when commit is not a string or null", () => {
    expect(() => parseTask(frontmatter({ commit: 42 }))).toThrow(/commit/i);
  });
});

describe("pr (auto-opened PR url)", () => {
  it("round-trips a task with pr set", () => {
    const task = { ...VALID_TASK, pr: "https://github.com/example/repo/pull/42" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("defaults pr to null when absent from the frontmatter", () => {
    const raw = [
      "---",
      "id: T-0007",
      "title: Implement TaskStore parser",
      "status: backlog",
      "priority: P1",
      "phase: 1",
      "agent: infra",
      "depends_on: [T-0002]",
      "created: 2026-07-31",
      "---",
      "body"
    ].join("\n");
    const parsed = parseTask(raw);
    expect(parsed.pr).toBeNull();
  });

  it("throws when pr is not a string or null", () => {
    expect(() => parseTask(frontmatter({ pr: 42 }))).toThrow(/pr/i);
  });
});

describe("parseTask malformed input", () => {
  it("throws when there is no frontmatter at all", () => {
    expect(() => parseTask("just a plain markdown file\n")).toThrow(/frontmatter/i);
  });

  it("throws when the opening delimiter is missing", () => {
    expect(() => parseTask("id: T-0001\n---\nbody\n")).toThrow(/frontmatter/i);
  });

  it("throws when the closing delimiter is missing", () => {
    expect(() => parseTask("---\nid: T-0001\ntitle: x\n")).toThrow(/frontmatter/i);
  });

  it("throws on invalid YAML syntax", () => {
    expect(() => parseTask("---\nid: [unterminated\n---\nbody\n")).toThrow();
  });
});

describe("parseTask missing/invalid fields", () => {
  const REQUIRED_FIELDS = [
    "id",
    "title",
    "status",
    "priority",
    "phase",
    "agent",
    "depends_on",
    "created"
  ];

  for (const field of REQUIRED_FIELDS) {
    it(`throws when ${field} is missing`, () => {
      const raw = frontmatter();
      const fieldLine = new RegExp(`^${field}:.*$`, "m");
      const stripped = raw.replace(fieldLine, "").replace(/\n{2,}/g, "\n");
      expect(() => parseTask(stripped)).toThrow(new RegExp(field));
    });
  }

  it("throws on malformed id (missing T- prefix)", () => {
    expect(() => parseTask(frontmatter({ id: "0011" }))).toThrow(/id/i);
  });

  it("throws on malformed id (wrong digit count)", () => {
    expect(() => parseTask(frontmatter({ id: "T-11" }))).toThrow(/id/i);
  });

  it("throws on invalid status", () => {
    expect(() => parseTask(frontmatter({ status: "done-ish" }))).toThrow(/status/i);
  });

  it("throws on invalid priority", () => {
    expect(() => parseTask(frontmatter({ priority: "P9" }))).toThrow(/priority/i);
  });

  it("throws on invalid agent", () => {
    expect(() => parseTask(frontmatter({ agent: "designer" }))).toThrow(/agent/i);
  });

  it("accepts agent: planner (backlog-audit agent, distinct from the implementer agents)", () => {
    const task = { ...VALID_TASK, agent: "planner" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("throws on non-integer phase", () => {
    expect(() => parseTask(frontmatter({ phase: "one" }))).toThrow(/phase/i);
  });

  it("throws on invalid created date format", () => {
    expect(() => parseTask(frontmatter({ created: "31-07-2026" }))).toThrow(/created/i);
  });

  it("throws when depends_on is not an array", () => {
    expect(() => parseTask(frontmatter({ depends_on: "T-0002" }))).toThrow(/depends_on/i);
  });

  it("throws when a depends_on entry is malformed", () => {
    expect(() => parseTask(frontmatter({ depends_on: ["nope"] }))).toThrow(/depends_on/i);
  });
});

describe("serializeTask", () => {
  it("throws on invalid task object (defence in depth, mirrors parseTask)", () => {
    expect(() => serializeTask({ ...VALID_TASK, status: "bogus" })).toThrow(/status/i);
  });

  it("produces frontmatter delimited by --- lines", () => {
    const raw = serializeTask(VALID_TASK);
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toMatch(/\n---\n/);
  });
});
