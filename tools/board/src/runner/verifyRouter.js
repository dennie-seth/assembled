const TASKS_PREFIX = "tasks/";
const BOARD_PREFIX = "tools/board/";

/**
 * Wall-clock bound (in seconds, for the `timeout` coreutil) on a single headless Godot test
 * invocation -- root-cause fix for T-0185: `test_signal_tower.gd` never called
 * `get_tree().quit()`, and nothing downstream of the reviewer's own Bash tool call was watching
 * for that, so the hang propagated all the way up (the `claude` child stayed alive right along
 * with its grandchild, invisible to the phase-level timeout until that fired much later -- see
 * `runOrchestrator.js`'s `DEFAULT_PHASE_TIMEOUT_MS`). 10 minutes is comfortably above every
 * `client/tests/*.gd` script observed so far (all are synchronous, in-process assertions with
 * no I/O -- `docs/ci-notes.md`'s CI runs finish each in well under a minute), while still being
 * far short of `DEFAULT_PHASE_TIMEOUT_MS` so a hung test surfaces as a specific, actionable
 * `timeout`-killed failure instead of a generic phase-timeout blocked reason. Kept in seconds
 * (not ms) to match `timeout`'s own CLI argument.
 */
export const GODOT_HEADLESS_TIMEOUT_SECONDS = 600;

const CLIENT_TEST_PATTERN = /^client\/tests\/([^/]+\.gd)$/;

/**
 * `server/**` is the C++/Drogon backend, `shared/**` is co-owned wire
 * structs it depends on -- the same two prefixes `ci-server.yml` triggers
 * on. Both get the server-db-verify route below.
 */
const SERVER_ROOTS = ["server/", "shared/"];

/** Dev Postgres from `server/docker-compose.yml` / `server/README.md`'s
 * documented `DATABASE_URL` -- port 5433, not 5432 (WSL2 mirrored
 * networking collides with the host's own Postgres on 5432, see the
 * compose file's own comment). */
const SERVER_DEV_DATABASE_URL = "postgresql://assembled:assembled@localhost:5433/assembled_dev";

/**
 * The literal `TEST_CASE(...)` strings for every `doctest::skip(!DATABASE_URL)`-gated
 * test in `server/test/migration_test.cpp` and `server/test/identity_test.cpp`
 * -- the T-0043 postmortem's own list. `doctest_discover_tests` (CMake's
 * POST_BUILD discovery, `server/CMakeLists.txt`) evaluates each test's skip
 * predicate at *build* time, not at `ctest`-run time: if `DATABASE_URL` was
 * unset when `cmake --build` last ran discovery, these three tests are not
 * merely marked skipped in `ctest`'s output -- they are absent from `ctest`'s
 * registered test list entirely, and `ctest --output-on-failure` reports
 * "100% tests passed" with no visible hint anything is missing (verified
 * empirically: 11 tests registered without `DATABASE_URL` at build time, 14
 * with it). That silent gap is exactly what let T-0043 through, so the
 * server-db-verify route below checks the registered count itself rather
 * than trusting `ctest`'s summary line.
 */
const SERVER_DB_GATED_TEST_NAMES = [
  "migrations apply against a live Postgres",
  "identity table has no phrase column",
  "POST /v1/identity HTTP integration"
];

function touchesServerRoots(changedPaths) {
  return changedPaths.some((path) => SERVER_ROOTS.some((root) => path.startsWith(root)));
}

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
  "assets/src/audio/",
  "assets/src/lora/",
  "assets/src/tiles/",
  "assets/src/ambience_synth/",
  "assets/src/character/"
];

function detectChangedGodotTests(changedPaths) {
  const matches = [];
  for (const path of changedPaths) {
    const match = CLIENT_TEST_PATTERN.exec(path);
    if (match) matches.push({ path, fileName: match[1] });
  }
  return matches.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Directories where the `assets`/`audio` agents commit a real, shareable deliverable, per their
 * own `.claude/agents/{assets,audio}.md` conventions: `assets/final/**` (curated finals,
 * including `assets/final/audio/**`) and `assets/src/concept/**` / `assets/src/keyart/**`
 * (concept sheets and key art -- human-reviewed pipeline deliverables in their own right, see
 * `docs/design/13-asset-pipeline.md` §6.8-6.11, not "final" but still real produced files).
 * A new or changed file with one of these extensions under one of these prefixes is a real
 * produced artifact regardless of what the card's own `deliverable_type` frontmatter claims --
 * the mechanical backstop for the observed failure mode where several art/audio cards
 * (character sheets T-0198-T-0200, concept art T-0209-T-0211, an ambience bed T-0202) were
 * committed straight to the repo tagged `deliverable_type: "code"` and never attached, so the
 * plain `deliverable_type`-gated route below never even fired for them.
 */
const ARTIFACT_PRODUCING_PREFIXES = ["assets/final/", "assets/src/concept/", "assets/src/keyart/"];
const ARTIFACT_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ogg", ".wav", ".mp3", ".flac"]);

function touchesArtifactProducingPath(changedPaths) {
  return changedPaths.some((changedPath) => {
    if (!ARTIFACT_PRODUCING_PREFIXES.some((prefix) => changedPath.startsWith(prefix))) return false;
    const dot = changedPath.lastIndexOf(".");
    const ext = dot === -1 ? "" : changedPath.slice(dot).toLowerCase();
    return ARTIFACT_FILE_EXTENSIONS.has(ext);
  });
}

/**
 * A committed batch-fetch reference summary (T-0282) -- `assets/src/reference/<slug>-summary.md`,
 * never `assets/src/reference/quarantine/**` (gitignored, never part of a diff) and never some
 * other markdown file under the same directory (a README, a design note).
 */
const REFERENCE_BATCH_SUMMARY_RE = /^assets\/src\/reference\/[^/]+-summary\.md$/;

function detectReferenceBatchSummaryPaths(changedPaths) {
  return changedPaths.filter((changedPath) => REFERENCE_BATCH_SUMMARY_RE.test(changedPath));
}

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
 * `server/**` or `shared/**` runs `server-db-verify`: bring up the repo's
 * compose Postgres, export `DATABASE_URL`, force a from-scratch
 * configure+build (so `doctest_discover_tests`' build-time skip evaluation
 * actually sees `DATABASE_URL`), confirm all three DB-gated tests
 * registered with `ctest` at all, then run the full suite -- the
 * code-enforced fix for the exact gap that let T-0043 through (DB tests
 * skipped locally with no Postgres, reviewer passed the card, CI then found
 * 10/22 failures against live Postgres). A changed `client/tests/*.gd` file runs
 * `client-godot-verify` (one route per changed test file): `godot --headless --script
 * tests/<file>.gd` wrapped in `timeout GODOT_HEADLESS_TIMEOUT_SECONDS` -- the code-enforced fix
 * for T-0185, where a headless test that never called `get_tree().quit()` hung its `claude`
 * parent (and everything watching it) indefinitely. Deliberately scoped to *changed* test files
 * only, not every `client/**` diff -- there's no reliable way to infer which existing tests
 * cover an arbitrary changed scene/GDExtension source file from the diff alone, and running the
 * wrong ones would say nothing about what was actually changed (see this module's own docstring
 * principle at the top of the `verify` skill). A diff touching `assets/src/reference/*-summary.md`
 * (a committed batch-fetch reference summary, T-0282) runs `checkReferenceBatchSummary.js` against
 * every such file in the diff -- the mechanical backstop for T-0281, where a committed summary
 * recorded sha256/licence/retrievedAt for each kept image but not the `assetId`/`sourceUrl` that
 * let a human re-verify the licence claim after the gitignored quarantine directory backing it was
 * reclaimed with the worktree. A diff touching several of these routes at once returns all of
 * them, one route per package/test for a multi-match diff. Diffs outside all of these prefixes
 * (client/** godot-cpp, etc.) return no routes here -- their verification stays qualitatively
 * described by the `verify` skill's table, unchanged.
 */
export function resolveVerifyRoutes(changedPaths = [], { baseBranch = "develop" } = {}) {
  const touchesTasks = changedPaths.some((p) => p.startsWith(TASKS_PREFIX));
  const touchesBoard = changedPaths.some((p) => p.startsWith(BOARD_PREFIX));
  const pythonRoots = detectPythonPackageRoots(changedPaths);
  const godotTests = detectChangedGodotTests(changedPaths);

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
      command: "cd tools/board && npm test && npx eslint ."
    });
  }
  const referenceBatchSummaries = detectReferenceBatchSummaryPaths(changedPaths);
  if (referenceBatchSummaries.length > 0) {
    routes.push({
      id: "reference-batch-summary-provenance",
      label: "Reference batch-fetch summary provenance check (assetId/sourceUrl per kept image)",
      command: `node tools/board/scripts/checkReferenceBatchSummary.js ${referenceBatchSummaries.join(" ")}`
    });
  }
  if (touchesServerRoots(changedPaths)) {
    const namePattern = SERVER_DB_GATED_TEST_NAMES.join("|");
    routes.push({
      id: "server-db-verify",
      label: "Server DB verify (server/**, shared/**)",
      command:
        `cd server && docker compose up -d && ` +
        `for i in $(seq 1 30); do [ "$(docker compose ps postgres --format '{{.Health}}')" = healthy ] && break; sleep 1; done && ` +
        `[ "$(docker compose ps postgres --format '{{.Health}}')" = healthy ] && ` +
        `rm -rf build && ` +
        `export DATABASE_URL=${SERVER_DEV_DATABASE_URL} && ` +
        `cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && ` +
        `cmake --build build --parallel && ` +
        `[ "$(ctest --test-dir build -N | grep -cE '${namePattern}')" = 3 ] && ` +
        `ctest --test-dir build --output-on-failure`
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
        `.venv/bin/pytest && .venv/bin/ruff check --fix . && .venv/bin/ruff check .`
    });
  }
  for (const { path, fileName } of godotTests) {
    routes.push({
      id: `client-godot-verify:${path}`,
      label: `Godot headless test (${path}, bounded by timeout)`,
      command: `cd client && timeout ${GODOT_HEADLESS_TIMEOUT_SECONDS} godot --headless --script tests/${fileName}`
    });
  }
  return routes;
}

/**
 * The reviewer's "does the claimed artifact actually exist" route -- keyed
 * off the task's own `deliverable_type`, not a diff path, since a card
 * whose deliverable is a produced file (not source) may touch zero of the
 * routes above and still need this check (e.g. a fetch/attach card whose
 * only diff is an uploader script under a Python package root already
 * covered by python-verify -- green pytest there says nothing about
 * whether anything was actually fetched). See deliverableCheck.js: an
 * "artifact" card with no attachments recorded is exactly the T-0136
 * failure mode -- an uploader CLI shipped with fully mocked tests, nothing
 * ever actually fetched or attached, and nothing in VALIDATION at the time
 * checked for the attachment itself.
 *
 * Also fires when `deliverable_type` is anything else (the default,
 * "code") but `changedPaths` shows the diff adding/updating a file under
 * `touchesArtifactProducingPath`'s known artifact directories -- a
 * mechanical backstop for the observed pattern of the card's own
 * `deliverable_type` field being set wrong (see this module's
 * `ARTIFACT_PRODUCING_PREFIXES` docstring). In that diff-triggered case the
 * generated command carries `--require-artifact`, telling
 * `checkDeliverable.js` to treat the card as artifact-deliverable even
 * though its own frontmatter says "code"; when `deliverable_type` is
 * already "artifact" the flag is omitted since it would be a no-op.
 */
export function resolveDeliverableRoute(task, changedPaths = []) {
  if (!task) {
    return null;
  }
  const declaredArtifact = task.deliverable_type === "artifact";
  const diffProducesArtifact = touchesArtifactProducingPath(changedPaths);
  if (!declaredArtifact && !diffProducesArtifact) {
    return null;
  }
  const forceFlag = declaredArtifact ? "" : " --require-artifact";
  return {
    id: "deliverable-check",
    label: `Deliverable artifact check (${task.id})`,
    command: `node tools/board/scripts/checkDeliverable.js ${task.id}${forceFlag}`
  };
}
