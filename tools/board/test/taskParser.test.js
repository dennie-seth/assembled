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
  deliverable_type: "code",
  attempts: 0,
  comments: [],
  attachments: [],
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

  it("serializes agent: null as-is, but coerces it back to 'generic' on the way back in (parser-level coercion, not a true round-trip)", () => {
    const task = { ...VALID_TASK, agent: null };
    const parsed = parseTask(serializeTask(task));
    expect(parsed).toEqual({ ...task, agent: "generic" });
  });

  it("round-trips agent: dispatch (non-executable escalation hand-off sentinel)", () => {
    const task = { ...VALID_TASK, agent: "dispatch", status: "ready" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("round-trips agent: generic (default general-purpose implementer)", () => {
    const task = { ...VALID_TASK, agent: "generic" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("coerces agent: null in the frontmatter to 'generic' on parse", () => {
    const raw = frontmatter({ agent: null });
    const parsed = parseTask(raw);
    expect(parsed.agent).toBe("generic");
  });

  it("coerces a missing agent field to 'generic' on parse, instead of throwing", () => {
    const raw = frontmatter();
    const fieldLine = /^agent:.*$/m;
    const stripped = raw.replace(fieldLine, "").replace(/\n{2,}/g, "\n");
    const parsed = parseTask(stripped);
    expect(parsed.agent).toBe("generic");
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

  it("accepts status: retired (cut/reissued cards leaving the active flow)", () => {
    const task = { ...VALID_TASK, status: "retired" };
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

describe("attempts (auto-retry counter for the bounded FAIL->auto-retry loop)", () => {
  it("round-trips a task with attempts set", () => {
    const task = { ...VALID_TASK, attempts: 3 };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("defaults attempts to 0 when absent from the frontmatter", () => {
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
    expect(parsed.attempts).toBe(0);
  });

  it("throws when attempts is not an integer", () => {
    expect(() => parseTask(frontmatter({ attempts: "three" }))).toThrow(/attempts/i);
  });

  it("throws when attempts is negative", () => {
    expect(() => parseTask(frontmatter({ attempts: -1 }))).toThrow(/attempts/i);
  });

  it("throws when attempts is a non-integer number", () => {
    expect(() => parseTask(frontmatter({ attempts: 1.5 }))).toThrow(/attempts/i);
  });
});

describe("comments (human feedback for iterative re-runs)", () => {
  it("round-trips a task with comments set", () => {
    const task = {
      ...VALID_TASK,
      comments: [
        { author: "Dennie", text: "CI check X failed, please fix.", timestamp: "2026-08-05T12:00:00.000Z" }
      ]
    };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("round-trips multiple comments in order", () => {
    const task = {
      ...VALID_TASK,
      comments: [
        { author: "Dennie", text: "First note", timestamp: "2026-08-05T12:00:00.000Z" },
        { author: "Dennie", text: "Second note", timestamp: "2026-08-05T13:00:00.000Z" }
      ]
    };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("defaults comments to [] when absent from the frontmatter", () => {
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
    expect(parsed.comments).toEqual([]);
  });

  it("throws when comments is not an array", () => {
    expect(() => parseTask(frontmatter({ comments: "not an array" }))).toThrow(/comments/i);
  });

  it("throws when a comment entry is missing a required field", () => {
    expect(() =>
      parseTask(frontmatter({ comments: [{ author: "Dennie", text: "note" }] }))
    ).toThrow(/comments/i);
  });

  it("throws when a comment entry has a non-string field", () => {
    expect(() =>
      parseTask(
        frontmatter({ comments: [{ author: "Dennie", text: "note", timestamp: 42 }] })
      )
    ).toThrow(/comments/i);
  });
});

describe("attachments (files uploaded to a card)", () => {
  it("round-trips a task with attachments set", () => {
    const task = {
      ...VALID_TASK,
      attachments: [
        {
          filename: "reference.png",
          size: 1024,
          mimetype: "image/png",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T12:00:00.000Z"
        }
      ]
    };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("round-trips multiple attachments in order", () => {
    const task = {
      ...VALID_TASK,
      attachments: [
        {
          filename: "a.png",
          size: 10,
          mimetype: "image/png",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T12:00:00.000Z"
        },
        {
          filename: "b.bin",
          size: 20,
          mimetype: "application/octet-stream",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T13:00:00.000Z"
        }
      ]
    };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("defaults attachments to [] when absent from the frontmatter", () => {
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
    expect(parsed.attachments).toEqual([]);
  });

  it("throws when attachments is not an array", () => {
    expect(() => parseTask(frontmatter({ attachments: "not an array" }))).toThrow(/attachments/i);
  });

  it("throws when an attachment entry is missing a required field", () => {
    expect(() =>
      parseTask(frontmatter({ attachments: [{ filename: "a.png", size: 10 }] }))
    ).toThrow(/attachments/i);
  });

  it("throws when an attachment entry has a non-string field", () => {
    expect(() =>
      parseTask(
        frontmatter({
          attachments: [
            { filename: "a.png", size: 10, mimetype: "image/png", uploaded_by: "Dennie", uploaded_at: 42 }
          ]
        })
      )
    ).toThrow(/attachments/i);
  });

  it("throws when an attachment entry's size is not a non-negative number", () => {
    expect(() =>
      parseTask(
        frontmatter({
          attachments: [
            {
              filename: "a.png",
              size: -1,
              mimetype: "image/png",
              uploaded_by: "Dennie",
              uploaded_at: "2026-08-05T12:00:00.000Z"
            }
          ]
        })
      )
    ).toThrow(/attachments/i);
  });
});

describe("deliverable_type (code vs. produced-artifact cards)", () => {
  it("defaults deliverable_type to 'code' when absent from the frontmatter", () => {
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
    expect(parsed.deliverable_type).toBe("code");
  });

  it("round-trips deliverable_type: 'artifact'", () => {
    const task = { ...VALID_TASK, deliverable_type: "artifact" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("round-trips deliverable_type: 'code' explicitly", () => {
    const task = { ...VALID_TASK, deliverable_type: "code" };
    expect(parseTask(serializeTask(task))).toEqual(task);
  });

  it("throws on an invalid deliverable_type", () => {
    expect(() => parseTask(frontmatter({ deliverable_type: "vibes" }))).toThrow(/deliverable_type/i);
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
  // "agent" is deliberately excluded here: unlike the other required fields, a missing
  // agent no longer throws -- it's coerced to "generic" (see the coercion tests above).
  const REQUIRED_FIELDS = [
    "id",
    "title",
    "status",
    "priority",
    "phase",
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
