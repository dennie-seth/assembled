import fs from "node:fs";
import { parseAcceptanceCriteria } from "../lib/acceptanceCriteria.js";
import { resolveAllowedTools } from "./toolAllowlist.js";
import { INSTALLED_MODELS, INSTALLED_COMFYUI_NODES, REACHABLE_SERVICE_ENDPOINTS } from "./capabilityInventory.js";

const CODE_SPAN_RE = /`([^`]+)`/g;
const MODEL_FILE_RE = /[A-Za-z0-9][\w.-]*\.(?:safetensors|ckpt|pt|onnx)\b/g;
const URL_RE = /https?:\/\/([^\s`'")]+)/g;

// A ComfyUI custom-node class name in this repo's cards is always genuine PascalCase with at
// least two humps ("SolidMask", "ImageQuantize") -- a single-hump word or an all-caps acronym
// (`Godot`, `PASS`, `TDD`) never is, so requiring two humps keeps this from firing on those.
const COMFY_NODE_TOKEN_RE = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;

// "node" alone is far too common a word in this repo (Godot's own Node class, Node.js) to use as
// the trigger for a ComfyUI-custom-node claim -- see the T-0063 fixture in capabilityPreflight.test.js.
const COMFY_CONTEXT_RE = /\bcomfyui\b|\bcustom\s+node\b/i;

// Only an AC item phrased as an instruction to actually invoke something ("Run `x`" / the
// existing repo-wide "Test: ..." convention, see T-0043) is treated as a claim the assigned
// agent itself must be able to execute. A bare mention of a CLI tool's name is common in cards
// that *describe* what a CI workflow or generated config runs, not what the agent runs directly
// (T-0031's ci-board.yml card, T-0138's `npx eslint .` mention) -- checking those against the
// agent's own grants produced false positives during this file's development.
const RUN_CUE_RE = /^(?:run|running|test)\b[:\s]/i;

const SEED_COMMAND_VERBS = ["curl", "gh", "rm", "sudo", "pytest", "pip"];

// No agent's `.claude/agents/*.md` ever grants these, by design (`.claude/rules/conduct.md`):
// only the orchestrator pushes, opens a PR, or merges once a PASS verdict lands, and only a
// human moves a card done/review -> done. T-0222's AC literally required "commit + open a PR",
// unsatisfiable by construction for any implementer agent -- this is that failure mode, generalized.
const FORBIDDEN_ACTIONS = [
  { re: /\bopen(?:s|ed|ing)?\s+(?:a\s+|an\s+)?(?:github\s+)?pull\s*request\b/i, label: "open a pull request" },
  { re: /\bopen(?:s|ed|ing)?\s+(?:a\s+|an\s+)?pr\b/i, label: "open a PR" },
  { re: /\bpush(?:es|ed|ing)?\s+(?:the\s+|this\s+)?(?:feature\s+)?branch\b/i, label: "push the branch" },
  { re: /\bmerge(?:s|d|ing)?\s+(?:the\s+|this\s+)?(?:pr|pull\s*request)\b/i, label: "merge the PR" },
  { re: /\bmove(?:s|d)?\s+(?:the\s+)?card\s+to\s+`?(?:done|review)`?\b/i, label: "move the card to done/review" }
];

function defaultListAgentNames(agentsDir) {
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

function extractBashPrefixes(allowedTools) {
  const prefixes = [];
  for (const t of allowedTools) {
    const m = /^Bash\((.+)\)$/.exec(t);
    if (!m) continue;
    let p = m[1];
    if (p.endsWith(":*")) p = p.slice(0, -2);
    else if (p.endsWith("*")) p = p.slice(0, -1);
    if (p.length > 0) prefixes.push(p);
  }
  return prefixes;
}

/**
 * Whether `commandText` (a raw command string pulled from AC prose, e.g. "pytest -v tools/board")
 * is covered by one of `allowedTools`'s Bash(...) grant prefixes. This mirrors the *intent* of
 * toolAllowlist.js's isToolAllowed but not its exact wire format: isToolAllowed compares against
 * the "Bash(prefix:rest)" shape the real Claude Code CLI emits per-tool-call, which a freeform AC
 * sentence never naturally produces. Word-boundary prefix matching is the right fidelity for
 * "does some grant plausibly cover this claim" -- it is a preflight heuristic, not a live
 * permission check, and never needs to be one.
 */
function isCommandGranted(commandText, allowedTools) {
  return extractBashPrefixes(allowedTools).some((prefix) => {
    if (commandText === prefix) return true;
    if (!commandText.startsWith(prefix)) return false;
    const boundaryChar = commandText[prefix.length];
    const prefixEndsAtWordChar = /\w/.test(prefix[prefix.length - 1]);
    return boundaryChar === undefined || boundaryChar === " " || !prefixEndsAtWordChar;
  });
}

/** Union of every agent's granted Bash command first-words, plus a small seed set of commands no agent ever grants (curl, gh, rm, sudo, pytest, pip) -- what makes a backtick span "command-shaped" enough to check. */
function knownCommandVerbs({ agentsDir, readFileFn, resolveAllowedToolsFn, listAgentNamesFn }) {
  const verbs = new Set(SEED_COMMAND_VERBS);
  let names = [];
  try {
    names = listAgentNamesFn(agentsDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const tools = resolveAllowedToolsFn(name, { agentsDir, readFileFn });
    for (const prefix of extractBashPrefixes(tools)) {
      const firstWord = prefix.trim().split(/\s+/)[0];
      if (firstWord) verbs.add(firstWord);
    }
  }
  return verbs;
}

/**
 * Pre-flight (HANDOFF §23-b): checks a card's `## Acceptance` claims against (a) the assigned
 * agent's tool grants in `.claude/agents/<agent>.md`, and (b) external capabilities/resources the
 * AC names (an installed ComfyUI checkpoint/LoRA/custom node, a reachable service endpoint) --
 * before the implementer child process is spawned. Returns {ok, message}, the same contract as
 * acceptancePreflight.js's checkAcceptancePreflight, so runOrchestrator.js can treat a failure of
 * either check identically (both route to `_blocked`, the same fail-fast/escalate path a genuine
 * blocker takes).
 *
 * Deliberately conservative: every extractor here was tuned against all 121 of this repo's
 * `done` cards until it produced zero false positives (a card whose AC is fully satisfiable must
 * never trip this) -- see the RUN_CUE_RE gate on command claims and the COMFY_CONTEXT_RE gate on
 * custom-node claims above for the two false positives that shaped that tuning.
 */
export function checkCapabilityPreflight(
  task,
  agentName,
  {
    agentsDir = ".claude/agents",
    readFileFn = fs.readFileSync,
    resolveAllowedToolsFn = resolveAllowedTools,
    listAgentNamesFn = defaultListAgentNames,
    inventory = {
      models: INSTALLED_MODELS,
      nodes: INSTALLED_COMFYUI_NODES,
      endpoints: REACHABLE_SERVICE_ENDPOINTS
    }
  } = {}
) {
  const id = task?.id ?? "unknown";
  const items = parseAcceptanceCriteria(task?.body ?? "");
  if (items.length === 0) {
    // A missing/unparseable Acceptance section is acceptancePreflight.js's job, not this one's.
    return { ok: true, message: "" };
  }

  const allowedTools = resolveAllowedToolsFn(agentName, { agentsDir, readFileFn });
  const verbs = knownCommandVerbs({ agentsDir, readFileFn, resolveAllowedToolsFn, listAgentNamesFn });

  const failures = [];
  const seen = new Set();
  const addFailure = (msg) => {
    if (seen.has(msg)) return;
    seen.add(msg);
    failures.push(msg);
  };

  for (const { text } of items) {
    for (const { re, label } of FORBIDDEN_ACTIONS) {
      if (re.test(text)) {
        addFailure(
          `AC item "${text}" requires "${label}" -- no implementer agent may ever do this ` +
            `(orchestrator/human-only, per .claude/rules/conduct.md); rewrite it to stop at an ` +
            `implementer-reachable action such as "commit".`
        );
      }
    }

    let match;
    MODEL_FILE_RE.lastIndex = 0;
    while ((match = MODEL_FILE_RE.exec(text))) {
      const name = match[0];
      if (!inventory.models.includes(name)) {
        addFailure(
          `AC item "${text}" names checkpoint/LoRA "${name}", which is not in the installed ` +
            `capability inventory (checked tools/board/src/runner/capabilityInventory.js's INSTALLED_MODELS).`
        );
      }
    }

    const hasRunCue = RUN_CUE_RE.test(text.trim());
    const hasComfyContext = COMFY_CONTEXT_RE.test(text);

    CODE_SPAN_RE.lastIndex = 0;
    while ((match = CODE_SPAN_RE.exec(text))) {
      const raw = match[1].trim();
      if (raw.length === 0) continue;

      if (hasComfyContext && COMFY_NODE_TOKEN_RE.test(raw)) {
        if (!inventory.nodes.includes(raw)) {
          addFailure(
            `AC item "${text}" names ComfyUI custom node "${raw}", which is not in the installed ` +
              `capability inventory (checked tools/board/src/runner/capabilityInventory.js's INSTALLED_COMFYUI_NODES).`
          );
        }
        continue;
      }

      if (!hasRunCue) continue;
      const firstToken = raw.split(/\s+/)[0];
      if (verbs.has(firstToken) && !isCommandGranted(raw, allowedTools)) {
        addFailure(
          `AC item "${text}" requires running \`${raw}\`, but agent "${agentName}" has no matching ` +
            `Bash grant in .claude/agents/${agentName}.md -- add a grant covering it, or reassign the card.`
        );
      }
    }

    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(text))) {
      const hostPort = match[1].split("/")[0];
      if (/:\d+$/.test(hostPort) && !inventory.endpoints.includes(hostPort)) {
        addFailure(
          `AC item "${text}" names service endpoint "${hostPort}", which is not in the installed ` +
            `capability inventory (checked tools/board/src/runner/capabilityInventory.js's REACHABLE_SERVICE_ENDPOINTS).`
        );
      }
    }
  }

  if (failures.length === 0) {
    return { ok: true, message: "" };
  }
  return {
    ok: false,
    message: `Card ${id} failed capability preflight -- ${failures.join(" | ")}`
  };
}
