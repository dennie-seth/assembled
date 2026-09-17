import fs from "node:fs";
import { resolveAllowedTools } from "../runner/toolAllowlist.js";

const NPM_RUN_WILDCARD_RE = /^Bash\(npm run (.+):\*\)$/;

/**
 * Finds `Bash(npm run <script>:*)` grants whose stripped prefix ("npm run <script>:") is also a
 * literal prefix of a *different* npm script name -- npm's colon-namespaced script naming
 * convention (`test:browser` / `test:browser:install`) collides with `isToolAllowed`'s raw
 * string-prefix matching (see ../runner/toolAllowlist.js): a wildcard meant to authorise one
 * script silently also authorises any sibling script sharing that literal prefix. T-0295 hit
 * this by hand -- `Bash(npm run test:browser:*)` also matched `npm run test:browser:install`, a
 * ~390MB browser download nobody meant to grant -- and it cost a full reviewer FAIL/fix round
 * trip to catch. An exact-match grant (no trailing `:*`) has no such ambiguity, so this only
 * flags the wildcard form.
 */
export function findAmbiguousNpmRunGrants(allowedTools, npmScripts) {
  const scriptNames = Object.keys(npmScripts || {});
  const violations = [];

  for (const pattern of allowedTools) {
    const match = NPM_RUN_WILDCARD_RE.exec(String(pattern).trim());
    if (!match) continue;

    const script = match[1];
    const collisions = scriptNames.filter((name) => name !== script && name.startsWith(`${script}:`));
    if (collisions.length > 0) {
      violations.push({ pattern, script, collisions });
    }
  }

  return violations;
}

/**
 * Runs `findAmbiguousNpmRunGrants` against every agent definition's resolved `tools:` grant --
 * the same "two independently-maintained lists must agree" shape as
 * agentCheckConstraintAgreement.test.js's CHECK-constraint guard, applied to grant scoping
 * instead of the agent-name enum.
 */
export function checkAgentGrantsForNpmAmbiguity({
  agentsDir,
  npmScripts = {},
  readFileFn = fs.readFileSync,
  listAgentsFn = () =>
    fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
} = {}) {
  const violations = [];

  for (const agentName of listAgentsFn()) {
    const tools = resolveAllowedTools(agentName, { agentsDir, readFileFn });
    for (const violation of findAmbiguousNpmRunGrants(tools, npmScripts)) {
      violations.push({ agent: agentName, ...violation });
    }
  }

  return { ok: violations.length === 0, violations };
}
