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
const STATUSES = ["backlog", "ready", "in-progress", "validation", "review", "done", "blocked"];
const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const ASSIGNABLE_AGENT_NAMES = ["infra", "server", "client", "assets", "audio"];
const AGENTS = [...ASSIGNABLE_AGENT_NAMES, null];
const OPTIONAL_FIELDS = ["branch", "commit"];

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
    ...OPTIONAL_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? null)}`)
  ];
  return `---\n${lines.join("\n")}\n---\n${task.body}`;
}
