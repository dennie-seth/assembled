import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  listCommittedAssetFinalFiles,
  countCommittedAssets
} from "../src/lib/committedAssetCount.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

async function writeFile(root, relPath, contents) {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

let tmpDir;
let repoRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-committed-asset-count-"));
  repoRoot = path.join(tmpDir, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("listCommittedAssetFinalFiles", () => {
  it("lists every file committed under assets/final/ at the given ref", async () => {
    await writeFile(repoRoot, "assets/final/character/frame.png", "png-bytes");
    await writeFile(repoRoot, "assets/final/character/frame.provenance.json", "{}");
    await writeFile(repoRoot, "README.md", "not an asset");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "add asset"], repoRoot);

    const files = await listCommittedAssetFinalFiles({ repoRoot, ref: "HEAD" });

    expect(files.sort()).toEqual(
      ["assets/final/character/frame.png", "assets/final/character/frame.provenance.json"].sort()
    );
  });

  it("returns an empty list when nothing is committed under assets/final/", async () => {
    await writeFile(repoRoot, "README.md", "nothing here");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "init"], repoRoot);

    const files = await listCommittedAssetFinalFiles({ repoRoot, ref: "HEAD" });

    expect(files).toEqual([]);
  });
});

describe("countCommittedAssets", () => {
  it("counts a card's committed primary asset files, keyed off their provenance sidecar's card field", async () => {
    await writeFile(repoRoot, "assets/final/character/idle.png", "png-bytes");
    await writeFile(
      repoRoot,
      "assets/final/character/idle.provenance.json",
      JSON.stringify({ card: "T-0252" })
    );
    await writeFile(repoRoot, "assets/final/character/other.png", "png-bytes-2");
    await writeFile(
      repoRoot,
      "assets/final/character/other.provenance.json",
      JSON.stringify({ card: "T-9999" })
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "add two cards' assets"], repoRoot);

    const result = await countCommittedAssets({ repoRoot, ref: "HEAD", cardId: "T-0252" });

    expect(result.count).toBe(1);
    expect(result.files).toEqual(["assets/final/character/idle.png"]);
  });

  it("does not let a .provenance.json sidecar inflate the count -- only the primary asset counts", async () => {
    await writeFile(repoRoot, "assets/final/tiles/wall.png", "png-bytes");
    await writeFile(
      repoRoot,
      "assets/final/tiles/wall.provenance.json",
      JSON.stringify({ card: "T-0073" })
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "add tile"], repoRoot);

    const result = await countCommittedAssets({ repoRoot, ref: "HEAD", cardId: "T-0073" });

    expect(result.count).toBe(1);
    expect(result.files).toEqual(["assets/final/tiles/wall.png"]);
  });

  it("does not let a .meta.json sidecar inflate the count either", async () => {
    await writeFile(repoRoot, "assets/final/audio/bed.wav", "wav-bytes");
    await writeFile(
      repoRoot,
      "assets/final/audio/bed.meta.json",
      JSON.stringify({ card: "T-0204" })
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "add audio bed"], repoRoot);

    const result = await countCommittedAssets({ repoRoot, ref: "HEAD", cardId: "T-0204" });

    expect(result.count).toBe(1);
    expect(result.files).toEqual(["assets/final/audio/bed.wav"]);
  });

  it("a file with no provenance sidecar cannot be attributed to any card", async () => {
    await writeFile(repoRoot, "assets/final/palette/home_palette.json", "{}");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "add palette, no sidecar"], repoRoot);

    const result = await countCommittedAssets({ repoRoot, ref: "HEAD", cardId: "T-0001" });

    expect(result.count).toBe(0);
  });

  it("a promoted-then-un-promoted asset counts as 0 once its commit removes it from the tree -- no special-casing needed, absence from the tree is enough", async () => {
    await writeFile(repoRoot, "assets/final/character/candidate.png", "png-bytes");
    await writeFile(
      repoRoot,
      "assets/final/character/candidate.provenance.json",
      JSON.stringify({ card: "T-0315" })
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "promote candidate (T-0315)"], repoRoot);

    await git(["rm", "assets/final/character/candidate.png"], repoRoot);
    await git(["rm", "assets/final/character/candidate.provenance.json"], repoRoot);
    await git(["commit", "-m", "un-promote candidate, colour illegible (T-0315)"], repoRoot);

    const result = await countCommittedAssets({ repoRoot, ref: "HEAD", cardId: "T-0315" });

    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("reports 0 for a card that never had anything promoted", async () => {
    await writeFile(repoRoot, "README.md", "nothing shipped");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "init"], repoRoot);

    const result = await countCommittedAssets({ repoRoot, ref: "HEAD", cardId: "T-0272" });

    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
  });
});

describe("countCommittedAssets against this repo's real history (regression fixtures)", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  it("T-0315 reports 0 -- the keyframe it promoted was later un-promoted (cc3436f)", async () => {
    const result = await countCommittedAssets({ repoRoot: REPO_ROOT, ref: "HEAD", cardId: "T-0315" });
    expect(result.count).toBe(0);
  });

  it("T-0272 reports 0 -- five rounds, 36+ attempts, no keyframe ever promoted", async () => {
    const result = await countCommittedAssets({ repoRoot: REPO_ROOT, ref: "HEAD", cardId: "T-0272" });
    expect(result.count).toBe(0);
  });

  it("T-0252 (a card that genuinely shipped) still counts its real promoted assets", async () => {
    const result = await countCommittedAssets({ repoRoot: REPO_ROOT, ref: "HEAD", cardId: "T-0252" });
    expect(result.count).toBe(2);
    expect(result.files.sort()).toEqual(
      [
        "assets/final/character/player_idle_sheet_hybrid_T0252.png",
        "assets/final/character/player_idle_frame_hybrid_source_T0252.png"
      ].sort()
    );
  });
});
