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
  existingLedger = null,
  readCommittedLedgerFn
} = {}) {
  const execFileFn = vi.fn(async (cmd, args, opts) => {
    if (cmd === "node") {
      const tmpPath = args[1];
      if (exportResult.exitCode !== 0) {
        // A real exporter that dies partway through can still have written something to the
        // tmp path before exiting non-zero -- simulate that here so a test asserting the tmp
        // path is gone after a failed run is actually exercising the cleanup, not just observing
        // that nothing was ever there.
        if (exportResult.partialTmpContent !== undefined) {
          await deps_writeFileFn(tmpPath, exportResult.partialTmpContent, "utf8");
        }
        const err = new Error("exporter failed");
        err.stderr = exportResult.stderr || "exportApprovalLedger: the task store returned no cards";
        throw err;
      }
      // Simulate the real exporter: it writes the tmp path itself.
      await deps_writeFileFn(tmpPath, exportResult.tmpContent, "utf8");
      return { stdout: "", stderr: "" };
    }
    return git(cmd, args, opts);
  });

  const files = new Map();

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
  // Defaults to "the committed ledger is `existingLedger`" -- the semantics every existing test
  // already relies on (the param name predates T-0434's fix-round move from reading the
  // working-tree file to reading `git show HEAD:<path>`, but the meaning -- "what HEAD currently
  // has committed" -- was always what these tests meant by it). Tests proving the committed-vs-
  // working-tree distinction itself override this function directly.
  const resolvedReadCommittedLedgerFn = readCommittedLedgerFn || (async () => existingLedger);

  return {
    execFileFn,
    readFileFn,
    renameFn,
    unlinkFn,
    mkdirFn,
    writeFileFn,
    appendFileFn,
    logFn,
    files,
    readCommittedLedgerFn: resolvedReadCommittedLedgerFn
  };
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

  it("does not leave the temp file behind after a failed export -- a transient failure must not disable every later run", async () => {
    // A prior round only unlinked the tmp file on the "unreadable/invalid" and "empty cards"
    // branches, never on the exporter-subprocess-failure branch itself. The temp file (at a
    // fixed, timestamp-based path under `now().getTime()`) then sat as untracked working-tree
    // dirt, which the very next run's preflight reads as "a run or other work may be in
    // progress" -- `working-tree-dirty` forever, from a single transient failure.
    const now = () => new Date("2026-10-09T00:00:00.000Z");
    const failingDeps = makeDeps({
      exportResult: { exitCode: 1, stderr: "DB unreachable", partialTmpContent: '{"version": 1, "cards": [' }
    });

    const run1 = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now, ...failingDeps });

    expect(run1.exitCode).toBe(EXIT_CODE_EXPORT_FAILED);
    const tmpPath = `${LEDGER_ABS_PATH}.tmp-${now().getTime()}`;
    expect(failingDeps.files.has(tmpPath)).toBe(false);

    // Run 2: same shared file-backed "disk" (failingDeps.files), now against a healthy exporter.
    // If run 1's tmp file had survived, run 2's `git status --porcelain` (stubbed below to report
    // it) would read as foreign dirt and skip -- proving the leak, not just asserting it away.
    const git = makeGit({
      status: () => {
        const leaked = [...failingDeps.files.keys()].some((p) => p.includes(".tmp-"));
        return { stdout: leaked ? `?? ${tmpPath}\n` : "", stderr: "" };
      }
    });
    const healthyDeps = makeDeps({ git, existingLedger: null });
    healthyDeps.files.clear();
    for (const [k, v] of failingDeps.files) healthyDeps.files.set(k, v);

    const run2 = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now, ...healthyDeps });

    expect(run2.reason).not.toBe("working-tree-dirty");
    expect(run2.exitCode).toBe(EXIT_CODE_OK);
    expect(healthyDeps.renameFn).toHaveBeenCalledTimes(1);
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

  it("decides freshness from the committed ledger (HEAD), never an uncommitted working-tree copy", async () => {
    // The preflight explicitly allows the ledger FILE itself to be the one dirty path (see
    // "proceeds when the only dirty path is the ledger file itself" above) -- so a fresh,
    // uncommitted copy can legitimately be sitting in the working tree while HEAD still carries a
    // genuinely stale one. Reading that working-tree copy for the freshness decision would call
    // this `fresh-no-change` and never publish -- recreating the exact staleness this card exists
    // to end, inside the very check meant to catch it.
    const cards = [{ id: "T-0001", requires_approval: false, approved_by: null, approved_at: null }];
    const now = () => new Date("2026-10-08T19:00:00.000Z");
    const staleCommitted = makeLedger(cards, "2026-10-08T06:00:00.000Z"); // 13h old at HEAD -- past the 12h threshold
    const freshUncommitted = makeLedger(cards, "2026-10-08T18:59:00.000Z"); // 1 minute old, but never committed

    const deps = makeDeps({
      readCommittedLedgerFn: async () => staleCommitted,
      exportResult: { exitCode: 0, tmpContent: JSON.stringify(makeLedger(cards, "2026-10-08T19:00:00.000Z")) }
    });
    // Seed the working-tree file with the FRESH copy a buggy "read the file on disk" approach
    // would consult instead of HEAD -- proving the decision never looks at this.
    deps.files.set(LEDGER_ABS_PATH, JSON.stringify(freshUncommitted));

    const result = await runLedgerExport({ env: { BOARD_REPO_ROOT: "/repo" }, now, ...deps });

    expect(result.reason).not.toBe("fresh-no-change");
    expect(result.reason).toBe("refresh-threshold");
    expect(deps.renameFn).toHaveBeenCalledTimes(1);
    expect(deps.execFileFn.mock.calls.some(([, args]) => args?.includes("commit"))).toBe(true);
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
