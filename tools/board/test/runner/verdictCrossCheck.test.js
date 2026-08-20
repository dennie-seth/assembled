import { describe, it, expect } from "vitest";
import { crossCheckVerdict } from "../../src/runner/verdictCrossCheck.js";

function toolUse(id, command) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] }
  };
}

function toolResult(id, { ok = true, text = "" } = {}) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !ok, content: text }] }
  };
}

/** A full ran-and-exited-N Bash call, as a pair of events (tool_use then its tool_result). */
function bashCall(id, command, { ok = true, text = "" } = {}) {
  return [toolUse(id, command), toolResult(id, { ok, text })];
}

const PASS = { verdict: "PASS", notes: "all green" };
const FAIL = { verdict: "FAIL", notes: "found a real bug" };

describe("crossCheckVerdict", () => {
  it("leaves a self-reported FAIL untouched, even with no Bash events at all -- never upgrades", () => {
    const result = crossCheckVerdict({
      verdict: FAIL,
      events: [],
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result).toBe(FAIL);
  });

  it("passes a null verdict through unchanged (the caller already treats null as a runner failure)", () => {
    expect(crossCheckVerdict({ verdict: null, events: [], changedPaths: [], task: {} })).toBeNull();
  });

  it("leaves a self-reported PASS unchanged when the diff triggers no required verify routes", () => {
    const result = crossCheckVerdict({
      verdict: PASS,
      events: [],
      changedPaths: ["client/godot-cpp/pyproject.toml"],
      task: { id: "T-0001" }
    });
    expect(result).toBe(PASS);
  });

  it("keeps a self-reported PASS as PASS when the required command actually ran and exited zero", () => {
    const events = [...bashCall("1", "cd tools/board && npm test && npx eslint .")];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result).toEqual(PASS);
  });

  it("downgrades a self-reported PASS to FAIL when the required command never ran at all", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "Looks fine to me." }] } }
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.downgraded).toBe(true);
    expect(result.notes).toMatch(/Board test\/lint suite/);
    expect(result.notes).toMatch(/was not run/);
    expect(result.notes).toContain("all green"); // original reviewer notes preserved for context
    expect(result.crossCheckFailures).toEqual([
      expect.objectContaining({ id: "board-suite", status: "not_run" })
    ]);
  });

  it("downgrades a self-reported PASS to FAIL when the required command ran but exited non-zero", () => {
    const events = [
      ...bashCall("1", "node tools/board/scripts/validateBacklog.js", { ok: false, text: "2 cards invalid" })
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tasks/T-0200.md"],
      task: { id: "T-0001" }
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.downgraded).toBe(true);
    expect(result.notes).toMatch(/backlog validator/i);
    expect(result.notes).toMatch(/exited non-zero/);
    // planner-diff-guard was required too but never ran -- both should be named.
    expect(result.crossCheckFailures.map((f) => f.id).sort()).toEqual(["backlog-validate", "planner-diff-guard"]);
  });

  it("downgrades a self-reported PASS to FAIL when a required command was killed by the timeout wrapper", () => {
    // `timeout N cmd` exits non-zero (124/137) when it kills the child -- surfaces as is_error: true,
    // same as any other nonzero Bash exit; no separate "killed" signal needed.
    const events = [
      ...bashCall("1", "cd client && timeout 600 godot --headless --script tests/test_signal_tower.gd", {
        ok: false,
        text: "Killed"
      })
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["client/tests/test_signal_tower.gd"],
      task: { id: "T-0001" }
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.crossCheckFailures).toEqual([
      expect.objectContaining({ id: "client-godot-verify:client/tests/test_signal_tower.gd", status: "failed" })
    ]);
  });

  it("recognizes equivalent forms of the required command -- different whitespace, cwd prefix, npm subcommand form", () => {
    const events = [...bashCall("1", "npm run test\nnpx eslint .   --max-warnings 0")];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result).toEqual(PASS);
  });

  it("uses the last matching invocation when a flaky command was retried and later passed", () => {
    const events = [
      ...bashCall("1", "node tools/board/scripts/validateBacklog.js", { ok: false }),
      ...bashCall("2", "node tools/board/scripts/checkPlannerDiffGuard.js develop", { ok: true }),
      ...bashCall("3", "node tools/board/scripts/validateBacklog.js", { ok: true })
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tasks/T-0200.md"],
      task: { id: "T-0001" }
    });
    expect(result).toEqual(PASS);
  });

  it("board-suite: npx vitest run counts as equivalent to npm test when reviewer lacks npm grant", () => {
    const events = [
      ...bashCall("1", "npx vitest run --reporter=verbose"),
      ...bashCall("2", "npx eslint .")
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result).toEqual(PASS);
  });

  it("board-suite: npx vitest passed then npm test permission-denied still counts as PASS (any-wins)", () => {
    const events = [
      ...bashCall("1", "npx vitest run --reporter=verbose"),
      ...bashCall("2", "cd tools/board && npm test", { ok: false }),
      ...bashCall("3", "npx eslint .")
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result).toEqual(PASS);
  });

  it("requires board-suite's test AND lint commands independently -- one present, one missing still downgrades", () => {
    const events = [...bashCall("1", "cd tools/board && npm test")];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.crossCheckFailures).toEqual([expect.objectContaining({ id: "board-suite", status: "not_run" })]);
  });

  it("cross-checks the deliverable-check route for artifact cards, keyed on the task's own id", () => {
    const events = [...bashCall("1", "node tools/board/scripts/checkDeliverable.js T-0136", { ok: true })];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/asset-gate/src/asset_gate/uploader.py"],
      task: { id: "T-0136", deliverable_type: "artifact" }
    });
    // python-verify for tools/asset-gate is also required by the diff and wasn't run.
    expect(result.verdict).toBe("FAIL");
    expect(result.crossCheckFailures.map((f) => f.id)).toEqual(["python-verify:tools/asset-gate"]);
  });

  it("passes a fully-satisfied multi-route diff (python-verify + deliverable-check)", () => {
    const events = [
      ...bashCall("1", "cd tools/asset-gate && .venv/bin/pytest && .venv/bin/ruff check ."),
      ...bashCall("2", "node tools/board/scripts/checkDeliverable.js T-0136", { ok: true })
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/asset-gate/src/asset_gate/uploader.py"],
      task: { id: "T-0136", deliverable_type: "artifact" }
    });
    expect(result).toEqual(PASS);
  });

  it("cross-checks server-db-verify on the actual ctest invocation", () => {
    const events = [
      ...bashCall(
        "1",
        "cd server && docker compose up -d && cmake --build build --parallel && ctest --test-dir build --output-on-failure",
        { ok: true }
      )
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["server/src/main.cpp"],
      task: { id: "T-0001" }
    });
    expect(result).toEqual(PASS);
  });

  it("ignores non-Bash tool_use/tool_result pairs -- a Read/Grep of the test file is not evidence it ran", () => {
    const events = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "1", name: "Read", input: { file_path: "tools/board/src/thing.js" } }] }
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "1", is_error: false, content: "..." }] } }
    ];
    const result = crossCheckVerdict({
      verdict: PASS,
      events,
      changedPaths: ["tools/board/src/thing.js"],
      task: { id: "T-0001" }
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.downgraded).toBe(true);
  });
});
