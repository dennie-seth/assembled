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
// "dispatch" is a non-executable sentinel: a valid agent field value with no
// .claude/agents/dispatch.md definition, so listAssignableAgents' directory-intersection keeps
// it out of the manual New Card dropdown automatically. Cards land here only via
// RunOrchestrator's escalation flow when a card's auto-retry cap exhausts on a genuine blocker,
// and the runner's pick-up loop (RunOrchestrator.runCard) explicitly refuses to run them --
// see docs/design/escalation-workflow.md.
export const ASSIGNABLE_AGENT_NAMES = ["infra", "server", "client", "assets", "audio", "generic", "planner", "dispatch"];
const AGENTS = [...ASSIGNABLE_AGENT_NAMES, null];
const OPTIONAL_FIELDS = ["branch", "commit", "pr"];
const DELIVERABLE_TYPES = ["code", "artifact"];
const NUMERIC_FIELDS = ["attempts", "round"];
// Human direction-approval gate (src/lib/approvalGate.js). `requires_approval` is the explicit,
// author-set signal that this card's deliverable is a *direction* a human must sign off on --
// deliberately a field rather than a body-prose marker, so nothing has to guess which cards are
// gated. The other two record that sign-off and are written only by the server's approval paths
// (never accepted from a request body); they live in the schema so the record survives a card
// file round-trip like any other field.
const APPROVAL_FLAG_FIELD = "requires_approval";
const APPROVAL_RECORD_FIELDS = ["approved_by", "approved_at"];
// T-0343: per-card override of runOrchestrator.js's MAX_AUTO_RETRY_ATTEMPTS. Nullable --
// null means "no explicit override", which is what every pre-existing card has and must keep
// behaving exactly as it did before this field existed. The 1-20 range keeps a malformed or
// wildly out-of-range value from silently becoming an unbounded (or zero-attempt) retry loop.
const MAX_ATTEMPTS_FIELD = "max_attempts";
const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 20;
// T-0344: the experiment-round cap (src/lib/roundCap.js). `round` counts how many rounds this
// card has settled without a promoted deliverable since it was last reset (by a PASS or a human
// re-scope acknowledgment); `rescoped_by`/`rescoped_at` record that acknowledgment, mirroring
// `approved_by`/`approved_at`'s "written only by the server's own write paths" shape.
const RESCOPE_RECORD_FIELDS = ["rescoped_by", "rescoped_at"];
// T-0368: complexity_points is a human planning signal only (spec §2, §10 step 2) -- never
// read by any launch/admission/auto-launch/cost path (see
// test/complexityPointsLaunchIsolation.test.js). Nullable, restricted to the Fibonacci steps a
// human would actually use for relative sizing; there is no default/fallback value because
// "unscored" (null) is itself a meaningful, displayed state, unlike max_attempts' "no override".
const COMPLEXITY_POINTS_FIELD = "complexity_points";
const COMPLEXITY_POINTS_VALUES = [1, 2, 3, 5, 8, 13, 21];
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

export function validateTask(data) {
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
  if (MAX_ATTEMPTS_FIELD in data && data[MAX_ATTEMPTS_FIELD] !== null) {
    const value = data[MAX_ATTEMPTS_FIELD];
    if (!Number.isInteger(value) || value < MAX_ATTEMPTS_MIN || value > MAX_ATTEMPTS_MAX) {
      throw new Error(
        `Invalid max_attempts "${value}": expected an integer between ${MAX_ATTEMPTS_MIN} and ${MAX_ATTEMPTS_MAX}, or null to use the default`
      );
    }
  }
  if (
    APPROVAL_FLAG_FIELD in data &&
    data[APPROVAL_FLAG_FIELD] !== null &&
    typeof data[APPROVAL_FLAG_FIELD] !== "boolean"
  ) {
    throw new Error(
      `Invalid ${APPROVAL_FLAG_FIELD} "${data[APPROVAL_FLAG_FIELD]}": expected true or false`
    );
  }
  for (const field of APPROVAL_RECORD_FIELDS) {
    if (field in data && data[field] !== null && typeof data[field] !== "string") {
      throw new Error(`Invalid ${field} "${data[field]}": expected a string or null`);
    }
  }
  for (const field of RESCOPE_RECORD_FIELDS) {
    if (field in data && data[field] !== null && typeof data[field] !== "string") {
      throw new Error(`Invalid ${field} "${data[field]}": expected a string or null`);
    }
  }
  if (COMPLEXITY_POINTS_FIELD in data && data[COMPLEXITY_POINTS_FIELD] !== null) {
    const value = data[COMPLEXITY_POINTS_FIELD];
    if (!COMPLEXITY_POINTS_VALUES.includes(value)) {
      throw new Error(
        `Invalid complexity_points "${value}": expected one of ${COMPLEXITY_POINTS_VALUES.join(", ")}, or null for unscored`
      );
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

  // A missing or null agent means "no domain guessed" -- coerce it to the generic
  // catch-all implementer here (before validation) rather than requiring every card
  // to carry an explicit agent, or leaving it null forever.
  if (!("agent" in data) || data.agent === null) {
    data.agent = "generic";
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
    requires_approval: data.requires_approval === true,
    approved_by: data.approved_by ?? null,
    approved_at: data.approved_at ?? null,
    attempts: data.attempts ?? 0,
    max_attempts: data.max_attempts ?? null,
    round: data.round ?? 0,
    rescoped_by: data.rescoped_by ?? null,
    rescoped_at: data.rescoped_at ?? null,
    complexity_points: data[COMPLEXITY_POINTS_FIELD] ?? null,
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
    `${APPROVAL_FLAG_FIELD}: ${JSON.stringify(task[APPROVAL_FLAG_FIELD] === true)}`,
    ...APPROVAL_RECORD_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? null)}`),
    ...NUMERIC_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? 0)}`),
    `${MAX_ATTEMPTS_FIELD}: ${JSON.stringify(task[MAX_ATTEMPTS_FIELD] ?? null)}`,
    ...RESCOPE_RECORD_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? null)}`),
    `${COMPLEXITY_POINTS_FIELD}: ${JSON.stringify(task[COMPLEXITY_POINTS_FIELD] ?? null)}`,
    ...ARRAY_FIELDS.map((field) => `${field}: ${JSON.stringify(task[field] ?? [])}`)
  ];
  return `---\n${lines.join("\n")}\n---\n${task.body}`;
}
