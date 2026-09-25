import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "../helpers/rmTemp.js";
import {
  AttemptCommitError,
  appendAttemptLogRow,
  buildAttemptLogRow,
  commitAttemptEvidence,
  mergeRunIdIntoProvenance,
  readAttemptLog,
  recordAttempt,
  resolveRunId,
  writeAttemptProvenance
} from "../../src/lib/attemptRecorder.js";

/**
 * T-0396: the shared per-attempt helper asset-generation cards use so a committed frame
 * always traces back to the run log that produced it (a run id in every provenance sidecar
 * and attempt-log row), and so per-attempt commit cadence is mechanical rather than left to
 * agent discipline -- T-0387 put all three of its attempts' evidence into one commit
 * (22a2867) and reviewers could not fail it after the fact; `recordAttempt` makes that
 * impossible by construction: one call, one attempt, one commit.
 */

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-attemptrecorder-"));
});

afterEach(async () => {
  await rmTemp(tmpDir);
});

function git(repo, ...args) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

function initRepo(repo) {
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
}

function headSha(repo) {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function commitCount(repo) {
  return Number(execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
}

describe("resolveRunId", () => {
  it("reads BOARD_RUN_ID from the given env object", () => {
    expect(resolveRunId({ BOARD_RUN_ID: "T-0396-run" })).toBe("T-0396-run");
  });

  it("returns null when BOARD_RUN_ID is absent", () => {
    expect(resolveRunId({})).toBeNull();
  });

  it("returns null when BOARD_RUN_ID is an empty string", () => {
    expect(resolveRunId({ BOARD_RUN_ID: "" })).toBeNull();
  });

  it("defaults to process.env when no env object is given", () => {
    const original = process.env.BOARD_RUN_ID;
    process.env.BOARD_RUN_ID = "T-0001-run";
    try {
      expect(resolveRunId()).toBe("T-0001-run");
    } finally {
      if (original === undefined) delete process.env.BOARD_RUN_ID;
      else process.env.BOARD_RUN_ID = original;
    }
  });
});

describe("buildAttemptLogRow / appendAttemptLogRow / readAttemptLog", () => {
  it("builds a row carrying the run id, attempt number, status, frame path, and a timestamp", () => {
    const now = () => new Date("2026-09-25T00:00:00.000Z");
    const row = buildAttemptLogRow({ attempt: 1, status: "completed", framePath: "frame_1.png", runId: "T-run", now });
    expect(row).toEqual({
      attempt: 1,
      run_id: "T-run",
      status: "completed",
      frame_path: "frame_1.png",
      timestamp: "2026-09-25T00:00:00.000Z"
    });
  });

  it("records an explicit null run_id rather than omitting the field when no run id is given", () => {
    const row = buildAttemptLogRow({ attempt: 1, status: "no_frame" });
    expect(row).toHaveProperty("run_id", null);
  });

  it("appends one NDJSON line per call, in order, without clobbering prior rows", async () => {
    const logPath = path.join(tmpDir, "gen.attempt-log.jsonl");
    await appendAttemptLogRow(logPath, { attempt: 1, status: "completed", runId: "r1" });
    await appendAttemptLogRow(logPath, { attempt: 2, status: "completed", runId: "r1" });
    const rows = await readAttemptLog(logPath);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("creates the parent directory if it does not exist yet", async () => {
    const logPath = path.join(tmpDir, "nested", "dir", "gen.attempt-log.jsonl");
    await appendAttemptLogRow(logPath, { attempt: 1, status: "completed", runId: "r1" });
    expect(await readAttemptLog(logPath)).toHaveLength(1);
  });

  it("records status 'no_frame' with a null frame_path for an attempt that produced no output", async () => {
    const logPath = path.join(tmpDir, "gen.attempt-log.jsonl");
    const row = await appendAttemptLogRow(logPath, { attempt: 1, status: "no_frame", runId: "r1" });
    expect(row.frame_path).toBeNull();
    expect(row.status).toBe("no_frame");
  });

  it("readAttemptLog returns an empty array for a missing file", async () => {
    expect(await readAttemptLog(path.join(tmpDir, "nope.jsonl"))).toEqual([]);
  });
});

describe("mergeRunIdIntoProvenance / writeAttemptProvenance", () => {
  it("adds run_id to a plain record, preserving every other field", () => {
    const merged = mergeRunIdIntoProvenance({ model: "sd_xl", seed: 42 }, "T-run");
    expect(merged).toEqual({ model: "sd_xl", seed: 42, run_id: "T-run" });
  });

  it("overwrites a smuggled run_id on the input record rather than trusting it", () => {
    const merged = mergeRunIdIntoProvenance({ model: "sd_xl", run_id: "fake" }, "T-real");
    expect(merged.run_id).toBe("T-real");
  });

  it("records an explicit null run_id when none is given", () => {
    const merged = mergeRunIdIntoProvenance({ model: "sd_xl" }, undefined);
    expect(merged).toHaveProperty("run_id", null);
  });

  it("does not mutate the input record", () => {
    const record = { model: "sd_xl" };
    mergeRunIdIntoProvenance(record, "T-run");
    expect(record).toEqual({ model: "sd_xl" });
  });

  it("writes pretty-printed JSON with a trailing newline", async () => {
    const sidecarPath = path.join(tmpDir, "sheet.provenance.json");
    await writeAttemptProvenance(sidecarPath, { model: "sd_xl", seed: 1 }, { runId: "T-run" });
    const text = await fs.readFile(sidecarPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ model: "sd_xl", seed: 1, run_id: "T-run" });
  });

  it("creates the parent directory for the sidecar if needed", async () => {
    const sidecarPath = path.join(tmpDir, "nested", "sheet.provenance.json");
    await writeAttemptProvenance(sidecarPath, { model: "sd_xl" }, { runId: "T-run" });
    expect(JSON.parse(await fs.readFile(sidecarPath, "utf8")).run_id).toBe("T-run");
  });
});

describe("commitAttemptEvidence", () => {
  let repo;

  beforeEach(async () => {
    repo = tmpDir;
    initRepo(repo);
    await fs.writeFile(path.join(repo, "README.md"), "x");
    git(repo, "add", "README.md");
    git(repo, "commit", "-qm", "init");
  });

  it("commits exactly the given paths as a new commit and returns its sha", async () => {
    const before = headSha(repo);
    const frame = path.join(repo, "frame_1.png");
    await fs.writeFile(frame, "data");
    const sha = await commitAttemptEvidence({ repoRoot: repo, paths: [frame], message: "attempt 1", runId: "T-run" });
    expect(sha).toBe(headSha(repo));
    expect(sha).not.toBe(before);
  });

  it("embeds the run id in the commit message as a trailer", async () => {
    const frame = path.join(repo, "frame_1.png");
    await fs.writeFile(frame, "data");
    await commitAttemptEvidence({ repoRoot: repo, paths: [frame], message: "attempt 1", runId: "T-run-xyz" });
    const log = execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" });
    expect(log).toContain("T-run-xyz");
  });

  it("omits the trailer entirely when no run id is given", async () => {
    const frame = path.join(repo, "frame_1.png");
    await fs.writeFile(frame, "data");
    await commitAttemptEvidence({ repoRoot: repo, paths: [frame], message: "attempt 1", runId: null });
    const log = execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" });
    expect(log).not.toContain("Run-Id");
  });

  it("throws AttemptCommitError when given no paths", async () => {
    await expect(
      commitAttemptEvidence({ repoRoot: repo, paths: [], message: "nothing", runId: "r" })
    ).rejects.toBeInstanceOf(AttemptCommitError);
  });

  it("only commits the given paths, leaving unrelated untracked files alone", async () => {
    await fs.writeFile(path.join(repo, "unrelated.txt"), "stays untracked");
    const frame = path.join(repo, "frame_1.png");
    await fs.writeFile(frame, "data");
    await commitAttemptEvidence({ repoRoot: repo, paths: [frame], message: "attempt 1", runId: "r" });
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    expect(status).toContain("unrelated.txt");
    expect(status).not.toContain("frame_1.png");
  });
});

describe("recordAttempt: the orchestrating helper", () => {
  let repo;

  beforeEach(async () => {
    repo = tmpDir;
    initRepo(repo);
    await fs.writeFile(path.join(repo, "README.md"), "x");
    git(repo, "add", "README.md");
    git(repo, "commit", "-qm", "init");
  });

  function framePaths(cardId, attempt) {
    const framePath = path.join(repo, `docs/assets/evidence/${cardId}/attempt_${attempt}_main.png`);
    const sidecarPath = framePath.replace(/\.png$/, ".provenance.json");
    return { framePath, sidecarPath };
  }

  it("a simulated 3-attempt run produces three distinct evidence commits, each carrying its run id", async () => {
    const logPath = path.join(repo, "gen.attempt-log.jsonl");
    const shas = [];
    for (const attempt of [1, 2, 3]) {
      const { framePath, sidecarPath } = framePaths("T-0396", attempt);
      await fs.mkdir(path.dirname(framePath), { recursive: true });
      await fs.writeFile(framePath, `frame ${attempt}`);
      const result = await recordAttempt({
        repoRoot: repo,
        attempt,
        logPath,
        commitMessage: `T-0396 attempt ${attempt} evidence`,
        framePath,
        sidecarPath,
        sidecarRecord: { model: "sd_xl", seed: attempt },
        runId: "T-0396-2026-09-25T00-00-00-000Z"
      });
      shas.push(result.commitSha);
    }

    expect(new Set(shas).size).toBe(3);
    const rows = await readAttemptLog(logPath);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.run_id === "T-0396-2026-09-25T00-00-00-000Z")).toBe(true);
  });

  it("a run interrupted after attempt 2 leaves only attempts 1 and 2 committed", async () => {
    const logPath = path.join(repo, "gen.attempt-log.jsonl");
    for (const attempt of [1, 2]) {
      const { framePath, sidecarPath } = framePaths("T-0396", attempt);
      await fs.mkdir(path.dirname(framePath), { recursive: true });
      await fs.writeFile(framePath, `frame ${attempt}`);
      await recordAttempt({
        repoRoot: repo,
        attempt,
        logPath,
        commitMessage: `attempt ${attempt}`,
        framePath,
        sidecarPath,
        sidecarRecord: { model: "sd_xl" },
        runId: "T-run"
      });
    }
    // attempt 3 "crashes" -- recordAttempt is simply never called for it, so nothing partial lands.

    const rows = await readAttemptLog(logPath);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    const log = execFileSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain("attempt 1");
    expect(log).toContain("attempt 2");
    expect(log).not.toContain("attempt 3");
    await expect(fs.access(framePaths("T-0396", 3).framePath)).rejects.toThrow();
  });

  it("a dry run writes nothing and commits nothing, even with a run id present", async () => {
    const logPath = path.join(repo, "gen.attempt-log.jsonl");
    const before = headSha(repo);

    const result = await recordAttempt({
      repoRoot: repo,
      attempt: 1,
      logPath,
      commitMessage: "attempt 1",
      framePath: null,
      dryRun: true,
      runId: "T-run"
    });

    expect(result.committed).toBe(false);
    expect(result.commitSha).toBeNull();
    await expect(fs.access(logPath)).rejects.toThrow();
    expect(headSha(repo)).toBe(before);
  });

  it("an attempt that produces no frame is still logged with its run id, and commits no frame file", async () => {
    const logPath = path.join(repo, "gen.attempt-log.jsonl");

    const result = await recordAttempt({
      repoRoot: repo,
      attempt: 1,
      logPath,
      commitMessage: "attempt 1 -- generation failed, gate refused",
      framePath: null,
      runId: "T-run"
    });

    expect(result.frameCommitted).toBe(false);
    const rows = await readAttemptLog(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe("T-run");
    expect(rows[0].frame_path).toBeNull();
    const log = execFileSync("git", ["-C", repo, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" });
    expect(log).toContain("attempt-log.jsonl");
    expect(log).not.toContain(".png");
  });

  it("a single-attempt run produces exactly one commit", async () => {
    const before = commitCount(repo);
    const logPath = path.join(repo, "gen.attempt-log.jsonl");
    const { framePath, sidecarPath } = framePaths("T-0396", 1);
    await fs.mkdir(path.dirname(framePath), { recursive: true });
    await fs.writeFile(framePath, "data");

    await recordAttempt({
      repoRoot: repo,
      attempt: 1,
      logPath,
      commitMessage: "attempt 1",
      framePath,
      sidecarPath,
      sidecarRecord: { model: "sd_xl" },
      runId: "T-run"
    });

    expect(commitCount(repo) - before).toBe(1);
  });

  it("writes the run id into the provenance sidecar", async () => {
    const logPath = path.join(repo, "gen.attempt-log.jsonl");
    const { framePath, sidecarPath } = framePaths("T-0396", 1);
    await fs.mkdir(path.dirname(framePath), { recursive: true });
    await fs.writeFile(framePath, "data");

    await recordAttempt({
      repoRoot: repo,
      attempt: 1,
      logPath,
      commitMessage: "attempt 1",
      framePath,
      sidecarPath,
      sidecarRecord: { model: "sd_xl" },
      runId: "T-sidecar-run"
    });

    const written = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    expect(written.run_id).toBe("T-sidecar-run");
  });

  it("degrades gracefully with no run id, recording an explicit null rather than fabricating one", async () => {
    const logPath = path.join(repo, "gen.attempt-log.jsonl");
    const { framePath, sidecarPath } = framePaths("T-0396", 1);
    await fs.mkdir(path.dirname(framePath), { recursive: true });
    await fs.writeFile(framePath, "data");

    const result = await recordAttempt({
      repoRoot: repo,
      attempt: 1,
      logPath,
      commitMessage: "attempt 1",
      framePath,
      sidecarPath,
      sidecarRecord: { model: "sd_xl" },
      runId: null
    });

    expect(result.runId).toBeNull();
    expect(result.committed).toBe(true);
    const written = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    expect(written.run_id).toBeNull();
    const rows = await readAttemptLog(logPath);
    expect(rows[0].run_id).toBeNull();
  });

  it("defaults runId to the environment (BOARD_RUN_ID) when not explicitly passed", async () => {
    const original = process.env.BOARD_RUN_ID;
    process.env.BOARD_RUN_ID = "T-0396-env-run";
    try {
      const logPath = path.join(repo, "gen.attempt-log.jsonl");
      const result = await recordAttempt({
        repoRoot: repo,
        attempt: 1,
        logPath,
        commitMessage: "attempt 1",
        framePath: null
      });
      expect(result.runId).toBe("T-0396-env-run");
    } finally {
      if (original === undefined) delete process.env.BOARD_RUN_ID;
      else process.env.BOARD_RUN_ID = original;
    }
  });

  it("a re-run on the same branch does not alter an earlier attempt's commit or recorded run id", async () => {
    const logPath = path.join(repo, "gen.attempt-log.jsonl");
    const attempt1 = framePaths("T-0396", 1);
    await fs.mkdir(path.dirname(attempt1.framePath), { recursive: true });
    await fs.writeFile(attempt1.framePath, "old");
    const first = await recordAttempt({
      repoRoot: repo,
      attempt: 1,
      logPath,
      commitMessage: "attempt 1",
      framePath: attempt1.framePath,
      sidecarPath: attempt1.sidecarPath,
      sidecarRecord: { model: "sd_xl" },
      runId: "T-old-run"
    });

    const attempt2 = framePaths("T-0396", 2);
    await fs.writeFile(attempt2.framePath, "new");
    await recordAttempt({
      repoRoot: repo,
      attempt: 2,
      logPath,
      commitMessage: "attempt 2",
      framePath: attempt2.framePath,
      sidecarPath: attempt2.sidecarPath,
      sidecarRecord: { model: "sd_xl" },
      runId: "T-new-run"
    });

    const rows = await readAttemptLog(logPath);
    expect(rows[0].run_id).toBe("T-old-run");
    expect(rows[1].run_id).toBe("T-new-run");
    const sidecar1 = JSON.parse(await fs.readFile(attempt1.sidecarPath, "utf8"));
    expect(sidecar1.run_id).toBe("T-old-run");
    const log = execFileSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain(first.commitSha.slice(0, 7));
  });
});
