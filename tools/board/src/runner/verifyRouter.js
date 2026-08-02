const TASKS_PREFIX = "tasks/";
const BOARD_PREFIX = "tools/board/";

/**
 * Routes a reviewer's VALIDATION run to the check(s) that match the diff's
 * actually-changed paths -- the code-level counterpart to the `verify`
 * skill's path table, for the routes this repo enforces in code rather than
 * leaving to the reviewer's own reading of a markdown table: a planner diff
 * (tasks/**) runs the backlog validator AND the planner diff guard (catches
 * a card's `status` changing or a card file being deleted -- the two
 * invariants `.claude/agents/planner.md` promises but a reviewer reading
 * prose can miss); a board diff (tools/board/**) runs the board's own
 * test/lint suite; a diff touching both runs all three. Diffs outside these
 * two prefixes (server/**, client/**, etc.) return no routes here -- their
 * verification stays qualitatively described by the `verify` skill's table,
 * unchanged.
 */
export function resolveVerifyRoutes(changedPaths = [], { baseBranch = "develop" } = {}) {
  const touchesTasks = changedPaths.some((p) => p.startsWith(TASKS_PREFIX));
  const touchesBoard = changedPaths.some((p) => p.startsWith(BOARD_PREFIX));

  const routes = [];
  if (touchesTasks) {
    routes.push({
      id: "backlog-validate",
      label: "Backlog validator",
      command: "node tools/board/scripts/validateBacklog.js"
    });
    routes.push({
      id: "planner-diff-guard",
      label: "Planner diff guard (status/deletion)",
      command: `node tools/board/scripts/checkPlannerDiffGuard.js ${baseBranch}`
    });
  }
  if (touchesBoard) {
    routes.push({
      id: "board-suite",
      label: "Board test/lint suite",
      command: "npm test && npx eslint . (run from tools/board)"
    });
  }
  return routes;
}
