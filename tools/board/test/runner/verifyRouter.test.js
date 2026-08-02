import { describe, it, expect } from "vitest";
import { resolveVerifyRoutes } from "../../src/runner/verifyRouter.js";

describe("resolveVerifyRoutes", () => {
  it("routes a tasks/-only diff to the backlog validator, and nothing else", () => {
    const routes = resolveVerifyRoutes(["tasks/T-0200.md", "tasks/T-0201.md"]);
    expect(routes.map((r) => r.id)).toEqual(["backlog-validate"]);
    expect(routes[0].command).toContain("validateBacklog.js");
  });

  it("routes a tools/board diff to the board suite, and not the backlog validator", () => {
    const routes = resolveVerifyRoutes(["tools/board/src/lib/fsTaskStore.js"]);
    expect(routes.map((r) => r.id)).toEqual(["board-suite"]);
  });

  it("routes a diff touching both tasks/** and tools/board/** to both checks", () => {
    const routes = resolveVerifyRoutes(["tasks/T-0200.md", "tools/board/src/lib/fsTaskStore.js"]);
    expect(routes.map((r) => r.id).sort()).toEqual(["backlog-validate", "board-suite"]);
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
