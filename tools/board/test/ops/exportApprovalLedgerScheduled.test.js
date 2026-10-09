import { describe, it, expect, vi } from "vitest";
import {
  resolveConfig,
  runLedgerExport,
  EXIT_CODE_OK,
  EXIT_CODE_EXPORT_FAILED,
  EXIT_CODE_GIT_FAILED
} from "../../ops/exportApprovalLedgerScheduled.js";

/**
 * T-0434: the host-side scheduled job that actually runs `exportApprovalLedger.js` on a timer
 * and commits+pushes the result to `develop` -- the missing half of the fix. `#440`/`#439` were
 * blocked because nothing regenerates `tools/board/approval-ledger.json` on `develop` except a
 * human remembering to, or a PASS landing on some OTHER card's branch (`approvalLedgerRegen.js`,
 * which only ever writes into that card's own worktree).
 *
 * Every I/O boundary (git, the filesystem, the exporter subprocess) is injected here, exactly the
 * pattern `test/ops/vetAndReady.test.js` already uses, so this suite never spawns a real `git`
 * process or touches a real file.
 */

const LEDGER_ABS_PATH = "/repo/tools/board/approval-ledger.json";
const LEDGER_REL_PATH = "tools/board/approval-ledger.json";

function makeLedger(cards, generated_at = "2026-10-01T00:00:00.000Z") {
  return { version: 1, generated_at, cards };
}

/** A git(args) stub keyed off args[0] (the git subcommand) so each test only overrides what it needs. */
function makeGit(overrides = {}) {
  return vi.fn(async (cmd, args) => {
    if (cmd !== "git") throw new Error(`unexpected exec: ${cmd} ${args?.join(" ")}`);
    const sub = args.find((a) => !a.startsWith("-") && a !== "-C" && a !== "/repo");
    if (overrides[sub]) return overrides[sub](args);
    if (sub === "rev-parse" && args.includes("--abbrev-ref")) return { stdout: "develop\n", stderr: "" };
    if (sub === "rev-parse") return { stdout: "aaaaaaa\n", stderr: "" };
    if (sub === "status") return { stdout: "", stderr: "" };
    if (sub === "fetch") return { stdout: "", stderr: "" };
    if (sub === "add") return { stdout: "", stderr: "" };
    if (sub === "commit") return { stdout: "", stderr: "" };
    if (sub === "push") return { stdout: "", stderr: "" };
    throw new Error(`unstubbed git subcommand: ${sub}`);
  });
}

function makeDeps({
  git = makeGit(),
  exportResult = { exitCode: 0, tmpContent: JSON.stringify(makeLedger([{ id: "T-0001", requires_approval: false, approved_by: null, approved_at: null }])) },
  existingLedger = null
} = {}) {
  const execFileFn = vi.fn(async (cmd, args, opts) => {
    if (cmd === "node") {
      if (exportResult.exitCode !== 0) {
        const err = new Error("exporter failed");
        err.stderr = exportResult.stderr || "exportApprovalLedger: the task store returned no cards";
        throw err;
      }
      // Simulate the real exporter: it writes the tmp path itself.
      const tmpPath = args[1];
      await deps_writeFileFn(tmpPath, exportResult.tmpContent, "utf8");
      return { stdout: "", stderr: "" };
    }
    return git(cmd, args, opts);
  });

  const files = new Map();
  if (existingLedger) files.set(LEDGER_ABS_PATH, JSON.stringify(existingLedger));

  async function deps_writeFileFn(p, content) {
    files.set(p, content);
  }

  const readFileFn = vi.fn(async (p) => {
    if (!files.has(p)) {
      const err = new Error(`ENOENT: ${p}`);
      err.code = "ENOENT";
      throw err;
    }
    return files.get(p);
  });
  const renameFn = vi.fn(async (from, to) => {
    files.set(to, files.get(from));
    files.delete(from);
  });
  const unlinkFn = vi.fn(async (p) => {
    files.delete(p);
  });
  const mkdirFn = vi.fn(async () => {});
  const writeFileFn = vi.fn(async (p, content) => {
    files.set(p, content);
  });
  const appendFileFn = vi.fn(async () => {});
  const logFn = vi.fn();

  return { execFileFn, readFileFn, renameFn, unlinkFn, mkdirFn, writeFileFn, appendFileFn, logFn, files };
}

describe("resolveConfig", () => {
  it("defaults to develop, origin, a 12h refresh threshold, and the shared ledger path", () => {
    const config = resolveConfig({ BOARD_REPO_ROOT: "/repo" });
    expect(config.branch).toBe("develop");
    expect(config.remote).toBe("origin");
    expect(config.refreshThresholdHours).toBe(12);
    expect(config.ledgerRelativePath).toBe(LEDGER_REL_PATH);
    expect(config.repoRoot).toBe("/repo");
  });

  it("honors env overrides", () => {
    const config = resolveConfig({
      BOARD_REPO_ROOT: "/repo",
      BOARD_LEDGER_EXPORT_BRANCH: "main",
      BOARD_LEDGER_EXPORT_REMOTE: "upstream",
      BOARD_LEDGER_REFRESH_THRESHOLD_HOURS: "6"
    });
    expect(config.branch).toBe("main");
    expect(config.remote).toBe("upstream");
    expect(config.refreshThresholdHours).toBe(6);
  });

  it("defaults the exporter subprocess's task store to db -- the live board's own mode", () => {
    const config = resolveConfig({ BOARD_REPO_ROOT: "/repo" });
    expect(config.taskStoreKind).toBe("db");
  });

  it("honors an explicit BOARD_TASK_STORE override", () => {
    const config = resolveConfig({ BOARD_REPO_ROOT: "/repo", BOARD_TASK_STORE: "fs" });
    expect(config.taskStoreKind).toBe("fs");
  });
});

describe("runLedgerExport", () => {
  it("skips without touching git further when the checkout is not on the target branch", async () => {
    const git = makeGit({ "rev-parse": () => ({ stdout: "feature/T-9999\n", stderr: "" }) });
    const deps = makeDeps({ git });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.reason).toBe("wrong-branch");
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.[0] === "fetch")).toBe(false);
    expect(deps.renameFn).not.toHaveBeenCalled();
  });

  it("skips when the working tree has changes outside the ledger file", async () => {
    const git = makeGit({ status: () => ({ stdout: " M src/server/index.js\n", stderr: "" }) });
    const deps = makeDeps({ git });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.reason).toBe("working-tree-dirty");
    expect(deps.renameFn).not.toHaveBeenCalled();
  });

  it("proceeds when the only dirty path is the ledger file itself", async () => {
    const git = makeGit({ status: () => ({ stdout: ` M ${LEDGER_REL_PATH}\n`, stderr: "" }) });
    const deps = makeDeps({ git, existingLedger: null });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.reason).not.toBe("working-tree-dirty");
    expect(result.exitCode).toBe(EXIT_CODE_OK);
  });

  it("does not treat the always-untracked worktrees/ directory as foreign dirt", async () => {
    // Every card's own implementation work happens in a sibling checkout under worktrees/, and
    // nothing in .gitignore/info-exclude hides that directory from the shared checkout this job
    // runs against -- `git status --porcelain` reports it as `?? worktrees/` on every run,
    // regardless of whether a card run is active. Treating that line as foreign dirt would make
    // this job skip forever, which is exactly the bug a prior review round caught.
    const git = makeGit({ status: () => ({ stdout: "?? worktrees/\n", stderr: "" }) });
    const deps = makeDeps({ git, existingLedger: null });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.reason).not.toBe("working-tree-dirty");
    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(deps.renameFn).toHaveBeenCalledTimes(1);
  });

  it("still skips on a genuinely untracked path outside worktrees/", async () => {
    const git = makeGit({ status: () => ({ stdout: "?? scratch-notes.txt\n", stderr: "" }) });
    const deps = makeDeps({ git });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.reason).toBe("working-tree-dirty");
    expect(deps.renameFn).not.toHaveBeenCalled();
  });

  it("fails loudly when the remote fetch itself fails", async () => {
    const git = makeGit({
      fetch: () => {
        throw new Error("could not resolve host");
      }
    });
    const deps = makeDeps({ git });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_GIT_FAILED);
    expect(result.reason).toBe("fetch-failed");
    expect(deps.renameFn).not.toHaveBeenCalled();
  });

  it("skips without writing when local HEAD has diverged from the remote branch", async () => {
    let call = 0;
    const git = makeGit({
      "rev-parse": (args) => {
        if (args.includes("--abbrev-ref")) return { stdout: "develop\n", stderr: "" };
        call += 1;
        return { stdout: call === 1 ? "aaaaaaa\n" : "bbbbbbb\n", stderr: "" };
      }
    });
    const deps = makeDeps({ git });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.reason).toBe("not-in-sync-with-remote");
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("push"))).toBe(false);
  });

  it("reports export failure and never commits when the exporter subprocess fails (e.g. the DB is unreachable)", async () => {
    const deps = makeDeps({ exportResult: { exitCode: 1, stderr: "DB unreachable" } });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_EXPORT_FAILED);
    expect(result.reason).toBe("export-failed");
    expect(deps.renameFn).not.toHaveBeenCalled();
    const commitCalls = deps.execFileFn.mock.calls.filter(([, args]) => args?.includes("commit"));
    expect(commitCalls).toHaveLength(0);
  });

  it("refuses an empty/invalid exported ledger even if the subprocess exits 0 -- never overwrites the real file", async () => {
    const deps = makeDeps({ exportResult: { exitCode: 0, tmpContent: JSON.stringify({ version: 1, generated_at: "x", cards: [] }) } });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_EXPORT_FAILED);
    expect(result.reason).toBe("export-produced-empty-ledger");
    expect(deps.renameFn).not.toHaveBeenCalled();
  });

  it("commits and pushes when no ledger is committed yet", async () => {
    const deps = makeDeps({ existingLedger: null });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.reason).toBe("cards-changed");
    expect(deps.renameFn).toHaveBeenCalledTimes(1);
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("add"))).toBe(true);
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("commit"))).toBe(true);
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("push"))).toBe(true);
  });

  it("skips the commit when the cards are unchanged and the ledger is still within the refresh threshold", async () => {
    const cards = [{ id: "T-0001", requires_approval: false, approved_by: null, approved_at: null }];
    const now = () => new Date("2026-10-08T12:00:00.000Z");
    const deps = makeDeps({
      existingLedger: makeLedger(cards, "2026-10-08T06:00:00.000Z"), // 6h old
      exportResult: { exitCode: 0, tmpContent: JSON.stringify(makeLedger(cards, "2026-10-08T12:00:00.000Z")) }
    });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now, ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.reason).toBe("fresh-no-change");
    expect(deps.renameFn).not.toHaveBeenCalled();
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("commit"))).toBe(false);
  });

  it("forces a commit when the cards are unchanged but the committed ledger crossed the refresh threshold", async () => {
    const cards = [{ id: "T-0001", requires_approval: false, approved_by: null, approved_at: null }];
    const now = () => new Date("2026-10-08T19:00:00.000Z");
    const deps = makeDeps({
      existingLedger: makeLedger(cards, "2026-10-08T06:00:00.000Z"), // 13h old -- past the 12h default
      exportResult: { exitCode: 0, tmpContent: JSON.stringify(makeLedger(cards, "2026-10-08T19:00:00.000Z")) }
    });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now, ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_OK);
    expect(result.reason).toBe("refresh-threshold");
    expect(deps.renameFn).toHaveBeenCalledTimes(1);
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("commit"))).toBe(true);
  });

  it("surfaces a push failure distinctly, after the commit already happened", async () => {
    const git = makeGit({
      push: () => {
        throw new Error("non-fast-forward");
      }
    });
    const deps = makeDeps({ git, existingLedger: null });

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    expect(result.exitCode).toBe(EXIT_CODE_GIT_FAILED);
    expect(result.reason).toBe("push-failed");
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("commit"))).toBe(true);
  });

  it("spawns the exporter at its real tools/board path, not a repo-root-relative guess", async () => {
    const deps = makeDeps({ existingLedger: null });

    await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    const nodeCall = deps.execFileFn.mock.calls.find(([cmd]) => cmd === "node");
    expect(nodeCall).toBeTruthy();
    const [, args] = nodeCall;
    // There is no `scripts/` directory at the repo root -- the real exporter lives at
    // tools/board/scripts/exportApprovalLedger.js. A repo-root-relative "scripts/..." guess
    // resolves against config.repoRoot (the repository root, not tools/board) and is ENOENT on
    // every real run, which this mock -- unlike a real subprocess -- would never catch.
    expect(args[0]).toBe("tools/board/scripts/exportApprovalLedger.js");
  });

  it("runs the exporter subprocess with BOARD_TASK_STORE=db by default, matching the live board", async () => {
    const deps = makeDeps({ existingLedger: null });

    await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now: () => new Date(), ...deps });

    const nodeCall = deps.execFileFn.mock.calls.find(([cmd]) => cmd === "node");
    expect(nodeCall).toBeTruthy();
    const [, , opts] = nodeCall;
    // The live board runs BOARD_TASK_STORE=db; committed tasks/*.md stops at T-0365. Leaving the
    // subprocess to its own fs-mode default would silently export a ledger missing every card
    // created since the cards-to-database cutover -- wrong, not just incomplete.
    expect(opts?.env?.BOARD_TASK_STORE).toBe("db");
  });

  it("honors an explicit BOARD_TASK_STORE override instead of forcing db", async () => {
    const deps = makeDeps({ existingLedger: null });

    await runLedgerExport({
      env: { BOARD_REPO_ROOT: "/repo", BOARD_TASK_STORE: "fs" },
      now: () => new Date(),
      ...deps
    });

    const nodeCall = deps.execFileFn.mock.calls.find(([cmd]) => cmd === "node");
    const [, , opts] = nodeCall;
    expect(opts?.env?.BOARD_TASK_STORE).toBe("fs");
  });

  it("writes a summary log on both the skip path and the commit path", async () => {
    const cards = [{ id: "T-0001", requires_approval: false, approved_by: null, approved_at: null }];
    const now = () => new Date("2026-10-08T12:00:00.000Z");
    const deps = makeDeps({
      existingLedger: makeLedger(cards, "2026-10-08T06:00:00.000Z"),
      exportResult: { exitCode: 0, tmpContent: JSON.stringify(makeLedger(cards, "2026-10-08T12:00:00.000Z")) }
    });

    await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now, ...deps });

    expect(deps.mkdirFn).toHaveBeenCalled();
    expect(deps.appendFileFn).toHaveBeenCalled();
    const historyCall = deps.appendFileFn.mock.calls[0];
    expect(historyCall[1]).toMatch(/fresh-no-change/);
  });
});
