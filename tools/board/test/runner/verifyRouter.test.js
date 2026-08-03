import { describe, it, expect } from "vitest";
import { resolveVerifyRoutes } from "../../src/runner/verifyRouter.js";

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

  it("routes a diff touching both tasks/** and tools/board/** to all three checks", () => {
    const routes = resolveVerifyRoutes(["tasks/T-0200.md", "tools/board/src/lib/fsTaskStore.js"]);
    expect(routes.map((r) => r.id).sort()).toEqual(["backlog-validate", "board-suite", "planner-diff-guard"]);
  });

  it("routes a diff outside both tasks/** and tools/board/** to neither -- other subsystems keep their own verify-skill routing", () => {
    const routes = resolveVerifyRoutes(["server/src/main.cpp"]);
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
      "assets/src/audio"
    ];
    for (const root of roots) {
      const routes = resolveVerifyRoutes([`${root}/tests/test_smoke.py`]);
      expect(routes.map((r) => r.id)).toEqual([`python-verify:${root}`]);
    }
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

  it("leaves a non-Python diff (e.g. server/**) unaffected -- no routes returned", () => {
    const routes = resolveVerifyRoutes(["server/src/main.cpp"]);
    expect(routes).toEqual([]);
  });
});
