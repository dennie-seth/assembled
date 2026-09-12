const WORKFLOW_SECTION = `## Workflow — follow in order, do not skip or reorder

1. Think through the design — restate this task's acceptance criteria, identify the interfaces/modules touched, and check shared/ for anything that must stay the single source of truth.
2. Write the failing test cases first — commit the test file before any implementation. Red before green; a test that passes before the implementation exists proves nothing.
3. Implement to green — the smallest change that satisfies the tests. Do not add functionality the tests don't require.
4. **Commit the implementation now, before you self-verify.** \`git add -A && git commit\` the GREEN state as its own commit, right after it's written — do not wait until after self-verification to do this. Self-verification (next step) can eat many turns chasing an unrelated tool/permission/environment issue; if that happens with the implementation still uncommitted, the real, working code you wrote is at risk of being lost, and the reviewer will FAIL the card on "implementation not committed" even though the work is done. Commit first, then verify.
5. Self-verify — run the verify skill for your subsystem (tests + lint + build). If self-verify surfaces a fix, make it and commit that too (a second, small commit on top is fine — do not amend away the record of what changed).
6. **Before you stop: run \`git status --porcelain\` and confirm it is empty.** If anything is uncommitted or untracked, commit it now — this is not optional and it is your last chance to do it. An implementer run that ends with uncommitted changes has not finished the task, regardless of how much of the acceptance criteria the code satisfies: the reviewer only ever sees committed history, and uncommitted work is invisible to it and effectively unreviewed.
7. Hand to the reviewer — stop once \`git status --porcelain\` is empty. Do NOT push, do NOT open a PR, and do NOT invoke the open-review-pr skill yourself: an Agent Runner orchestrator is driving this session, and it owns the handoff to the reviewer's VALIDATION pass. It only pushes the branch itself once that verdict is PASS -- never before. You do not grade your own work.`;

const CONTINUE_WORKFLOW_SECTION = `## Workflow — continuing existing work (do not skip or reorder)

This card already has a branch with prior work committed to it. You are resuming and fixing, not starting over -- do not discard or rewrite the existing implementation from scratch.

1. Inspect what's already on the branch -- read the diff against the base branch and the existing tests to understand the current state before changing anything.
2. Read the "## Prior validation history (digest)" section below if present (a summary of prior verdicts -- the full text of each is archived, not repeated here), and the "## Human comments on this card" section if present -- they describe what's still wrong or what changed.
3. Fix the specific issues raised. Add or adjust failing tests first for any new behavior the fix requires, then implement to green.
4. **Commit the fix now, before you self-verify.** \`git add -A && git commit\` right after the fix is written — do not wait until after self-verification to do this. Self-verification (next step) can eat many turns chasing an unrelated tool/permission/environment issue; if that happens with the fix still uncommitted, the real, working code you wrote is at risk of being lost, and the reviewer will FAIL the card on "implementation not committed" even though the work is done. Commit first, then verify.
5. Self-verify — run the verify skill for your subsystem (tests + lint + build). If self-verify surfaces a further fix, make it and commit that too.
6. **Before you stop: run \`git status --porcelain\` and confirm it is empty.** If anything is uncommitted or untracked, commit it now — this is not optional and it is your last chance to do it. An implementer run that ends with uncommitted changes has not finished the task, regardless of how much of the acceptance criteria the code satisfies: the reviewer only ever sees committed history, and uncommitted work is invisible to it and effectively unreviewed.
7. Hand to the reviewer — stop once \`git status --porcelain\` is empty. Do NOT push, do NOT open a PR, and do NOT invoke the open-review-pr skill yourself: an Agent Runner orchestrator is driving this session, and it owns the handoff to the reviewer's VALIDATION pass. It only pushes the branch itself once that verdict is PASS -- never before. You do not grade your own work.`;

const FOOTER_SECTION = `## Non-negotiable

You never push, never open a PR, and never move this card to \`review\` or \`done\` yourself — the orchestrator pushes and advances the card only after the reviewer's VALIDATION passes, never before. \`review\` is the terminal state automation can reach — a human is the only actor that advances \`review\` -> \`done\`.

**Uncommitted work at the end of your run is a lost-work bug, not a minor omission.** \`git status --porcelain\` must be empty before you stop. The orchestrator runs a safety net that will capture and commit anything you leave uncommitted before the reviewer sees it, but that net exists to catch accidents, not to be relied on as your actual commit step -- always commit your own work yourself.

## If you hit a host-only blocker

You run in a WSL worktree with no shell on the host where ComfyUI, the GPU, and the training stack live (see docs/design/host-action-escalation.md). If you trace a failure to something only fixable there — a launcher flag, an env var, a service restart, a config file only a human can touch — do not just describe it in prose and stop: name it in a fenced block, verbatim, with all four fields:

\`\`\`host-action-request
host: <which host, e.g. "Windows ComfyUI host (F:\\ComfyUI)">
action: <the specific host-side action needed, concretely>
reason: <why no tool grant here can perform it>
verify: <how to confirm the action fixed it>
\`\`\`

Write this block into your notes, commit message, or a card comment the moment you hit the wall, so the diagnosis survives in a form the reviewer can carry forward into its FAIL verdict \`notes\` — that is the only text the escalation pipeline (\`categorizeFailure\` in tools/board/src/runner/blockerReport.js) reads, and a diagnosis that never reaches it in this form falls through to a generic "code/test bug" no matter how correct it was (see T-0272/T-0317, where a correct host-only diagnosis sat as prose for four escalation rounds before a human applied a two-minute fix). Do not use this for something you simply haven't tried yet, or a problem a tool grant here could still fix — it is specifically for a wall on the *host*, outside this sandbox.`;

export const TASK_BODY_START = "<<<TASK_BODY:BEGIN>>>";
export const TASK_BODY_END = "<<<TASK_BODY:END>>>";

// agent -> path scope, mirrors the Agents table in docs/design/agent-runner.md
export const AGENT_PATH_SCOPES = {
  infra: ["tools/**", ".github/**", ".claude/**", "docs/**"],
  server: ["server/**", "shared/**"],
  client: ["client/**", "shared/**"],
  assets: ["assets/**"],
  audio: ["assets/src/**", "assets/final/audio/**"],
  planner: ["tasks/**", "docs/**"]
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

/** Converts a rule's glob pattern ("tools/**", "server/**") into a RegExp matching literal file paths. */
function globToRegExp(pattern) {
  const PLACEHOLDER = " DOUBLESTAR ";
  const escaped = pattern
    .split("**")
    .join(PLACEHOLDER)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .split("*")
    .join("[^/]*")
    .split(PLACEHOLDER)
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesPattern(pattern, filePath) {
  return globToRegExp(pattern).test(filePath);
}

/** Rules whose `paths` glob matches at least one of a diff's actually-changed file paths (reviewer). */
export function resolveRulesForPaths(paths, rules = []) {
  return rules.filter((rule) => {
    const rulePaths = Array.isArray(rule.paths) ? rule.paths : [];
    return rulePaths.some((rp) => paths.some((p) => matchesPattern(rp, p)) || rp === "**");
  });
}

export function escapeTaskBody(body) {
  return body.split(TASK_BODY_START).join("<<<TASK_BODY:BEGIN​>>>").split(TASK_BODY_END).join(
    "<<<TASK_BODY:END​>>>"
  );
}

const PLANNER_EXPANSION_WORKFLOW = `## Workflow — card expansion (do not skip or reorder)

This card has no assigned agent. Your task is to expand it into an implementable spec:

1. Read the task card body below carefully.
2. Identify which subsystem(s) the work touches (infra/server/client/assets/audio) and which agent should implement it.
3. Decide what the card's actual deliverable is: working code, or a produced artifact (an asset, a doc, a fetched/generated file that gets attached to the ticket) that code merely has to create. If the deliverable is an artifact, set \`deliverable_type: artifact\` in the card's frontmatter (it defaults to \`code\` -- leave it unset/\`code\` when the deliverable genuinely is the code). This distinction is load-bearing: an "artifact" card's Acceptance criteria (next step) must be written so the criterion is only satisfiable by the artifact actually existing, never by code that merely could produce it.
4. Rewrite or extend the card's ## Acceptance section with concrete, independently-checkable criteria -- each one must be verifiable by inspection or a command, not a restatement of the title ("it works" is not a criterion). For an artifact-deliverable card, state the artifact itself and where it must end up (e.g. "T-0072's Attachments section shows the fetched corpus images"), not the mechanism that could produce it (e.g. not "an uploader script exists and its tests pass" -- that describes capability, not delivery; see T-0136, where exactly that gap let a card pass VALIDATION with zero images ever actually fetched). Within ## Acceptance, always add an explicit **Edge cases:** block -- a bold label line, never a \`###\` (or any \`#\`) heading, because the reviewer's acceptance-criteria parser stops at the first heading of any level and a markdown subheading here would silently drop everything under it from VALIDATION -- followed by its own \`- [ ]\` checklist items, each naming one specific edge case, boundary condition, or failure mode this card's own logic actually has to handle. Derive them from the card, not from a generic boilerplate list: boundary/limit values (empty, zero, one, max, one-past-max), missing/null/malformed input, an error or failure path (a dependency unavailable, a write that fails partway, a network call that times out), concurrent or duplicate operations wherever the card touches shared state, and invalid input wherever the card parses or accepts one. Skip a category that genuinely does not apply to this card with a one-clause note rather than inventing a checklist item that means nothing for it.
5. Self-check ## Acceptance for completeness against the story before moving on. Enumerate every distinct requirement the card's story states or clearly implies, and confirm each one maps to at least one criterion you just wrote. Add a criterion for anything the story asks for that isn't covered yet -- or, if it's genuinely out of scope rather than an omission, say so explicitly in ## Context -- but do not invent requirements the story never asked for; gold-plating the spec is as much a defect as leaving it incomplete. When the story names multiple cases, directions, or states (e.g. "scroll right and left", "create and delete", "mobile and desktop"), each one needs its own criterion or explicit coverage -- never collapsed into a single bullet that quietly covers only one side of it. Prefer criteria that assert observable behavior over a static property: this is the T-0141 lesson -- the story asked for the side-panel overlay to "scroll right and left to see [cards] properly," but the Acceptance section that shipped only had "\`.board\` has \`overflow-x: auto\`", a CSS-property check that passes trivially and proves nothing about whether every column is actually reachable in both directions once the panel is open; the implementer and reviewer both faithfully satisfied that criterion while the bidirectional-scroll requirement itself shipped broken. A behavioral criterion would instead read "with the panel open, every column remains reachable by scrolling both left and right, regardless of column count." Then verify the **Edge cases:** block you wrote in step 4 the same way: confirm it is present, that every item names a concrete, card-specific condition rather than a placeholder like "edge cases are handled" or "errors are handled gracefully", and that each one is phrased so the reviewer can check it against the actual implementation with the same discipline as any other Acceptance item. Remove an edge case that doesn't genuinely apply to this card rather than leaving an unverifiable checklist item; if the card touches shared state, external I/O, or parsed/user-supplied input and no edge case covers that risk, add one now. Finish with one explicit check: if every criterion above were met -- including every edge case -- would the story's stated problem be completely solved, including how it behaves at its boundaries and when something goes wrong? If not, fix the gap before moving on.
6. Add a ## Touched files section listing the expected files to create or modify.
7. Set a \`complexity_points\` value in the card's frontmatter using this Fibonacci rubric -- one line per step -- or leave it unset (\`null\`) if you're genuinely unsure rather than guessing: \`1\` -- a one-line or single-value change (a constant, a copy tweak), no new test surface. \`2\` -- a small, single-file change with a couple of targeted tests. \`3\` -- a contained feature confined to one subsystem, a handful of files. \`5\` -- a feature spanning multiple files or layers within one subsystem (e.g. store + API + UI). \`8\` -- a feature spanning multiple subsystems, or one subsystem plus a schema migration. \`13\` -- a large feature with real design decisions, multiple subsystems, and edge-case-heavy testing. \`21\` -- epic-sized; split it into smaller cards before anyone picks it up rather than leaving it at this size. \`complexity_points\` is a human planning signal only (spec §2/§10) -- never treat it as, or write Acceptance criteria implying it is, an input to launch, admission, auto-launch, or cost decisions; it is never read by any of those paths.
8. Set the appropriate agent in the card's frontmatter (infra, server, client, assets, or audio). If the work does not fit any specific subsystem, set agent to \`generic\` instead.
9. Validate the card still parses: run \`node tools/board/scripts/validateBacklog.js\` if you have Bash access.
10. Commit your changes with a one-line summary of what you expanded, then stop.

**Do not implement the work itself.** Your output is an expanded spec, not working code or docs.`;

/**
 * Builds the prompt handed to `claude -p` for the planner expansion phase
 * of an unassigned card: explains the card-expansion task (not TDD
 * implementation), includes the planner agent def, and injects the task body.
 */
export function buildPlannerPrompt({ task, agentDef, rules = [], comments = [] }) {
  if (!task || typeof task.body !== "string") {
    throw new Error("buildPlannerPrompt requires a task with a body");
  }

  const sections = [];
  sections.push(`# Agent Runner Planning Phase ${task.id}: ${task.title}`);
  sections.push(
    `You are the "planner" agent for the assembled project. This card has no assigned agent. Expand its spec so a generic implementer can act on it. Priority: ${task.priority}. Phase: ${task.phase}.`
  );
  sections.push(PLANNER_EXPANSION_WORKFLOW);

  if (agentDef) {
    sections.push(`## Your agent definition (${agentDef.name})\n\n${agentDef.body.trim()}`);
  }

  for (const rule of resolveRulesForTask({ ...task, agent: "planner" }, rules)) {
    sections.push(`## Rule: ${rule.name}\n\n${rule.body.trim()}`);
  }

  sections.push(
    `## Task card ${task.id}\n\n${TASK_BODY_START}\n${escapeTaskBody(task.body)}\n${TASK_BODY_END}`
  );

  if (comments.length > 0) {
    sections.push(`## Human comments on this card\n\n${formatComments(comments)}`);
  }

  sections.push(FOOTER_SECTION);

  return sections.join("\n\n");
}

/** Workflow for a re-invoked implementer resolving merge conflicts against the base branch (see `buildMergeConflictPrompt`). */
function mergeConflictWorkflow(baseBranch) {
  return `## Workflow — resolve merge conflicts against origin/${baseBranch} (do not skip or reorder)

Your branch already passed VALIDATION and has a PR open against \`${baseBranch}\`. The orchestrator just merged \`origin/${baseBranch}\` into this branch to keep it from going stale, and that merge hit real conflicts -- listed below with their conflict markers. You are resolving them, not re-implementing the feature from scratch.

1. Read every conflicted file's conflict markers (\`<<<<<<<\` / \`=======\` / \`>>>>>>>\`) below, then open the file in the worktree to see it in full context.
2. Resolve each conflict thoroughly: understand what both sides changed and why, and preserve the intended behavior from each -- never blindly take-ours or take-theirs, and never delete a hunk just to make the conflict marker disappear. If the two sides made genuinely incompatible changes to the same behavior, reconcile them into one correct implementation rather than picking a side arbitrarily.
3. Remove every conflict marker, then \`git add\` each resolved file.
4. Re-run this subsystem's verify skill (tests + lint + build) against the merged state -- a conflict resolution that doesn't compile or breaks tests is not resolved.
5. \`git commit\` to conclude the merge (a plain \`git commit\` with the merge already staged uses git's default merge commit message -- that's fine, no need to write your own).
6. **Before you stop: run \`git status --porcelain\` and confirm it is empty**, and confirm \`git diff --name-only --diff-filter=U\` reports nothing. If either is not clean, the merge is not resolved -- do not stop with anything left uncommitted or unmerged.
7. Do NOT push and do NOT open or touch the PR yourself -- the orchestrator pushes once it confirms the merge is fully resolved.`;
}

/**
 * Builds the prompt handed to `claude -p` when the orchestrator's post-PR "merge develop into
 * the branch" step (see runOrchestrator.js's `_syncBranchWithDevelop`) hits real conflicts. Reuses
 * the same owning agent that implemented the card (`task.agent`/`effectiveAgent` and its
 * `agentDef`) rather than a generic conflict-resolution persona, since it already has the full
 * context of what the card's own changes were meant to do. `conflictedFiles`/`hunks` come straight
 * from `gitOps.mergeDevelop`'s conflict return shape -- the on-disk conflict-marked content, the
 * same text a human would see resolving it by hand.
 */
export function buildMergeConflictPrompt({ task, agentDef, baseBranch = "develop", branch, conflictedFiles = [], hunks = {} }) {
  if (!task) {
    throw new Error("buildMergeConflictPrompt requires a task");
  }

  const sections = [];
  sections.push(`# Agent Runner Merge-Conflict Resolution ${task.id}: ${task.title}`);
  sections.push(
    `You are the "${task.agent ?? "unassigned"}" agent for the assembled project, re-invoked to resolve merge conflicts on \`${branch}\` against \`origin/${baseBranch}\`.`
  );
  sections.push(mergeConflictWorkflow(baseBranch));

  if (agentDef) {
    sections.push(`## Your agent definition (${agentDef.name})\n\n${agentDef.body.trim()}`);
  }

  sections.push(`## Conflicted files\n\n${conflictedFiles.map((f) => `- ${f}`).join("\n")}`);

  for (const file of conflictedFiles) {
    const hunk = hunks[file];
    if (hunk) {
      sections.push(`## Conflict markers: ${file}\n\n\`\`\`\n${hunk}\n\`\`\``);
    }
  }

  return sections.join("\n\n");
}

/** Renders a card's human comments (Feature A) as a dated list for prompt injection. */
function formatComments(comments) {
  return comments.map((c) => `- [${c.timestamp}] ${c.author}: ${c.text}`).join("\n");
}

/**
 * Builds the prompt handed to `claude -p` for an implementer run: task
 * identity, the fixed implementer workflow ordering, the assigned agent's
 * own definition, whichever rules match the agent's path scope, and the
 * task body verbatim inside a delimited, injection-safe block.
 *
 * `continuing: true` (a re-run that reused an existing branch -- see
 * gitOps.addWorktree's `reused` flag) swaps in a "fix what's there" workflow
 * instead of the fresh-implementation one, and `comments` (human feedback
 * added via the board, e.g. "CI failed on X, please fix") are injected as
 * their own section so the implementer knows exactly what to address.
 * `verdictDigest` (T-0345, see ../lib/verdictArchive.js's buildVerdictDigest)
 * is a short summary of this card's prior VALIDATION rounds -- the full text
 * of each is archived on disk, not carried in the body, so it doesn't grow
 * the prompt (and eventually the argv/stdin payload, see claudeCliRunner.js's
 * E2BIG history) on every retry. Omitted entirely when empty.
 */
export function buildPrompt({ task, agentDef, rules = [], continuing = false, comments = [], verdictDigest = "" }) {
  if (!task || typeof task.body !== "string") {
    throw new Error("buildPrompt requires a task with a body");
  }

  const sections = [];
  sections.push(`# Agent Runner Task ${task.id}: ${task.title}`);
  sections.push(
    `You are the "${task.agent ?? "unassigned"}" agent for the assembled project. Priority: ${task.priority}. Phase: ${task.phase}.`
  );
  sections.push(continuing ? CONTINUE_WORKFLOW_SECTION : WORKFLOW_SECTION);

  if (agentDef) {
    sections.push(`## Your agent definition (${agentDef.name})\n\n${agentDef.body.trim()}`);
  }

  for (const rule of resolveRulesForTask(task, rules)) {
    sections.push(`## Rule: ${rule.name}\n\n${rule.body.trim()}`);
  }

  sections.push(
    `## Task card ${task.id}\n\n${TASK_BODY_START}\n${escapeTaskBody(task.body)}\n${TASK_BODY_END}`
  );

  if (verdictDigest) {
    sections.push(`## Prior validation history (digest)\n\n${verdictDigest}`);
  }

  if (comments.length > 0) {
    sections.push(`## Human comments on this card\n\n${formatComments(comments)}`);
  }

  sections.push(FOOTER_SECTION);

  return sections.join("\n\n");
}
