import { formatHostActionRequest } from "../lib/hostActionRequest.js";
import { KNOWN_HOST_ISSUES } from "./knownHostIssues.js";

/**
 * Preflight (T-0323): checks whether a card's assigned agent is about to walk into a *known*,
 * unresolved host-state blocker -- one already diagnosed on a prior card but never fixed, because
 * fixing it needs a host shell no agent has (see docs/design/host-action-escalation.md; the
 * ComfyUI determinism flags from T-0272/T-0317 are the worked example). Runs before the
 * implementer is spawned, same {ok, message} contract as capabilityPreflight.js, so
 * runOrchestrator.js can route a failure through the identical fail-fast/escalate path -- the
 * entire point is surfacing this at the START of a run, not after retries are spent.
 */
export function checkHostStatePreflight(task, agentName, { registry = KNOWN_HOST_ISSUES } = {}) {
  const id = task?.id ?? "unknown";
  const body = task?.body ?? "";
  const match = registry.find(
    (issue) => !issue.resolved && issue.appliesToAgents.includes(agentName) && (!issue.bodyPattern || issue.bodyPattern.test(body))
  );
  if (!match) {
    return { ok: true, message: "", hostAction: null };
  }

  const hostAction = { host: match.host, action: match.action, reason: match.reason, verify: match.verify };
  const message =
    `Card ${id} failed host-state preflight -- a known, unresolved host-side blocker applies to agent "${agentName}" ` +
    `(${match.condition}). This needs a host action no agent can perform from here:\n\n` +
    formatHostActionRequest(hostAction);

  return { ok: false, message, hostAction };
}
