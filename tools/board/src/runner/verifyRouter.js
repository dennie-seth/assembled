const TASKS_PREFIX = "tasks/";
const BOARD_PREFIX = "tools/board/";

/**
 * Known first-party Python package roots (each is the directory containing
 * that package's `pyproject.toml`). Kept as a static list rather than
 * resolved from disk so this router stays a pure function of `changedPaths`
 * -- fs-free and spawn-free, same as the rest of this module -- and testable
 * without a real checkout. `client/godot-cpp` also has a `pyproject.toml`
 * but is a vendored git submodule (see `.gitmodules`), not repo-owned
 * Python, so it is deliberately excluded. Add new packages here as they're
 * created.
 */
const PYTHON_PACKAGE_ROOTS = [
  "tools/asset-gate/",
  "tools/comfy-client/",
  "tools/audio-agent/",
  "tools/gen-client-base/",
  "tools/palette-extract/",
  "tools/sim/",
  "assets/src/audio/"
];

function detectPythonPackageRoots(changedPaths) {
  const touched = new Set();
  for (const path of changedPaths) {
    for (const root of PYTHON_PACKAGE_ROOTS) {
      if (path.startsWith(root)) {
        touched.add(root);
      }
    }
  }
  return [...touched].sort();
}

/**
 * Routes a reviewer's VALIDATION run to the check(s) that match the diff's
 * actually-changed paths -- the code-level counterpart to the `verify`
 * skill's path table, for the routes this repo enforces in code rather than
 * leaving to the reviewer's own reading of a markdown table: a planner diff
 * (tasks/**) runs the backlog validator AND the planner diff guard (catches
 * a card's `status` changing or a card file being deleted -- the two
 * invariants `.claude/agents/planner.md` promises but a reviewer reading
 * prose can miss); a board diff (tools/board/**) runs the board's own
 * test/lint suite; a diff touching a Python package (see
 * `PYTHON_PACKAGE_ROOTS`) runs a per-package `python-verify` step --
 * refresh the package's `.venv`, `pip install -e ".[dev]"`, then `pytest`
 * and `ruff check .` from that package's directory -- so the reviewer
 * actually executes the test suite instead of reading the diff and calling
 * test-passage "unverified" (the T-0099 dogfood gap this closes: 9 real
 * failures went unnoticed because nothing ran them). A diff touching
 * several of these routes at once returns all of them, one route per
 * package for a multi-package diff. Diffs outside all of these prefixes
 * (server/**, client/** godot-cpp, etc.) return no routes here -- their
 * verification stays qualitatively described by the `verify` skill's table,
 * unchanged.
 */
export function resolveVerifyRoutes(changedPaths = [], { baseBranch = "develop" } = {}) {
  const touchesTasks = changedPaths.some((p) => p.startsWith(TASKS_PREFIX));
  const touchesBoard = changedPaths.some((p) => p.startsWith(BOARD_PREFIX));
  const pythonRoots = detectPythonPackageRoots(changedPaths);

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
  for (const root of pythonRoots) {
    const pkgDir = root.slice(0, -1);
    routes.push({
      id: `python-verify:${pkgDir}`,
      label: `Python verify (${pkgDir})`,
      command:
        `cd ${pkgDir} && python3 -m venv .venv && ` +
        `.venv/bin/pip install -e ".[dev]" && ` +
        `.venv/bin/pytest && .venv/bin/ruff check .`
    });
  }
  return routes;
}
