import { resolveVerifyRoutes, resolveDeliverableRoute } from "./verifyRouter.js";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pairs every Bash `tool_use` the reviewer issued with its `tool_result`, so each executed
 * command can be graded pass/fail. Correlates by `tool_use_id` the same way `runEvents.js`'s
 * `toolNamesById` map does -- stream-json only carries the tool name on the `tool_use` block,
 * not on the `tool_result` that answers it. Non-Bash tool_use/tool_result pairs are ignored:
 * only Bash is a "did the reviewer actually run the required command" signal.
 */
function extractBashInvocations(events) {
  const bashCommandsById = new Map();
  const invocations = [];

  for (const event of events ?? []) {
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_use" && block.name === "Bash" && typeof block.id === "string") {
          const command = typeof block.input?.command === "string" ? block.input.command : "";
          bashCommandsById.set(block.id, command);
        }
      }
    }
    if (event?.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          const command = bashCommandsById.get(block.tool_use_id);
          if (command === undefined) continue;
          // `is_error` is the CLI's own verdict on the Bash call: false only when the command
          // exited 0. A `timeout`-killed command (see verifyRouter.js's client-godot-verify
          // route) exits non-zero from `timeout` itself, so it lands here as `ok: false` too --
          // no separate "killed" bookkeeping needed, it's already indistinguishable from any
          // other nonzero exit for grading purposes.
          invocations.push({ command, ok: block.is_error !== true });
        }
      }
    }
  }

  return invocations;
}

/**
 * Required-fragment groups per route: every regex in a group must match a single Bash command
 * for that group to count as "ran"; every group in the list must be satisfied (by some command,
 * not necessarily the same one) for the route as a whole to count as run. Matches on the
 * distinguishing script path / binary / target of the route's generated command rather than the
 * full string, so equivalent forms (different cwd prefix, `npm run test` vs `npm test`, extra
 * flags) still count -- see verdictCrossCheck.test.js's "equivalent forms" cases. `board-suite`
 * is the one route that bundles two independently-runnable checks (test suite + lint) under a
 * single id, so it gets two groups instead of one.
 */
function requirementGroupsForRoute(route) {
  if (route.id === "backlog-validate") {
    return [[/tools\/board\/scripts\/validateBacklog\.js/]];
  }
  if (route.id === "planner-diff-guard") {
    return [[/tools\/board\/scripts\/checkPlannerDiffGuard\.js/]];
  }
  if (route.id === "board-suite") {
    return [[/\bnpm\s+(run\s+)?test\b|\bnpx\s+vitest\b/], [/\beslint\b/]];
  }
  if (route.id === "server-db-verify") {
    return [[/\bctest\b/, /--output-on-failure\b/]];
  }
  if (route.id.startsWith("python-verify:")) {
    const pkgDir = route.id.slice("python-verify:".length);
    return [[/\bpytest\b/, new RegExp(escapeRegExp(pkgDir))]];
  }
  if (route.id.startsWith("client-godot-verify:")) {
    const testPath = route.id.slice("client-godot-verify:".length);
    const fileName = testPath.split("/").pop();
    return [[/\bgodot\b/, /--headless\b/, new RegExp(escapeRegExp(fileName))]];
  }
  if (route.id === "deliverable-check") {
    const taskId = route.command.trim().split(/\s+/).pop();
    return [[/checkDeliverable\.js/, new RegExp(escapeRegExp(taskId))]];
  }
  // Unknown future route id: fall back to matching on the command's first token (the binary/
  // interpreter) rather than silently treating it as satisfied.
  return [[new RegExp(escapeRegExp(route.command.trim().split(/\s+/)[0] ?? ""))]];
}

/** `"passed"` | `"failed"` | `"not_run"` for one route against the reviewer's actual Bash invocations. */
function evaluateRoute(route, invocations) {
  let anyGroupFailed = false;
  for (const group of requirementGroupsForRoute(route)) {
    const matches = invocations.filter((inv) => group.every((re) => re.test(inv.command)));
    if (matches.length === 0) {
      return "not_run";
    }
    // Any matching invocation wins -- if any pass, the group is satisfied. This covers both the
    // retry case (first run flaky, second clean) and the equivalent-command case (npx vitest
    // passed, later npm test permission-denied): a subsequent blocked attempt doesn't erase a
    // prior passing run of an equivalent command.
    if (!matches.some((inv) => inv.ok)) {
      anyGroupFailed = true;
    }
  }
  return anyGroupFailed ? "failed" : "passed";
}

/**
 * Harness-side authority over the reviewer's self-reported verdict: never trusts free-text PASS
 * claims alone. Recomputes the same required verify routes `reviewerPrompt.js` told the reviewer
 * to run (`resolveVerifyRoutes` + `resolveDeliverableRoute`, over the same `changedPaths`/`task`/
 * `baseBranch` the prompt builder used) and cross-checks each one against the reviewer's actual
 * Bash `tool_use`/`tool_result` events. A self-reported PASS is downgraded to FAIL if any required
 * route was never run, exited non-zero, or was killed (e.g. by verifyRouter.js's `timeout` wrapper
 * on client-godot-verify) -- fail closed, per the #183 lesson that a confused/non-compliant
 * reviewer can claim PASS without ever having run the check. A self-reported FAIL is always left
 * as FAIL: the cross-check only ever downgrades, never upgrades. When there are no required
 * routes for this diff (nothing under a code-enforced prefix, and the task isn't
 * `deliverable_type: "artifact"`), the reviewer's verdict passes through unchanged -- there is
 * nothing here for the harness to verify independently.
 */
export function crossCheckVerdict({ verdict, events, changedPaths = [], task, baseBranch = "develop" }) {
  if (!verdict || verdict.verdict !== "PASS") {
    return verdict;
  }

  const routes = [...resolveVerifyRoutes(changedPaths, { baseBranch })];
  const deliverableRoute = resolveDeliverableRoute(task);
  if (deliverableRoute) {
    routes.push(deliverableRoute);
  }
  if (routes.length === 0) {
    return verdict;
  }

  const invocations = extractBashInvocations(events);
  const failures = [];
  for (const route of routes) {
    const status = evaluateRoute(route, invocations);
    if (status !== "passed") {
      failures.push({ route, status });
    }
  }

  if (failures.length === 0) {
    return verdict;
  }

  const reasons = failures.map(({ route, status }) =>
    status === "not_run"
      ? `required command for "${route.label}" (\`${route.command}\`) was not run`
      : `required command for "${route.label}" (\`${route.command}\`) ran but exited non-zero (or was killed)`
  );

  return {
    verdict: "FAIL",
    notes:
      `Self-reported PASS downgraded by harness verdict cross-check: ${reasons.join("; ")}. ` +
      `Reviewer's own notes: ${verdict.notes}`,
    downgraded: true,
    crossCheckFailures: failures.map(({ route, status }) => ({
      id: route.id,
      label: route.label,
      command: route.command,
      status
    }))
  };
}
