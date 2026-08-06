import yaml from "js-yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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

const ID_RE = /^T-\d{4}$/;
const CREATED_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["backlog", "ready", "in-progress", "validation", "review", "done", "blocked", "retired"];
const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const ASSIGNABLE_AGENT_NAMES = ["infra", "server", "client", "assets", "audio", "planner"];
const AGENTS = [...ASSIGNABLE_AGENT_NAMES, null];
const OPTIONAL_FIELDS = ["branch", "commit", "pr"];
const DELIVERABLE_TYPES = ["code", "artifact"];
const NUMERIC_FIELDS = ["attempts"];
const ARRAY_FIELDS = ["comments", "attachments"];
const COMMENT_FIELDS = ["author", "text", "timestamp"];
const ATTACHMENT_STRING_FIELDS = ["filename", "mimetype", "uploaded_by", "uploaded_at"];

function validateComments(comments) {
  if (!Array.isArray(comments)) {
    throw new Error("Invalid comments: expected an array");
  }
  for (const comment of comments) {
    if (typeof comment !== "object" || comment === null || Array.isArray(comment)) {
      throw new Error("Invalid comments entry: expected an object with author, text, timestamp");
    }
    for (const field of COMMENT_FIELDS) {
      if (typeof comment[field] !== "string" || comment[field].length === 0) {
        throw new Error(`Invalid comments entry: "${field}" must be a non-empty string`);
      }
    }
  }
}

function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    throw new Error("Invalid attachments: expected an array");
  }
  for (const attachment of attachments) {
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
      throw new Error(
        "Invalid attachments entry: expected an object with filename, size, mimetype, uploaded_by, uploaded_at"
      );
    }
    for (const field of ATTACHMENT_STRING_FIELDS) {
      if (typeof attachment[field] !== "string" || attachment[field].length === 0) {
        throw new Error(`Invalid attachments entry: "${field}" must be a non-empty string`);
      }
    }
    if (typeof attachment.size !== "number" || !Number.isFinite(attachment.size) || attachment.size < 0) {
      throw new Error('Invalid attachments entry: "size" must be a non-negative number');
    }
  }
}

function validateTask(data) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in data)) {
      throw new Error(`Task frontmatter missing required field: ${field}`);
    }
  }
  if (typeof data.id !== "string" || !ID_RE.test(data.id)) {
    throw new Error(`Invalid task id "${data.id}": expected format T-NNNN`);
  }
  if (typeof data.title !== "string" || data.title.length === 0) {
    throw new Error("Invalid task title: expected a non-empty string");
  }
  if (!STATUSES.includes(data.status)) {
    throw new Error(`Invalid status "${data.status}": expected one of ${STATUSES.join(", ")}`);
  }
  if (!PRIORITIES.includes(data.priority)) {
    throw new Error(
      `Invalid priority "${data.priority}": expected one of ${PRIORITIES.join(", ")}`
    );
  }
  if (!Number.isInteger(data.phase)) {
    throw new Error(`Invalid phase "${data.phase}": expected an integer`);
  }
  if (!AGENTS.includes(data.agent)) {
    throw new Error(
      `Invalid agent "${data.agent}": expected one of ${AGENTS.filter(Boolean).join(", ")} or null`
    );
  }
  if (!Array.isArray(data.depends_on)) {
    throw new Error("Invalid depends_on: expected an array of task ids");
  }
  for (const dep of data.depends_on) {
    if (typeof dep !== "string" || !ID_RE.test(dep)) {
      throw new Error(`Invalid depends_on entry "${dep}": expected format T-NNNN`);
    }
  }
  if (typeof data.created !== "string" || !CREATED_RE.test(data.created)) {
    throw new Error(`Invalid created date "${data.created}": expected YYYY-MM-DD`);
  }
  for (const field of OPTIONAL_FIELDS) {
    if (field in data && data[field] !== null && typeof data[field] !== "string") {
      throw new Error(`Invalid ${field} "${data[field]}": expected a string or null`);
    }
  }
  if ("deliverable_type" in data && !DELIVERABLE_TYPES.includes(data.deliverable_type)) {
    throw new Error(
      `Invalid deliverable_type "${data.deliverable_type}": expected one of ${DELIVERABLE_TYPES.join(", ")}`
    );
  }
  for (const field of NUMERIC_FIELDS) {
    if (field in data && (!Number.isInteger(data[field]) || data[field] < 0)) {
      throw new Error(`Invalid ${field} "${data[field]}": expected a non-negative integer`);
    }
  }
  if ("comments" in data) {
    validateComments(data.comments);
  }
  if ("attachments" in data) {
    validateAttachments(data.attachments);
  }
}

export function parseTask(raw) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error("Task file is missing frontmatter delimiters (--- ... ---)");
  }
  const [, yamlText, body] = match;

  let data;
  try {
    data = yaml.load(yamlText);
  } catch (err) {
    throw new Error(`Task frontmatter is not valid YAML: ${err.message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Task frontmatter must be a YAML mapping");
  }

  // YAML auto-parses unquoted ISO dates (the PLAN.md schema example) into Date objects.
  if (data.created instanceof Date) {
    data.created = data.created.toISOString().slice(0, 10);
  }

  validateTask(data);

  return {
    id: data.id,
    title: data.title,
    status: data.status,
    priority: data.priority,
    phase: data.phase,
    agent: data.agent,
    depends_on: data.depends_on,
    created: data.created,
    branch: data.branch ?? null,
    commit: data.commit ?? null,
    pr: data.pr ?? null,
    deliverable_type: data.deliverable_type ?? "code",
    attempts: data.attempts ?? 0,
    comments: Array.isArray(data.comments) ? data.comments : [],
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    body
  };
}

export function serializeTask(task) {
  validateTask(task);
  if (typeof task.body !== "string") {
    throw new Error("Invalid task body: expected a string");
  }

  const lines = [
    ...REQUIRED_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field])}`),
    ...OPTIONAL_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? null)}`),
    `deliverable_type: ${JSON.stringify(task.deliverable_type ?? "code")}`,
    ...NUMERIC_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? 0)}`),
    ...ARRAY_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? [])}`)
  ];
  return `---\n${lines.join("\n")}\n---\n${task.body}`;
}
