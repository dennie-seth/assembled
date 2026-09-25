import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "../helpers/rmTemp.js";
import {
  checkAttemptCommitCadence,
  defaultIntroducingCommit,
  listEvidenceFiles,
  parseAttemptNumber
} from "../../src/lib/attemptCommitCadence.js";

/**
 * T-0396: the mechanical, checkable half of per-attempt commit cadence -- a reviewer/deliverable-
 * gate rule that fails a card whose attempt evidence frames were batched into one commit (the
 * exact T-0387 gap: three attempts, one commit, 22a2867, that reviewers noted but could not fail).
 * `recordAttempt` (attemptRecorder.js) is the generator-side mechanism that produces the right
 * commit shape in the first place; this is the independent, after-the-fact check that a reviewer
 * or `checkDeliverable.js` can run against whatever actually landed on the branch.
 */

describe("parseAttemptNumber", () => {
  it("extracts the attempt number from the attempt_<N>_ naming convention", () => {
    expect(parseAttemptNumber("attempt_1_main_1024.png")).toBe(1);
    expect(parseAttemptNumber("attempt_12_crop.png")).toBe(12);
  });

  it("returns null for a filename that does not follow the convention", () => {
    expect(parseAttemptNumber("main_1024.png")).toBeNull();
    expect(parseAttemptNumber("attempt_1.png")).toBeNull();
    expect(parseAttemptNumber("README.md")).toBeNull();
  });
});

describe("checkAttemptCommitCadence (unit, injected introducingCommit)", () => {
  function file(filename) {
    return { filename, path: `/evidence/${filename}` };
  }

  it("is not applicable when there are no attempt-numbered files", async () => {
    const result = await checkAttemptCommitCadence({
      evidenceFiles: [file("README.md")],
      introducingCommit: async () => "sha"
    });
    expect(result.applicable).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("is applicable but trivially ok for a single attempt (nothing to compare against)", async () => {
    const result = await checkAttemptCommitCadence({
      evidenceFiles: [file("attempt_1_main.png"), file("attempt_1_crop.png")],
      introducingCommit: async () => "sha-1"
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("passes when each attempt's files were introduced in a distinct commit", async () => {
    const commits = { "attempt_1_main.png": "sha-1", "attempt_2_main.png": "sha-2", "attempt_3_main.png": "sha-3" };
    const result = await checkAttemptCommitCadence({
      evidenceFiles: [file("attempt_1_main.png"), file("attempt_2_main.png"), file("attempt_3_main.png")],
      introducingCommit: async (p) => commits[path.basename(p)]
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when two different attempts' files share the same introducing commit (the T-0387 shape)", async () => {
    const result = await checkAttemptCommitCadence({
      evidenceFiles: [file("attempt_1_main.png"), file("attempt_2_main.png"), file("attempt_3_main.png")],
      introducingCommit: async () => "sha-batched"
    });
    expect(result.ok).toBe(false);
    expect(result.applicable).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/attempt 1 and attempt 2/);
  });

  it("names every offending pair, not just the first", async () => {
    const result = await checkAttemptCommitCadence({
      evidenceFiles: [file("attempt_1_main.png"), file("attempt_2_main.png"), file("attempt_3_main.png")],
      introducingCommit: async () => "sha-batched"
    });
    expect(result.errors).toHaveLength(3); // (1,2) (1,3) (2,3)
  });

  it("tolerates a file with no introducing commit (never actually landed) without crashing", async () => {
    const result = await checkAttemptCommitCadence({
      evidenceFiles: [file("attempt_1_main.png"), file("attempt_2_main.png")],
      introducingCommit: async () => null
    });
    expect(result.ok).toBe(true);
  });

  it("does not flag two files within the SAME attempt sharing a commit (expected: one attempt, one commit, multiple files)", async () => {
    const result = await checkAttemptCommitCadence({
      evidenceFiles: [file("attempt_1_main.png"), file("attempt_1_crop_a.png"), file("attempt_1_crop_b.png")],
      introducingCommit: async () => "sha-1"
    });
    expect(result.ok).toBe(true);
  });
});

describe("listEvidenceFiles / defaultIntroducingCommit (real git integration)", () => {
  let repo;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "board-attemptcadence-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
    await fs.writeFile(path.join(repo, "README.md"), "x");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
  });

  afterEach(async () => {
    await rmTemp(repo);
  });

  it("listEvidenceFiles returns an empty array for a missing directory", async () => {
    expect(await listEvidenceFiles(path.join(repo, "docs/assets/evidence/T-0000"))).toEqual([]);
  });

  it("listEvidenceFiles lists the files actually present in the evidence directory", async () => {
    const dir = path.join(repo, "docs/assets/evidence/T-0396");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "attempt_1_main.png"), "a");
    await fs.writeFile(path.join(dir, "README.md"), "b");

    const files = await listEvidenceFiles(dir);
    expect(files.map((f) => f.filename).sort()).toEqual(["README.md", "attempt_1_main.png"]);
  });

  it("defaultIntroducingCommit finds the earliest commit that added a given path", async () => {
    const dir = path.join(repo, "docs/assets/evidence/T-0396");
    await fs.mkdir(dir, { recursive: true });
    const framePath = path.join(dir, "attempt_1_main.png");
    await fs.writeFile(framePath, "frame");
    execFileSync("git", ["-C", repo, "add", framePath]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "attempt 1 evidence"]);

    const sha = await defaultIntroducingCommit(repo, framePath);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(sha).toBe(head);
  });

  it("defaultIntroducingCommit returns null for a path never added to git", async () => {
    const framePath = path.join(repo, "docs/assets/evidence/T-0396/never_committed.png");
    expect(await defaultIntroducingCommit(repo, framePath)).toBeNull();
  });

  it("end to end: two attempts batched into one real commit fails the cadence check", async () => {
    const dir = path.join(repo, "docs/assets/evidence/T-0396");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "attempt_1_main.png"), "1");
    await fs.writeFile(path.join(dir, "attempt_2_main.png"), "2");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "attempts 1 and 2, batched (the T-0387 bug)"]);

    const result = await checkAttemptCommitCadence({
      evidenceFiles: await listEvidenceFiles(dir),
      introducingCommit: (p) => defaultIntroducingCommit(repo, p)
    });

    expect(result.ok).toBe(false);
  });

  it("end to end: two attempts committed separately pass the cadence check", async () => {
    const dir = path.join(repo, "docs/assets/evidence/T-0396");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "attempt_1_main.png"), "1");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "attempt 1"]);
    await fs.writeFile(path.join(dir, "attempt_2_main.png"), "2");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "attempt 2"]);

    const result = await checkAttemptCommitCadence({
      evidenceFiles: await listEvidenceFiles(dir),
      introducingCommit: (p) => defaultIntroducingCommit(repo, p)
    });

    expect(result.ok).toBe(true);
  });
});
