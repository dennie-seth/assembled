import { isUnderClaudeDir } from "../runner/toolAllowlist.js";

/**
 * T-0411's backstop against a board-run branch writing under `.claude/`.
 *
 * `commandTargetsClaudeDirWrite` (claudeDirBashGuard.js) is a best-effort PreToolUse hook
 * heuristic -- static analysis of an arbitrary shell command can't be complete (a script whose own
 * source, written by an earlier call, never appears in this command's argv can slip past it
 * entirely). This guard doesn't try to predict what a Bash command *might* do; it inspects what a
 * run's diff *actually contains*, which is ground truth no matter how indirectly the write was
 * produced.
 *
 * It must not be keyed on path alone. `.claude/agents/planner.md` and `.claude/rules/planner.md`
 * legitimately changed on `docs/planner-card-body-ownership` (PR #415, commit 97ec3ca3) -- a human
 * (the orchestrator driver) applying the edit directly, out-of-band, from an interactive session,
 * approved 2026-09-24 as the one sanctioned route for `.claude/**` edits (T-0374 found no grant
 * ever lifts the CLI's own Edit/Write denial there, so an out-of-band human apply is not a
 * workaround -- it's the only route that was ever going to work). A guard that fires on any diff
 * touching `.claude/`, full stop, would block that same sanctioned route.
 *
 * So this function requires an explicit `branchOrigin` and only ever flags anything when it is
 * exactly `"board-run"`. That value is never read from the branch's name, content, or any other
 * data a run could shape -- it is a literal `"board-run"` written at this guard's one real call
 * site, `verdictCrossCheck.js`'s `crossCheckVerdict`, which is itself only ever invoked from
 * `runOrchestrator.js`'s own review pipeline, on a run the orchestrator started. There is no code
 * path by which an out-of-band commit -- a human/driver session that never touches
 * `runOrchestrator.js` at all -- can reach `crossCheckVerdict`, so the signal can't be spoofed by a
 * run naming its own branch to look sanctioned: the branch's name and contents are never consulted
 * for this decision, only which code is calling.
 */
export function checkClaudeDirWriteGuard({ changedPaths = [], branchOrigin } = {}) {
  if (branchOrigin !== "board-run") {
    return { ok: true, violations: [] };
  }

  const violations = changedPaths.filter(isUnderClaudeDir).map((file) => ({
    file,
    message:
      `${file} is under .claude/ -- a board-run branch must never write there (T-0411). ` +
      "The sanctioned route is a human (or the orchestrator driver) applying the change " +
      "directly, out-of-band, from an interactive session -- never from inside a run."
  }));

  return { ok: violations.length === 0, violations };
}
