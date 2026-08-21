import { TASK_BODY_START, TASK_BODY_END, escapeTaskBody } from "./promptBuilder.js";
import { resolveVerifyRoutes, resolveDeliverableRoute } from "./verifyRouter.js";
import { parseAcceptanceCriteria } from "../lib/acceptanceCriteria.js";

const VERDICT_FOOTER = `## Verdict output format — REQUIRED

You are read-only on source: no Write or Edit of production code, and you never move this card yourself -- the orchestrator reads your verdict below and moves the card for you.

**Never call AskUserQuestion. Never leave your verdict empty or unparseable.** This run is unattended -- no human is present to answer a question, so AskUserQuestion dead-ends the run: the orchestrator gets no verdict block, records that as a runner failure, and the card sits \`blocked\` with the actual check silently unrun rather than failed. If a required command is denied (a Bash permission you don't have), a tool you need isn't available, or you cannot complete a check for any environmental reason, that is a FAIL, not a question and not grounds to stop mid-run: end your message with the verdict block below, \`"verdict": "FAIL"\`, and name the exact command or tool that was denied or unavailable in \`notes\`. This generalizes the same fail-closed principle as an unrun python-verify or server-db-verify step above -- a check you could not run is never silently dropped, it is always reported as a failure.

Follow the \`review\` skill's procedure (.claude/skills/review/SKILL.md): run \`verify\` for the paths this diff touches, load the applicable rules, and audit the diff against them. Then end your FINAL message with exactly one fenced block in this form, and nothing after it:

\`\`\`verdict
{"verdict": "PASS", "notes": "one paragraph: what you checked"}
\`\`\`

or

\`\`\`verdict
{"verdict": "FAIL", "notes": "specific, actionable reasons -- cite file and line, name the rule violated"}
\`\`\`

This fenced block is the only channel your verdict is recorded through. If it is missing or not valid JSON, the run is treated as a runner failure, not a FAIL verdict.`;

function buildRequiredVerificationSection(changedPaths, baseBranch, task) {
  const routes = [...resolveVerifyRoutes(changedPaths, { baseBranch })];
  const deliverableRoute = resolveDeliverableRoute(task, changedPaths);
  if (deliverableRoute) {
    routes.push(deliverableRoute);
  }
  if (routes.length === 0) {
    return null;
  }
  const lines = routes.map((route) => `- **${route.label}:** \`${route.command}\``);
  const hasPythonRoute = routes.some((route) => route.id.startsWith("python-verify:"));
  const hasServerRoute = routes.some((route) => route.id === "server-db-verify");
  const hasDeliverableRoute = routes.some((route) => route.id === "deliverable-check");
  const hasGodotRoute = routes.some((route) => route.id.startsWith("client-godot-verify:"));

  let enforcement = `Actually execute every command above yourself with Bash -- do not read the diff and infer whether tests would pass. A check you did not run is a FAIL, not an unverified pass.`;
  if (hasPythonRoute) {
    enforcement += ` A python-verify step you did not run is a FAIL ("tests unverified, no venv" is not a passing verdict), not an unverified pass; report the real \`pytest\`/\`ruff\` output, including any failures, in your notes.`;
  }
  if (hasServerRoute) {
    enforcement += ` The server-db-verify route must actually bring up Postgres and run the DB-gated ctest cases against it, not skip them -- this is the exact T-0043 gap: those tests skipped locally with no DATABASE_URL, the reviewer passed the card anyway, and CI then found 10/22 failures against live Postgres. A DB-gated test that is skipped, or missing entirely from \`ctest -N\`'s registered list (which happens silently if DATABASE_URL wasn't set when the build last ran -- no "skipped" line, no nonzero exit), is a FAIL ("N DB-gated tests skipped: no DATABASE_URL/Postgres in reviewer env -- relying on CI is not a pass" is not a passing verdict). If you genuinely cannot bring up Postgres in this environment, that is also a FAIL, not grounds to pass on the strength of the rest of the suite going green.`;
  }
  if (hasGodotRoute) {
    enforcement += ` Run each client-godot-verify command exactly as given, with the \`timeout\` wrapper intact -- never drop it and run \`godot --headless\` bare. A test script that never calls \`get_tree().quit()\` hangs the process indefinitely otherwise (T-0185); if \`timeout\` kills the run, that is itself a FAIL ("test hung / exceeded the timeout") and must be reported as such, not treated as an unverified pass.`;
  }
  if (hasDeliverableRoute) {
    enforcement += ` This card requires a produced deliverable actually attached to the ticket -- either because its \`deliverable_type\` is "artifact", or because this diff adds/updates a file under a known artifact-producing path (\`assets/final/**\`, \`assets/src/concept/**\`, \`assets/src/keyart/**\`), which makes an attachment mandatory regardless of what \`deliverable_type\` says. A green test suite for an uploader/fetcher/generator script is not evidence the file exists; run the Deliverable artifact check and treat a nonzero exit as a FAIL, naming exactly which artifact is missing, in your notes. This is the T-0136 gap, generalized: an uploader CLI shipped with fully mocked tests, ruff+pytest green, and not a single image was ever actually fetched or attached -- and later, several art/audio cards (character/concept art sheets, an ambience bed) were committed straight to the repo tagged \`deliverable_type: "code"\` and never attached either, so the original deliverable_type-only gate never even fired for them.`;
  }
  return `## Required verification for this diff\n\nRun exactly the following, in addition to (not instead of) the \`verify\` skill's own table for any other paths this diff touches:\n\n${lines.join("\n")}\n\n${enforcement}`;
}

/**
 * Builds the "verify each acceptance criterion explicitly" section every
 * reviewer run gets, regardless of routed verification: the T-0136 lesson
 * that a green test suite (mocked or not) is evidence a check discipline
 * was followed, never evidence that any specific criterion in the card's
 * own `## Acceptance` section was actually met. Renders the criteria
 * `parseAcceptanceCriteria` extracts from the task body (see
 * acceptanceCriteria.js) as an explicit numbered checklist the reviewer
 * must walk through one by one; a card with no parseable Acceptance section
 * at all is itself a FAIL rather than a silently-skipped check, since an
 * un-auditable card can never be verified.
 */
function buildAcceptanceCriteriaSection(task) {
  const criteria = parseAcceptanceCriteria(task.body);
  const distrust =
    `Green tests and a clean lint/build are evidence the check discipline was followed -- they are not evidence any specific acceptance criterion below was met. **"Green tests" is not the same claim as "acceptance met."** A criterion can be unmet even when every required verification above passed.\n\n` +
    `Distrust a test that mocks away the very side effect a criterion requires -- e.g. a test that mocks \`urllib\`/\`requests\`/an HTTP client so no real network call, file write, or upload ever happens. A green suite built entirely on such mocks proves the code *could* satisfy the criterion under the right conditions, not that it *did*; find independent evidence the effect actually occurred, not just that the code path which would cause it has test coverage.`;

  if (criteria.length === 0) {
    return (
      `## Acceptance criteria -- verify each one explicitly\n\n` +
      `No parseable "## Acceptance" checklist was found in this card's body. A card without checkable acceptance criteria cannot be verified -- that is itself a FAIL: cite the missing/empty Acceptance section in your notes. Do not invent criteria to fill the gap, and do not pass the card on lint/tests alone.\n\n${distrust}`
    );
  }

  const lines = criteria.map((c, i) => `${i + 1}. ${c.text}`).join("\n");
  return (
    `## Acceptance criteria -- verify each one explicitly\n\n` +
    `This card's body lists ${criteria.length} acceptance ${criteria.length === 1 ? "criterion" : "criteria"} below. For EACH one, state explicitly whether it is met and cite concrete evidence -- a command you ran, a file you inspected, output you saw -- not "should work" or "the code looks correct." Any one criterion you cannot confirm, or confirm is false, is a FAIL for the whole card; do not average partial credit across criteria.\n\n${distrust}\n\n${lines}`
  );
}

/**
 * Builds the prompt handed to `claude -p` for the reviewer's VALIDATION run:
 * task identity, the reviewer's own agent definition, whichever rules match
 * the diff's actually-changed paths, an explicit routed-verification section
 * when the diff matches a code-enforced route (tasks/** -> backlog
 * validator + planner diff guard, tools/board/** -> board suite, a Python
 * package root -> a per-package python-verify step (venv + pip install +
 * pytest + ruff), server/** or shared/** -> server-db-verify (live-Postgres
 * ctest run, fail-closed if the DB-gated tests skip or never register --
 * see verifyRouter.js), a task-driven (not diff-driven) deliverable-check
 * route when the card's own `deliverable_type` is "artifact" (see
 * resolveDeliverableRoute), an explicit acceptance-criteria audit section
 * (buildAcceptanceCriteriaSection -- every criterion in the card's own
 * `## Acceptance` list must be individually confirmed with evidence, green
 * tests are not sufficient, and a card with no parseable Acceptance section
 * is itself a FAIL), the task body verbatim, and the required
 * machine-readable verdict format. The routed section also spells out that
 * these commands must actually be run, not inferred from reading the diff
 * -- an unrun check is a FAIL, not an "unverified" pass. This closes the
 * T-0136 gap: an uploader CLI shipped with fully mocked tests, ruff+pytest
 * green, and the card's own acceptance checkbox never got checked because
 * nothing in VALIDATION at the time evaluated acceptance criteria or
 * artifact existence directly, only whether the surrounding code compiled
 * and had (mocked) coverage. The verdict footer additionally forbids
 * AskUserQuestion outright (this run is unattended -- a question dead-ends
 * it with no verdict, and the card ends up silently `blocked` instead of
 * correctly `FAIL`ed) and requires that a denied command or unavailable
 * tool be reported as an explicit FAIL naming what was denied, never an
 * empty or missing verdict.
 */
export function buildReviewerPrompt({ task, agentDef, rules = [], changedPaths = [], baseBranch = "develop" }) {
  if (!task || typeof task.body !== "string") {
    throw new Error("buildReviewerPrompt requires a task with a body");
  }

  const sections = [];
  sections.push(`# Agent Runner Validation ${task.id}: ${task.title}`);
  sections.push(
    `You are the "reviewer" agent for the assembled project, running the VALIDATION gate for a card an implementer agent just finished.`
  );

  if (agentDef) {
    sections.push(`## Your agent definition (${agentDef.name})\n\n${agentDef.body.trim()}`);
  }

  for (const rule of rules) {
    sections.push(`## Rule: ${rule.name}\n\n${rule.body.trim()}`);
  }

  const requiredVerification = buildRequiredVerificationSection(changedPaths, baseBranch, task);
  if (requiredVerification) {
    sections.push(requiredVerification);
  }

  sections.push(buildAcceptanceCriteriaSection(task));

  sections.push(
    `## Task card ${task.id}\n\n${TASK_BODY_START}\n${escapeTaskBody(task.body)}\n${TASK_BODY_END}`
  );

  sections.push(VERDICT_FOOTER);

  return sections.join("\n\n");
}
