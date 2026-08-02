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
});
