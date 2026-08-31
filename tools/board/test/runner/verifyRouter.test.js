import { describe, it, expect } from "vitest";
import { resolveVerifyRoutes, resolveDeliverableRoute, GODOT_HEADLESS_TIMEOUT_SECONDS } from "../../src/runner/verifyRouter.js";

describe("resolveVerifyRoutes", () => {
  it("routes a tasks/-only diff to the backlog validator AND the planner diff guard, and nothing else", () => {
    const routes = resolveVerifyRoutes(["tasks/T-0200.md", "tasks/T-0201.md"]);
    expect(routes.map((r) => r.id)).toEqual(["backlog-validate", "planner-diff-guard"]);
    expect(routes[0].command).toContain("validateBacklog.js");
    expect(routes[1].command).toContain("checkPlannerDiffGuard.js");
  });

  it("defaults the planner diff guard's base ref to develop", () => {
    const routes = resolveVerifyRoutes(["tasks/T-0200.md"]);
    const guard = routes.find((r) => r.id === "planner-diff-guard");
    expect(guard.command).toBe("node tools/board/scripts/checkPlannerDiffGuard.js develop");
  });

  it("threads a custom baseBranch through to the planner diff guard's command", () => {
    const routes = resolveVerifyRoutes(["tasks/T-0200.md"], { baseBranch: "main" });
    const guard = routes.find((r) => r.id === "planner-diff-guard");
    expect(guard.command).toBe("node tools/board/scripts/checkPlannerDiffGuard.js main");
  });

  it("routes a tools/board diff to the board suite, and not the backlog validator or diff guard", () => {
    const routes = resolveVerifyRoutes(["tools/board/src/lib/fsTaskStore.js"]);
    expect(routes.map((r) => r.id)).toEqual(["board-suite"]);
  });

  it("board-suite command is self-contained (includes cd tools/board) so the harness can run it from the repo root without a manual directory change", () => {
    const routes = resolveVerifyRoutes(["tools/board/src/lib/fsTaskStore.js"]);
    const route = routes.find((r) => r.id === "board-suite");
    expect(route.command).toContain("cd tools/board");
    expect(route.command).toContain("npm test");
    expect(route.command).toContain("npx eslint .");
  });

  it("routes a diff touching both tasks/** and tools/board/** to all three checks", () => {
    const routes = resolveVerifyRoutes(["tasks/T-0200.md", "tools/board/src/lib/fsTaskStore.js"]);
    expect(routes.map((r) => r.id).sort()).toEqual(["backlog-validate", "board-suite", "planner-diff-guard"]);
  });

  it("routes a diff outside tasks/**, tools/board/**, a Python package root, and server/**/shared/** to neither -- other subsystems keep their own verify-skill routing", () => {
    const routes = resolveVerifyRoutes(["client/src/main.cpp"]);
    expect(routes).toEqual([]);
  });

  it("returns no routes for an empty diff", () => {
    expect(resolveVerifyRoutes([])).toEqual([]);
  });

  it("does not mistake a tools/board-prefixed-but-different path for a real match", () => {
    const routes = resolveVerifyRoutes(["tools/board-legacy/whatever.js"]);
    expect(routes).toEqual([]);
  });

  it("does not mistake a tasks-prefixed-but-different path (e.g. tasksomething/) for tasks/**", () => {
    const routes = resolveVerifyRoutes(["tasksomething/foo.md"]);
    expect(routes).toEqual([]);
  });

  it("routes a Python package diff to a python-verify step for that package", () => {
    const routes = resolveVerifyRoutes(["tools/asset-gate/src/asset_gate/checks/loudness.py"]);
    expect(routes.map((r) => r.id)).toEqual(["python-verify:tools/asset-gate"]);
    const route = routes[0];
    expect(route.command).toContain("cd tools/asset-gate");
    expect(route.command).toContain("python3 -m venv .venv");
    expect(route.command).toContain('.venv/bin/pip install -e ".[dev]"');
    expect(route.command).toContain(".venv/bin/pytest");
    expect(route.command).toContain(".venv/bin/ruff check --fix .");
    expect(route.command).toContain(".venv/bin/ruff check .");
  });

  it("routes each known Python package root to its own python-verify step", () => {
    const roots = [
      "tools/asset-gate",
      "tools/comfy-client",
      "tools/audio-agent",
      "tools/gen-client-base",
      "tools/palette-extract",
      "tools/sim",
      "assets/src/audio",
      "assets/src/lora",
      "assets/src/tiles",
      "assets/src/ambience_synth",
      "assets/src/character"
    ];
    for (const root of roots) {
      const routes = resolveVerifyRoutes([`${root}/tests/test_smoke.py`]);
      expect(routes.map((r) => r.id)).toEqual([`python-verify:${root}`]);
    }
  });

  it("routes an assets/src/character/** diff to python-verify -- T-0264's package, missing from PYTHON_PACKAGE_ROOTS so no route fired on a character-package diff", () => {
    const routes = resolveVerifyRoutes(["assets/src/character/src/character/gen_entities_v2.py"]);
    expect(routes.map((r) => r.id)).toEqual(["python-verify:assets/src/character"]);
    const route = routes[0];
    expect(route.command).toContain("cd assets/src/character");
    expect(route.command).toContain("python3 -m venv .venv");
    expect(route.command).toContain('.venv/bin/pip install -e ".[dev]"');
    expect(route.command).toContain(".venv/bin/pytest");
    expect(route.command).toContain(".venv/bin/ruff check --fix .");
    expect(route.command).toContain(".venv/bin/ruff check .");
  });

  it("routes an assets/src/ambience_synth/** diff to python-verify -- T-0202's package, added after three consecutive runs blocked on a missing reviewer grant", () => {
    const routes = resolveVerifyRoutes(["assets/src/ambience_synth/src/ambience_synth/pipeline.py"]);
    expect(routes.map((r) => r.id)).toEqual(["python-verify:assets/src/ambience_synth"]);
    const route = routes[0];
    expect(route.command).toContain("cd assets/src/ambience_synth");
    expect(route.command).toContain("python3 -m venv .venv");
    expect(route.command).toContain('.venv/bin/pip install -e ".[dev]"');
    expect(route.command).toContain(".venv/bin/pytest");
    expect(route.command).toContain(".venv/bin/ruff check --fix .");
    expect(route.command).toContain(".venv/bin/ruff check .");
  });

  it("routes an assets/src/lora/** diff to python-verify -- T-0072's package, added after it blocked on a missing reviewer grant", () => {
    const routes = resolveVerifyRoutes(["assets/src/lora/src/lora/train.py"]);
    expect(routes.map((r) => r.id)).toEqual(["python-verify:assets/src/lora"]);
    const route = routes[0];
    expect(route.command).toContain("cd assets/src/lora");
    expect(route.command).toContain("python3 -m venv .venv");
    expect(route.command).toContain('.venv/bin/pip install -e ".[dev]"');
    expect(route.command).toContain(".venv/bin/pytest");
    expect(route.command).toContain(".venv/bin/ruff check --fix .");
    expect(route.command).toContain(".venv/bin/ruff check .");
  });

  it("routes a diff touching two Python packages to a python-verify step per package", () => {
    const routes = resolveVerifyRoutes([
      "tools/comfy-client/src/comfy_client/client.py",
      "tools/audio-agent/src/audio_agent/client.py"
    ]);
    expect(routes.map((r) => r.id).sort()).toEqual([
      "python-verify:tools/audio-agent",
      "python-verify:tools/comfy-client"
    ]);
  });

  it("routes a diff touching a Python package and tools/board/** to both python-verify and board-suite", () => {
    const routes = resolveVerifyRoutes([
      "tools/palette-extract/src/palette_extract/extract.py",
      "tools/board/src/lib/fsTaskStore.js"
    ]);
    expect(routes.map((r) => r.id).sort()).toEqual(["board-suite", "python-verify:tools/palette-extract"]);
  });

  it("does not route a single Python package's diff more than once for multiple changed files", () => {
    const routes = resolveVerifyRoutes([
      "tools/gen-client-base/src/gen_client_base/main.py",
      "tools/gen-client-base/tests/test_main.py"
    ]);
    expect(routes.map((r) => r.id)).toEqual(["python-verify:tools/gen-client-base"]);
  });

  it("does not route the vendored godot-cpp submodule's pyproject.toml as a repo-owned Python package", () => {
    const routes = resolveVerifyRoutes(["client/godot-cpp/pyproject.toml"]);
    expect(routes).toEqual([]);
  });

  it("does not mistake a python-package-prefixed-but-different path for a real match", () => {
    const routes = resolveVerifyRoutes(["tools/asset-gate-legacy/whatever.py"]);
    expect(routes).toEqual([]);
  });

  it("leaves a non-Python diff (e.g. server/**) unaffected by python-verify routing -- routes to server-db-verify only", () => {
    const routes = resolveVerifyRoutes(["server/src/main.cpp"]);
    expect(routes.map((r) => r.id)).toEqual(["server-db-verify"]);
  });
});

describe("resolveVerifyRoutes -- server-db-verify", () => {
  it("routes a server/** diff to server-db-verify", () => {
    const routes = resolveVerifyRoutes(["server/src/main.cpp"]);
    expect(routes.map((r) => r.id)).toEqual(["server-db-verify"]);
  });

  it("routes a shared/** diff to server-db-verify too -- shared/ is co-owned wire structs server/** depends on", () => {
    const routes = resolveVerifyRoutes(["shared/protocol.h"]);
    expect(routes.map((r) => r.id)).toEqual(["server-db-verify"]);
  });

  it("does not route a client/** diff to server-db-verify", () => {
    const routes = resolveVerifyRoutes(["client/src/main.cpp"]);
    expect(routes).toEqual([]);
  });

  it("does not mistake a server-prefixed-but-different path (e.g. serverless/) for server/**", () => {
    const routes = resolveVerifyRoutes(["serverless/whatever.cpp"]);
    expect(routes).toEqual([]);
  });

  it("routes each of server/** and shared/** to the same single server-db-verify step, not one per prefix", () => {
    const routes = resolveVerifyRoutes(["server/src/main.cpp", "shared/protocol.h"]);
    expect(routes.map((r) => r.id)).toEqual(["server-db-verify"]);
  });

  it("brings up the compose Postgres, exports the documented dev DATABASE_URL, forces a from-scratch build, and runs ctest", () => {
    const routes = resolveVerifyRoutes(["server/src/MigrationRunner.cpp"]);
    const route = routes.find((r) => r.id === "server-db-verify");
    expect(route.command).toContain("cd server");
    expect(route.command).toContain("docker compose up -d");
    expect(route.command).toContain(
      "export DATABASE_URL=postgresql://assembled:assembled@localhost:5433/assembled_dev"
    );
    expect(route.command).toContain("rm -rf build");
    expect(route.command).toContain("cmake -S . -B build -DCMAKE_BUILD_TYPE=Release");
    expect(route.command).toContain("cmake --build build --parallel");
    expect(route.command).toContain("ctest --test-dir build --output-on-failure");
  });

  it("checks ctest's registered test list for all three DB-gated test names before trusting the real run -- the fail-closed guard", () => {
    const routes = resolveVerifyRoutes(["server/migrations/002_identity.sql"]);
    const route = routes.find((r) => r.id === "server-db-verify");
    expect(route.command).toContain("ctest --test-dir build -N");
    expect(route.command).toContain("migrations apply against a live Postgres");
    expect(route.command).toContain("identity table has no phrase column");
    expect(route.command).toContain("POST /v1/identity HTTP integration");
    // the count check -- exactly 3 known DB-gated tests must be registered
    expect(route.command).toMatch(/=\s*3\b/);
  });

  it("routes a diff touching server/** and a Python package to both server-db-verify and python-verify", () => {
    const routes = resolveVerifyRoutes([
      "server/src/main.cpp",
      "tools/comfy-client/src/comfy_client/client.py"
    ]);
    expect(routes.map((r) => r.id).sort()).toEqual(["python-verify:tools/comfy-client", "server-db-verify"]);
  });

  it("routes a diff touching server/** and tools/board/** to both server-db-verify and board-suite", () => {
    const routes = resolveVerifyRoutes(["server/src/main.cpp", "tools/board/src/lib/fsTaskStore.js"]);
    expect(routes.map((r) => r.id).sort()).toEqual(["board-suite", "server-db-verify"]);
  });
});

describe("resolveVerifyRoutes -- client-godot-verify (T-0185: hung headless Godot tests)", () => {
  it("routes a changed client/tests/*.gd file to a timeout-wrapped godot --headless run of that test", () => {
    const routes = resolveVerifyRoutes(["client/tests/test_signal_tower.gd"]);
    expect(routes.map((r) => r.id)).toEqual(["client-godot-verify:client/tests/test_signal_tower.gd"]);
    const route = routes[0];
    expect(route.command).toContain("cd client");
    expect(route.command).toContain(`timeout ${GODOT_HEADLESS_TIMEOUT_SECONDS}`);
    expect(route.command).toContain("godot --headless --script tests/test_signal_tower.gd");
  });

  it("a hung test script (never calls get_tree().quit()) is bounded by `timeout`, not left to hang the reviewer forever", () => {
    const routes = resolveVerifyRoutes(["client/tests/test_signal_tower.gd"]);
    // The `timeout` coreutil sends SIGTERM (then SIGKILL on a repeat -k) to the whole command
    // if it hasn't exited by the deadline -- this is what actually bounds a script that never
    // calls quit(), independent of anything upstream watching the reviewer's own process.
    expect(routes[0].command).toMatch(/timeout \d+s? godot --headless/);
  });

  it("routes each changed client/tests/*.gd file to its own route -- a diff can touch more than one test", () => {
    const routes = resolveVerifyRoutes(["client/tests/test_signal_tower.gd", "client/tests/test_room_objects.gd"]);
    expect(routes.map((r) => r.id).sort()).toEqual([
      "client-godot-verify:client/tests/test_room_objects.gd",
      "client-godot-verify:client/tests/test_signal_tower.gd"
    ]);
  });

  it("does not route a non-test client/** file (e.g. a scene script) -- no way to know which test(s) cover it", () => {
    const routes = resolveVerifyRoutes(["client/room/lever.gd"]);
    expect(routes).toEqual([]);
  });

  it("does not route client/**/*.cpp (GDExtension C++) -- that's scons + clang-format, unrelated to headless Godot test hangs", () => {
    const routes = resolveVerifyRoutes(["client/src/item_client.cpp"]);
    expect(routes).toEqual([]);
  });

  it("does not mistake a client/tests-prefixed-but-different path for a real test file", () => {
    const routes = resolveVerifyRoutes(["client/tests-legacy/whatever.gd"]);
    expect(routes).toEqual([]);
  });

  it("only routes .gd files under client/tests/, not .tscn/.tres fixtures alongside them", () => {
    const routes = resolveVerifyRoutes(["client/tests/fixtures/room.tscn"]);
    expect(routes).toEqual([]);
  });
});

describe("resolveDeliverableRoute -- task-driven, not diff-path-driven (T-0136 gap)", () => {
  it("returns null when deliverable_type is 'code' (the default)", () => {
    expect(resolveDeliverableRoute({ id: "T-0001", deliverable_type: "code" })).toBeNull();
  });

  it("returns null when deliverable_type is absent", () => {
    expect(resolveDeliverableRoute({ id: "T-0001" })).toBeNull();
  });

  it("returns null when task is missing", () => {
    expect(resolveDeliverableRoute(undefined)).toBeNull();
  });

  it("returns the deliverable check route for deliverable_type: 'artifact', naming the task id", () => {
    const route = resolveDeliverableRoute({ id: "T-0136", deliverable_type: "artifact" });
    expect(route.id).toBe("deliverable-check");
    expect(route.command).toBe("node tools/board/scripts/checkDeliverable.js T-0136");
  });
});

describe("resolveDeliverableRoute -- diff-detected artifact backstop (T-0198/T-0209/T-0202 gap: real art/audio committed under deliverable_type: 'code')", () => {
  it("routes a code-deliverable card when the diff adds a PNG under assets/final/**", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0198", deliverable_type: "code" },
      ["assets/final/character/player_idle_sheet_v1.png"]
    );
    expect(route).not.toBeNull();
    expect(route.id).toBe("deliverable-check");
  });

  it("routes a code-deliverable card when the diff adds a concept sheet PNG under assets/src/concept/**", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0209", deliverable_type: "code" },
      ["assets/src/concept/player_concept_sheet_v1.png"]
    );
    expect(route).not.toBeNull();
  });

  it("routes a code-deliverable card when the diff adds key art under assets/src/keyart/**", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0155", deliverable_type: "code" },
      ["assets/src/keyart/signal_tower_keyart_v1.png"]
    );
    expect(route).not.toBeNull();
  });

  it("routes a code-deliverable card when the diff adds an ogg under assets/final/audio/**", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0202", deliverable_type: "code" },
      ["assets/final/audio/signal_tower_ambience.ogg"]
    );
    expect(route).not.toBeNull();
  });

  it("adds a --require-artifact flag to the command when routed only by the diff signal, not by deliverable_type", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0198", deliverable_type: "code" },
      ["assets/final/character/player_idle_sheet_v1.png"]
    );
    expect(route.command).toBe("node tools/board/scripts/checkDeliverable.js T-0198 --require-artifact");
  });

  it("does NOT add --require-artifact when deliverable_type is already 'artifact' -- unchanged command shape", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0136", deliverable_type: "artifact" },
      ["assets/final/whatever.png"]
    );
    expect(route.command).toBe("node tools/board/scripts/checkDeliverable.js T-0136");
  });

  it("does not route a code-deliverable card for a non-artifact extension under assets/final/** (e.g. a workflow JSON or provenance doc)", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0201", deliverable_type: "code" },
      ["assets/final/props/signal_tower/_comfyui_workflow.json", "ASSET_PROVENANCE.md"]
    );
    expect(route).toBeNull();
  });

  it("does not route a code-deliverable card for a Python/script change under assets/src/** outside concept/keyart (pure pipeline code)", () => {
    const route = resolveDeliverableRoute(
      { id: "T-0073", deliverable_type: "code" },
      ["assets/src/lora/src/lora/train.py", "tools/asset-gate/src/asset_gate/checks/loudness.py"]
    );
    expect(route).toBeNull();
  });

  it("does not route a code-deliverable card whose diff is entirely outside assets/**", () => {
    const route = resolveDeliverableRoute({ id: "T-0001", deliverable_type: "code" }, ["tools/board/src/lib/thing.js"]);
    expect(route).toBeNull();
  });

  it("still returns null for a code-deliverable card with no changedPaths given (default [])", () => {
    expect(resolveDeliverableRoute({ id: "T-0001", deliverable_type: "code" })).toBeNull();
  });
});
