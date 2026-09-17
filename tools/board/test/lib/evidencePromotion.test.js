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
  promoteEvidence,
  discoverEvidenceSources,
  promoteEvidenceForCard
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

/** Same as writeFile but for callers that already have an absolute target path (e.g. logPath). */
async function writeAbs(target, contents) {
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

  it("resolves a bare filename cited in a markdown table row via that row's own leading attempt number", () => {
    const text = [
      "| Attempt | Seed | Notes |",
      "|---|---|---|",
      "| 1 | 31416 | Visual verdict (Read tool, `main_384.png`): front-facing, boxy. |",
      "| 8 | 31416 | Visual verdict (re-checked, `main_384.png`): same cluster as attempts 1, 5, and 7. |"
    ].join("\n");

    expect(parseCitedEvidencePaths(text)).toEqual(["attempt_1/main_384.png", "attempt_8/main_384.png"]);
  });

  it("resolves a bare filename cited in prose via the nearest preceding attempt mention in the same sentence", () => {
    const text = [
      "- **Coherent but gate-failing** (attempts 39, 40): the visual read as the round's best",
      "  result by far (attempt 39's `main_384.png`, kept in `docs/assets/evidence/T-0272/`) --",
      "  but the background is wrong.",
      "- **One attempt passed the mechanical gate** (attempt 41, seed 84512) but its own",
      "  `main_384.png` and `cell_48_indexed.png` do not read as a legible standing figure."
    ].join("\n");

    expect(parseCitedEvidencePaths(text)).toEqual([
      "attempt_39/main_384.png",
      "attempt_41/main_384.png",
      "attempt_41/cell_48_indexed.png"
    ]);
  });

  it("does not attribute a bare filename to an attempt mentioned only in a different, earlier sentence", () => {
    // "attempt 52's 144" ends its own sentence before "But `main_384.png`" starts a new one --
    // the citation must not be mis-attributed to the nearer-but-wrong attempt 52.
    const text = [
      "Attempt 53: reproduce attempt 39's exact recipe. Mechanical gate passed -- more foreground",
      "than attempts 39/40/49/50 and roughly half of attempt 52's 144. But `main_384.png` is a",
      "fifth distinct composition."
    ].join("\n");

    expect(parseCitedEvidencePaths(text)).toEqual(["main_384.png"]);
  });

  it("reconstitutes a hard-wrapped paragraph (no blank lines) into one sentence before resolving", () => {
    const text = [
      "Per this round's own instructions, attempts 23 and 24 tested conditioning",
      "IP-Adapter's secondary input on this pipeline's own prior output -- pre-inverting",
      "attempt 21's (23) and attempt 20's (24) own `main_384.png` so the invert restores",
      "the original tone before it reaches IP-Adapter."
    ].join("\n");

    expect(parseCitedEvidencePaths(text)).toEqual(["attempt_20/main_384.png"]);
  });

  it("leaves a bare filename unresolved when no attempt context precedes it in the same sentence", () => {
    // Matches the doc's own convention for a conditioning input at the top of the run directory
    // (e.g. `pose_skeleton_384.png`) -- a later, unrelated "Attempt N" mention must not attach to it.
    const text = "`pose_skeleton_384.png`. Attempt 14 is re-confirmed later, unrelated to the frame above.";

    expect(parseCitedEvidencePaths(text)).toEqual(["pose_skeleton_384.png"]);
  });
});

describe("parseCitedEvidencePaths against the real T-0272 attempt log", () => {
  it("recovers the decisive frames T-0272's own round 3/5/6 prose and tables cite, without inventing paths that were never cited", async () => {
    const logPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../../assets/src/character/ARM_PROFILE_ATTEMPT_LOG_T0272.md"
    );
    const logText = await fs.readFile(logPath, "utf8");

    const cited = parseCitedEvidencePaths(logText);

    // These are real citations in the real log (round 1's table rows, round 5's table row, and
    // round 6's prose bullets) -- proof the resolver works against this repo's own prior art, not
    // only a synthetic fixture shaped to fit the regex.
    expect(cited).toEqual(
      expect.arrayContaining([
        "attempt_1/main_384.png",
        "attempt_8/main_384.png",
        "attempt_31/main_384.png",
        "attempt_39/main_384.png",
        "attempt_41/main_384.png",
        "attempt_41/cell_48_indexed.png"
      ])
    );
  });

  it("promotes exactly the decisive frames that exist on disk for a fake run directory shaped like T-0272's, bounded by the default cap", async () => {
    const logPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../../assets/src/character/ARM_PROFILE_ATTEMPT_LOG_T0272.md"
    );

    for (const rel of [
      "assets/out/hybrid_profile/attempt_1/main_384.png",
      "assets/out/hybrid_profile/attempt_8/main_384.png",
      "assets/out/hybrid_profile/attempt_31/main_384.png",
      "assets/out/hybrid_profile/attempt_39/main_384.png",
      "assets/out/hybrid_profile/attempt_41/main_384.png",
      "assets/out/hybrid_profile/attempt_41/cell_48_indexed.png"
    ]) {
      await writeFile(repoRoot, rel, `fixture-content-${rel}`);
    }

    const result = await promoteEvidence({ repoRoot, cardId: "T-0272", runDir, logPath });

    const destRelPaths = result.promoted.map((p) => p.destRelPath).sort();
    expect(destRelPaths).toEqual(
      [
        "docs/assets/evidence/T-0272/attempt_1_main_384.png",
        "docs/assets/evidence/T-0272/attempt_8_main_384.png",
        "docs/assets/evidence/T-0272/attempt_31_main_384.png",
        "docs/assets/evidence/T-0272/attempt_39_main_384.png",
        "docs/assets/evidence/T-0272/attempt_41_main_384.png",
        "docs/assets/evidence/T-0272/attempt_41_cell_48_indexed.png"
      ].sort()
    );
    // Bounded: this fake run only has 6 real files, well under the default 20-file cap, and
    // nothing outside that fixture set was fabricated.
    expect(result.promoted.length).toBeLessThan(DEFAULT_MAX_FILES_PER_RUN);
  });
});

describe("promoteEvidence", () => {
  it("promotes every cited frame that resolves under runDir into docs/assets/evidence/<card>/", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_14/main_384.png", "frame-14");
    await writeFile(repoRoot, "assets/out/hybrid_profile/pose_skeleton_384.png", "skeleton");
    await writeAbs(
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
    await writeAbs(
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
    await writeAbs(logPath, "The decisive frame is `attempt_99/main_384.png`.");

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(result.promoted).toEqual([]);
    expect(result.skippedMissing).toEqual(["attempt_99/main_384.png"]);
  });

  it("does not fail when the run crashed before generating anything -- runDir does not exist at all", async () => {
    await writeAbs(logPath, "The decisive frame is `attempt_1/main_384.png`.");
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
    await writeAbs(logPath, "See `../../secret.png` for reference.");

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(result.promoted).toEqual([]);
    expect(await exists(path.join(repoRoot, "docs/assets/evidence/T-9999"))).toBe(false);
  });

  it("skips a cited frame over the byte cap and reports it, rather than committing an oversized file", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", Buffer.alloc(20, 1));
    await writeAbs(logPath, "Decisive: `attempt_1/main_384.png`.");

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
    await writeAbs(logPath, cited.map((c) => `\`${c}\``).join(" and "));

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath, maxFiles: 2 });

    expect(result.promoted).toHaveLength(2);
    expect(result.skippedOverCap).toEqual(cited.slice(2));
  });

  it("is idempotent -- re-promoting byte-identical content does not create a duplicate or churn the tree", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", "frame-1");
    await writeAbs(logPath, "Decisive: `attempt_1/main_384.png`.");

    const first = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });
    const second = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(first.promoted).toHaveLength(1);
    expect(second.promoted).toEqual([]);
    expect(second.unchanged).toEqual(["attempt_1/main_384.png"]);
    const dir = path.join(repoRoot, "docs/assets/evidence/T-9999");
    expect((await fs.readdir(dir)).sort()).toEqual(["attempt_1_main_384.png"]);
  });

  it("does not treat a pre-existing zero-byte destination file as absent -- appends a suffix instead of silently overwriting it", async () => {
    const evidenceDir = path.join(repoRoot, "docs/assets/evidence/T-9999");
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "attempt_1_main_384.png"), Buffer.alloc(0));

    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", "real-content");
    await writeAbs(logPath, "Decisive: `attempt_1/main_384.png`.");

    const result = await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0].destRelPath).toBe("docs/assets/evidence/T-9999/attempt_1_main_384__2.png");
    expect(await readFile(repoRoot, "docs/assets/evidence/T-9999/attempt_1_main_384.png")).toEqual(Buffer.alloc(0));
    expect(await readFile(repoRoot, "docs/assets/evidence/T-9999/attempt_1_main_384__2.png")).toEqual(
      Buffer.from("real-content")
    );
  });

  it("appends a suffix rather than clobbering when a later round cites a different frame under the same destination name", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", "round-1-content");
    await writeAbs(logPath, "Decisive: `attempt_1/main_384.png`.");
    await promoteEvidence({ repoRoot, cardId: "T-9999", runDir, logPath });

    // A second round's run directory happens to reuse the same attempt-numbered relative path
    // with genuinely different content (e.g. a fresh attempt-cap budget starting back at 1).
    const round2RunDir = path.join(repoRoot, "assets", "out", "hybrid_profile_round2");
    await writeFile(repoRoot, "assets/out/hybrid_profile_round2/attempt_1/main_384.png", "round-2-content");
    const round2LogPath = path.join(repoRoot, "assets/src/character/ARM_ROUND2_LOG_T9999.md");
    await writeAbs(round2LogPath, "Decisive: `attempt_1/main_384.png`.");

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

describe("discoverEvidenceSources", () => {
  it("finds an ARM_*_ATTEMPT_LOG_<card>.md anywhere under assets/src and every top-level dir under assets/out", async () => {
    const foundLogPath = await writeFile(
      repoRoot,
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0272.md",
      "Decisive: `attempt_14/main_384.png`."
    );
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_14/main_384.png", "frame");
    await writeFile(repoRoot, "assets/out/hybrid_profile_round2/.gitkeep", "");

    const result = await discoverEvidenceSources({ repoRoot, cardId: "T-0272" });

    expect(result.logPaths).toEqual([foundLogPath]);
    expect(result.runDirs.sort()).toEqual(
      [
        path.join(repoRoot, "assets/out/hybrid_profile"),
        path.join(repoRoot, "assets/out/hybrid_profile_round2")
      ].sort()
    );
  });

  it("ignores an attempt log written for a different card", async () => {
    await writeFile(repoRoot, "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0111.md", "Decisive: `main_384.png`.");

    const result = await discoverEvidenceSources({ repoRoot, cardId: "T-0272" });

    expect(result.logPaths).toEqual([]);
  });

  it("degrades to empty lists, never throwing, when the card never touched assets/** at all", async () => {
    await expect(discoverEvidenceSources({ repoRoot, cardId: "T-0900" })).resolves.toEqual({
      logPaths: [],
      runDirs: []
    });
  });
});

describe("promoteEvidenceForCard", () => {
  it("discovers the card's own attempt log and run directory with no explicit runDir/logPath and promotes its cited frames", async () => {
    await writeFile(
      repoRoot,
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0272.md",
      "Decisive: `attempt_14/main_384.png`."
    );
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_14/main_384.png", "the-decisive-frame");

    const result = await promoteEvidenceForCard({ repoRoot, cardId: "T-0272" });

    expect(result.promoted.map((p) => p.destRelPath)).toEqual(["docs/assets/evidence/T-0272/attempt_14_main_384.png"]);
    expect(await readFile(repoRoot, "docs/assets/evidence/T-0272/attempt_14_main_384.png")).toEqual(
      Buffer.from("the-decisive-frame")
    );
  });

  it("does not double-count a citation that happens to be missing from every wrong candidate run dir but present in the right one", async () => {
    await writeFile(
      repoRoot,
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0272.md",
      "Decisive: `attempt_1/main_384.png`."
    );
    await writeFile(repoRoot, "assets/out/unrelated_workflow/.gitkeep", "");
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_1/main_384.png", "frame-1");

    const result = await promoteEvidenceForCard({ repoRoot, cardId: "T-0272" });

    expect(result.promoted).toHaveLength(1);
  });

  it("stays bounded at maxFiles in total across every discovered run dir, not per run dir", async () => {
    const cited = [];
    for (let i = 0; i < 5; i += 1) {
      await writeFile(repoRoot, `assets/out/hybrid_profile/attempt_${i}/main_384.png`, `frame-${i}`);
      cited.push(`attempt_${i}/main_384.png`);
    }
    await writeFile(
      repoRoot,
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0272.md",
      cited.map((c) => `\`${c}\``).join(" and ")
    );
    // A second, empty candidate run dir must not grant a second maxFiles budget.
    await writeFile(repoRoot, "assets/out/hybrid_profile_round2/.gitkeep", "");

    const result = await promoteEvidenceForCard({ repoRoot, cardId: "T-0272", maxFiles: 2 });

    expect(result.promoted).toHaveLength(2);
  });

  it("promotes nothing and never throws for a card with no attempt log and no assets/out tree at all", async () => {
    await expect(promoteEvidenceForCard({ repoRoot, cardId: "T-0900" })).resolves.toMatchObject({
      promoted: []
    });
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
    await writeAbs(wtLogPath, "The decisive frame is `attempt_14/main_384.png`.");

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
