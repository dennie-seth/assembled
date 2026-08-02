import { TASK_BODY_START, TASK_BODY_END, escapeTaskBody } from "./promptBuilder.js";
import { resolveVerifyRoutes } from "./verifyRouter.js";

const VERDICT_FOOTER = `## Verdict output format — REQUIRED

You are read-only on source: no Write or Edit of production code, and you never move this card yourself -- the orchestrator reads your verdict below and moves the card for you.

Follow the \`review\` skill's procedure (.claude/skills/review/SKILL.md): run \`verify\` for the paths this diff touches, load the applicable rules, and audit the diff against them. Then end your FINAL message with exactly one fenced block in this form, and nothing after it:

\`\`\`verdict
{"verdict": "PASS", "notes": "one paragraph: what you checked"}
\`\`\`

or

\`\`\`verdict
{"verdict": "FAIL", "notes": "specific, actionable reasons -- cite file and line, name the rule violated"}
\`\`\`

This fenced block is the only channel your verdict is recorded through. If it is missing or not valid JSON, the run is treated as a runner failure, not a FAIL verdict.`;

function buildRequiredVerificationSection(changedPaths) {
  const routes = resolveVerifyRoutes(changedPaths);
  if (routes.length === 0) {
    return null;
  }
  const lines = routes.map((route) => `- **${route.label}:** \`${route.command}\``);
  return `## Required verification for this diff\n\nRun exactly the following, in addition to (not instead of) the \`verify\` skill's own table for any other paths this diff touches:\n\n${lines.join("\n")}`;
}

/**
 * Builds the prompt handed to `claude -p` for the reviewer's VALIDATION run:
 * task identity, the reviewer's own agent definition, whichever rules match
 * the diff's actually-changed paths, an explicit routed-verification section
 * when the diff matches a code-enforced route (tasks/** -> backlog
 * validator, tools/board/** -> board suite -- see verifyRouter.js), the task
 * body verbatim, and the required machine-readable verdict format.
 */
export function buildReviewerPrompt({ task, agentDef, rules = [], changedPaths = [] }) {
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

  const requiredVerification = buildRequiredVerificationSection(changedPaths);
  if (requiredVerification) {
    sections.push(requiredVerification);
  }

  sections.push(
    `## Task card ${task.id}\n\n${TASK_BODY_START}\n${escapeTaskBody(task.body)}\n${TASK_BODY_END}`
  );

  sections.push(VERDICT_FOOTER);

  return sections.join("\n\n");
}
