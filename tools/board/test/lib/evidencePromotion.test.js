import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "../helpers/rmTemp.js";
import {
  DEFAULT_EVIDENCE_ROOT,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_RUN,
  parseCitedEvidencePaths,
  promoteEvidence
} from "../../src/lib/evidencePromotion.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

async function writeFile(root, rel, contents) {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return target;
}

async function readFile(root, rel) {
  return fs.readFile(path.join(root, rel));
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

let tmpDir;
let repoRoot;
let runDir;
let logPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-evidence-"));
  repoRoot = path.join(tmpDir, "repo");
  runDir = path.join(repoRoot, "assets", "out", "hybrid_profile");
  logPath = path.join(repoRoot, "assets", "src", "character", "ARM_HYBRID_ATTEMPT_LOG_T9999.md");
  await fs.mkdir(repoRoot, { recursive: true });
});

afterEach(async () => {
  await rmTemp(tmpDir);
});

describe("parseCitedEvidencePaths", () => {
  it("extracts run-relative image paths cited in inline code spans, in first-seen order, deduped", () => {
    const text = [
      "Round 3's decisive frame was `attempt_14/main_384.png`, conditioned on",
      "`pose_skeleton_384.png`. Attempt 14 is re-confirmed later at",
      "`attempt_14/main_384.png` again -- should not duplicate."
    ].join("\n");

    expect(parseCitedEvidencePaths(text)).toEqual(["attempt_14/main_384.png", "pose_skeleton_384.png"]);
  });

  it("ignores inline code spans that are not image-path-shaped", () => {
    const text = [
      "See `ARM_HYBRID_ATTEMPT_LOG_T9999.md` and run `check_attempt_cap` before spending",
      "another attempt. Config lives at `assets/src/character/config.toml`.",
      "The command `git status --porcelain` should be empty."
    ].join("\n");

    expect(parseCitedEvidencePaths(text)).toEqual([]);
  });

  it("returns an empty list for text with no inline code spans at all", () => {
    expect(parseCitedEvidencePaths("Nothing promoted this round.")).toEqual([]);
  });
});

describe("promoteEvidence", () => {
  it("promotes every cited frame that resolves under runDir into docs/assets/evidence/<card>/", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_14/main_384.png", "frame-14");
    await writeFile(repoRoot, "assets/out/hybrid_profile/pose_skeleton_384.png", "skeleton");
    await writeFile(
      logPath,
      "The decisive frame is `attempt_14/main_384.png`, conditioned on `pose_skeleton_384.png`."
    );

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(result.promoted.map((p) => p.destRelPath).sort()).toEqual(
      ["docs/assets/evidence/T-9999/attempt_14_main_384.png", "docs/assets/evidence/T-9999/pose_skeleton_384.png"].sort()
    );
    expect(await readFile(repoRoot, "docs/assets/evidence/T-9999/attempt_14_main_384.png")).toEqual(
      Buffer.from("frame-14")
    );
    expect(await readFile(repoRoot, "docs/assets/evidence/T-9999/pose_skeleton_384.png")).toEqual(
      Buffer.from("skeleton")
    );
  });

  it("commits evidence for a FINDING round (nothing promoted to assets/final) just as it would for a promotion round", async () => {
    // The T-0272 case this card exists for: the round's own verdict is "Not promoted", but the
    // log still names the decisive frame that justifies the finding.
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_25/main_384.png", "best-lean");
    await writeFile(
      logPath,
      [
        "**Not promoted.** `attempt_25/main_384.png` is the single most confidently side-facing",
        "result this card has produced, but carries no costume colour and is not promotable on",
        "the colour-legibility requirement."
      ].join("\n")
    );

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0].destRelPath).toBe("docs/assets/evidence/T-9999/attempt_25_main_384.png");
    expect(await exists(path.join(repoRoot, "docs/assets/evidence/T-9999/attempt_25_main_384.png"))).toBe(true);
  });

  it("reports (never throws for) a citation whose file does not exist under runDir", async () => {
    await writeFile(logPath, "The decisive frame is `attempt_99/main_384.png`.");

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(result.promoted).toEqual([]);
    expect(result.skippedMissing).toEqual(["attempt_99/main_384.png"]);
  });

  it("does not fail when the run crashed before generating anything -- runDir does not exist at all", async () => {
    await writeFile(logPath, "The decisive frame is `attempt_1/main_384.png`.");
    // runDir deliberately never created.

    await expect(promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath })).resolves.toMatchObject({
      promoted: [],
      skippedMissing: ["attempt_1/main_384.png"]
    });
  });

  it("does not fail when the attempt log has not been written yet", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", "frame");
    // logPath deliberately never created.

    await expect(promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath })).resolves.toEqual({
      evidenceDir: path.join(repoRoot, "docs/assets/evidence/T-9999"),
      promoted: [],
      skippedMissing: [],
      skippedTooLarge: [],
      skippedOverCap: [],
      unchanged: []
    });
  });

  it("never resolves a citation outside runDir, even one that looks like a path-traversal attempt", async () => {
    await writeFile(repoRoot, "secret.png", "outside-run-dir");
    await writeFile(logPath, "See `../../secret.png` for reference.");

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(result.promoted).toEqual([]);
    expect(await exists(path.join(repoRoot, "docs/assets/evidence/T-9999"))).toBe(false);
  });

  it("skips a cited frame over the byte cap and reports it, rather than committing an oversized file", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", Buffer.alloc(20, 1));
    await writeFile(logPath, "Decisive: `attempt_1/main_384.png`.");

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath, maxFileBytes: 10 });

    expect(result.promoted).toEqual([]);
    expect(result.skippedTooLarge).toEqual([{ cited: "attempt_1/main_384.png", bytes: 20 }]);
  });

  it("bounds the number of promoted frames at maxFiles and reports the overflow rather than truncating silently", async () => {
    const cited = [];
    for (let i = 0; i < 5; i += 1) {
      await writeFile(repoRoot, `assets/out/hybrid_profile/attempt_${i}/main_384.png`, `frame-${i}`);
      cited.push(`attempt_${i}/main_384.png`);
    }
    await writeFile(logPath, cited.map((c) => `\`${c}\``).join(" and "));

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath, maxFiles: 2 });

    expect(result.promoted).toHaveLength(2);
    expect(result.skippedOverCap).toEqual(cited.slice(2));
  });

  it("is idempotent -- re-promoting byte-identical content does not create a duplicate or churn the tree", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", "frame-1");
    await writeFile(logPath, "Decisive: `attempt_1/main_384.png`.");

    const first = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });
    const second = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(first.promoted).toHaveLength(1);
    expect(second.promoted).toEqual([]);
    expect(second.unchanged).toEqual(["attempt_1/main_384.png"]);
    const dir = path.join(repoRoot, "docs/assets/evidence/T-9999");
    expect((await fs.readdir(dir)).sort()).toEqual(["attempt_1_main_384.png"]);
  });

  it("appends a suffix rather than clobbering when a later round cites a different frame under the same destination name", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", "round-1-content");
    await writeFile(logPath, "Decisive: `attempt_1/main_384.png`.");
    await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    // A second round's run directory happens to reuse the same attempt-numbered relative path
    // with genuinely different content (e.g. a fresh attempt-cap budget starting back at 1).
    const round2RunDir = path.join(repoRoot, "assets", "out", "hybrid_profile_round2");
    await writeFile(repoRoot, "assets/out/hybrid_profile_round2/attempt_1/main_384.png", "round-2-content");
    const round2LogPath = path.join(repoRoot, "assets/src/character/ARM_ROUND2_LOG_T9999.md");
    await writeFile(round2LogPath, "Decisive: `attempt_1/main_384.png`.");

    const result = await promoteEvidence({
      repoRoot,
      cardId: "T-9999",
      runDir: round2RunDir,
      logPath: round2LogPath
    });

    expect(result.promoted).toHaveLength(1);
    const dir = path.join(repoRoot, "docs/assets/evidence/T-9999");
    expect((await fs.readdir(dir)).sort()).toEqual(["attempt_1_main_384.png", "attempt_1_main_384__2.png"]);
    expect(await readFile(repoRoot, "docs/assets/evidence/T-9999/attempt_1_main_384.png")).toEqual(
      Buffer.from("round-1-content")
    );
    expect(await readFile(repoRoot, "docs/assets/evidence/T-9999/attempt_1_main_384__2.png")).toEqual(
      Buffer.from("round-2-content")
    );
  });
});

describe("defaults", () => {
  it("exposes the documented evidence root and caps", () => {
    expect(DEFAULT_EVIDENCE_ROOT).toBe("docs/assets/evidence");
    expect(DEFAULT_MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_FILES_PER_RUN).toBeGreaterThan(0);
  });
});

describe("promoteEvidence end-to-end -- survives real worktree removal", () => {
  it("leaves the committed evidence readable from the branch after `git worktree remove --force`", async () => {
    const mainRepo = path.join(tmpDir, "main-repo");
    const worktreeDir = path.join(tmpDir, "worktrees", "T-9999");

    await fs.mkdir(mainRepo, { recursive: true });
    await git(["init", "-b", "develop"], mainRepo);
    await git(["config", "user.email", "test@example.com"], mainRepo);
    await git(["config", "user.name", "Test"], mainRepo);
    await writeFile(mainRepo, ".gitignore", "**/assets/out/\n");
    await writeFile(mainRepo, "README.md", "# repo\n");
    await git(["add", "-A"], mainRepo);
    await git(["commit", "-m", "initial"], mainRepo);

    await git(["worktree", "add", "-b", "feature/T-9999", worktreeDir, "develop"], mainRepo);

    const wtRunDir = path.join(worktreeDir, "assets", "out", "hybrid_profile");
    const wtLogPath = path.join(worktreeDir, "assets", "src", "character", "ARM_HYBRID_ATTEMPT_LOG_T9999.md");
    await writeFile(worktreeDir, "assets/out/hybrid_profile/attempt_14/main_384.png", "the-decisive-frame");
    await writeFile(wtLogPath, "The decisive frame is `attempt_14/main_384.png`.");

    const result = await promoteEvidence({
      repoRoot: worktreeDir,
      cardId: "T-9999",
      runDir: wtRunDir,
      logPath: wtLogPath
    });
    expect(result.promoted).toHaveLength(1);

    await git(["add", "-A", "--", "docs/assets/evidence"], worktreeDir);
    await git(["commit", "-m", "docs(evidence): T-9999 promote decisive frame"], worktreeDir);

    await git(["worktree", "remove", "--force", worktreeDir], mainRepo);
    await git(["worktree", "prune"], mainRepo);

    expect(await exists(worktreeDir)).toBe(false);

    const { stdout } = await git(
      ["show", "feature/T-9999:docs/assets/evidence/T-9999/attempt_14_main_384.png"],
      mainRepo
    );
    expect(stdout).toBe("the-decisive-frame");
  });
});
