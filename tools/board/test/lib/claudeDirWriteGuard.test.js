import { describe, it, expect } from "vitest";
import { checkClaudeDirWriteGuard } from "../../src/lib/claudeDirWriteGuard.js";

/**
 * T-0411's backstop: `commandTargetsClaudeDirWrite` (claudeDirBashGuard.js) is a best-effort
 * PreToolUse hook heuristic, not a guarantee -- a sufficiently indirect Bash command can slip
 * past command-text analysis entirely. This is the guard that closes the real gap: it inspects
 * the *committed diff* a run produced, which is ground truth regardless of which shell shape
 * produced it.
 *
 * It must NOT be keyed on path alone. The sanctioned route for `.claude/**` edits is a human /
 * the orchestrator driver applying them directly, out-of-band, from an interactive session
 * (approved 2026-09-24) -- exactly how `.claude/agents/planner.md` and `.claude/rules/planner.md`
 * legitimately changed on `docs/planner-card-body-ownership` (PR #415, commit 97ec3ca3). A guard
 * that fires on *any* diff touching `.claude/` would block that sanctioned route too.
 *
 * Provenance here is `branchOrigin`, and it is NOT read from the branch's name, content, or any
 * other data a run could spoof -- it is a literal passed by the one real call site
 * (verdictCrossCheck.js's crossCheckVerdict), which is only ever invoked by runOrchestrator.js's
 * own review pipeline, on a run the orchestrator itself launched. There is no code path by which
 * an out-of-band commit (a human/driver session, never touching runOrchestrator.js at all) can
 * reach crossCheckVerdict, so `branchOrigin: "board-run"` there is a structural fact about which
 * code is executing, not a claim read from attacker-reachable data.
 *
 * Both fixtures below, in the same test: (a) T-0408 attempt 3's shape -- a board-run branch
 * (`feature/T-0408` @ 47b787ed) whose diff carries `.claude/agents/planner.md` and
 * `.claude/rules/planner.md`, written from inside the run -- DENIED. (b) the driver's out-of-band
 * branch (`docs/planner-card-body-ownership` @ 97ec3ca3, PR #415) -- the same two files, same kind
 * of content, produced outside any board run -- ALLOWED.
 */
describe("checkClaudeDirWriteGuard", () => {
  const T0408_FIXTURE_CHANGED_PATHS = [
    "tasks/T-0408.md",
    ".claude/agents/planner.md",
    ".claude/rules/planner.md"
  ];

  const PLANNER_OWNERSHIP_FIXTURE_CHANGED_PATHS = [
    ".claude/agents/planner.md",
    ".claude/rules/planner.md",
    "docs/decision-log.md"
  ];

  it("(a) DENIES the T-0408 shape when branchOrigin is board-run", () => {
    const report = checkClaudeDirWriteGuard({
      changedPaths: T0408_FIXTURE_CHANGED_PATHS,
      branchOrigin: "board-run"
    });
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.file)).toEqual([
      ".claude/agents/planner.md",
      ".claude/rules/planner.md"
    ]);
  });

  it("(b) ALLOWS the docs/planner-card-body-ownership shape when branchOrigin is out-of-band, even though the exact same files changed", () => {
    const report = checkClaudeDirWriteGuard({
      changedPaths: PLANNER_OWNERSHIP_FIXTURE_CHANGED_PATHS,
      branchOrigin: "out-of-band"
    });
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("proves path alone is the wrong key: the out-of-band fixture's files WOULD be flagged if branchOrigin were (wrongly) board-run", () => {
    const report = checkClaudeDirWriteGuard({
      changedPaths: PLANNER_OWNERSHIP_FIXTURE_CHANGED_PATHS,
      branchOrigin: "board-run"
    });
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.file)).toEqual([
      ".claude/agents/planner.md",
      ".claude/rules/planner.md"
    ]);
  });

  it("is a no-op for a diff that never touches .claude/, regardless of branchOrigin", () => {
    expect(
      checkClaudeDirWriteGuard({ changedPaths: ["tools/board/src/thing.js"], branchOrigin: "board-run" }).ok
    ).toBe(true);
    expect(
      checkClaudeDirWriteGuard({ changedPaths: ["tools/board/src/thing.js"], branchOrigin: "out-of-band" })
        .ok
    ).toBe(true);
  });

  it("defaults to no violations when branchOrigin is missing or unrecognized -- fail-open here is deliberate: an unknown caller is not the board-run pipeline this guard exists to police", () => {
    expect(checkClaudeDirWriteGuard({ changedPaths: T0408_FIXTURE_CHANGED_PATHS }).ok).toBe(true);
    expect(
      checkClaudeDirWriteGuard({ changedPaths: T0408_FIXTURE_CHANGED_PATHS, branchOrigin: "bogus" }).ok
    ).toBe(true);
  });

  it("flags .claude/settings.json too, not just agents/rules", () => {
    const report = checkClaudeDirWriteGuard({
      changedPaths: [".claude/settings.json"],
      branchOrigin: "board-run"
    });
    expect(report.ok).toBe(false);
  });

  it("does not flag a path that only looks like the directory", () => {
    const report = checkClaudeDirWriteGuard({
      changedPaths: ["docs/notes-on-.claude.md", "my.claude/notes.md"],
      branchOrigin: "board-run"
    });
    expect(report.ok).toBe(true);
  });

  it("defaults changedPaths to empty and never throws on missing input", () => {
    expect(() => checkClaudeDirWriteGuard({ branchOrigin: "board-run" })).not.toThrow();
    expect(checkClaudeDirWriteGuard({ branchOrigin: "board-run" }).ok).toBe(true);
  });
});
