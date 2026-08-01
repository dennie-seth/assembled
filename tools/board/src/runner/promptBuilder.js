const WORKFLOW_SECTION = `## Workflow — follow in order, do not skip or reorder

1. Think through the design — restate this task's acceptance criteria, identify the interfaces/modules touched, and check shared/ for anything that must stay the single source of truth.
2. Write the failing test cases first — commit the test file before any implementation. Red before green; a test that passes before the implementation exists proves nothing.
3. Implement to green — the smallest change that satisfies the tests. Do not add functionality the tests don't require.
4. Self-verify — run the verify skill for your subsystem (tests + lint + build) before handing off.
5. Hand to the reviewer — move the card in-progress -> VALIDATION using the open-review-pr skill. You do not grade your own work.`;

const FOOTER_SECTION = `## Non-negotiable

You never move this card to \`review\` or \`done\` yourself outside the open-review-pr skill, and you never merge a PR. \`review\` is the terminal state you can reach — a human is the only actor that advances \`review\` -> \`done\`.`;

const TASK_BODY_START = "<<<TASK_BODY:BEGIN>>>";
const TASK_BODY_END = "<<<TASK_BODY:END>>>";

// agent -> path scope, mirrors the Agents table in docs/design/agent-runner.md
export const AGENT_PATH_SCOPES = {
  infra: ["tools/**", ".github/**", ".claude/**", "docs/**"],
  server: ["server/**", "shared/**"],
  client: ["client/**", "shared/**"],
  assets: ["assets/**"],
  audio: ["assets/src/**", "assets/final/audio/**"]
};

function globPrefix(pattern) {
  const idx = pattern.indexOf("*");
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

function scopesOverlap(a, b) {
  if (a === "**" || b === "**") {
    return true;
  }
  const prefixA = globPrefix(a);
  const prefixB = globPrefix(b);
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

/** Rules whose `paths` glob overlaps the task's assigned agent's path scope. */
export function resolveRulesForTask(task, rules = []) {
  const scopes = AGENT_PATH_SCOPES[task.agent] ?? [];
  return rules.filter((rule) => {
    const rulePaths = Array.isArray(rule.paths) ? rule.paths : [];
    return rulePaths.some((rp) => rp === "**" || scopes.some((sp) => scopesOverlap(rp, sp)));
  });
}

function escapeTaskBody(body) {
  return body.split(TASK_BODY_START).join("<<<TASK_BODY:BEGIN​>>>").split(TASK_BODY_END).join(
    "<<<TASK_BODY:END​>>>"
  );
}

/**
 * Builds the prompt handed to `claude -p` for an implementer run: task
 * identity, the fixed implementer workflow ordering, the assigned agent's
 * own definition, whichever rules match the agent's path scope, and the
 * task body verbatim inside a delimited, injection-safe block.
 */
export function buildPrompt({ task, agentDef, rules = [] }) {
  if (!task || typeof task.body !== "string") {
    throw new Error("buildPrompt requires a task with a body");
  }

  const sections = [];
  sections.push(`# Agent Runner Task ${task.id}: ${task.title}`);
  sections.push(
    `You are the "${task.agent ?? "unassigned"}" agent for the assembled project. Priority: ${task.priority}. Phase: ${task.phase}.`
  );
  sections.push(WORKFLOW_SECTION);

  if (agentDef) {
    sections.push(`## Your agent definition (${agentDef.name})\n\n${agentDef.body.trim()}`);
  }

  for (const rule of resolveRulesForTask(task, rules)) {
    sections.push(`## Rule: ${rule.name}\n\n${rule.body.trim()}`);
  }

  sections.push(
    `## Task card ${task.id}\n\n${TASK_BODY_START}\n${escapeTaskBody(task.body)}\n${TASK_BODY_END}`
  );

  sections.push(FOOTER_SECTION);

  return sections.join("\n\n");
}
