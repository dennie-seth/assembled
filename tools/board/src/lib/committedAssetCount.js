import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ASSETS_FINAL_PREFIX = "assets/final/";
const SIDECAR_SUFFIXES = [".provenance.json", ".meta.json"];

async function git(args, cwd) {
  try {
    return await execFileAsync("git", args, { cwd });
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

function isSidecarFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return SIDECAR_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function sidecarPathsFor(filePath) {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return SIDECAR_SUFFIXES.map((suffix) => `${base}${suffix}`);
}

/**
 * Lists every file committed under assets/final/ at `ref`, as repo-root-relative
 * POSIX paths (git's own ls-tree output, which is always POSIX regardless of OS).
 */
export async function listCommittedAssetFinalFiles({ repoRoot, ref = "HEAD" }) {
  const { stdout } = await git(
    ["ls-tree", "-r", "--name-only", ref, "--", ASSETS_FINAL_PREFIX],
    repoRoot
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Reads the `card` field of a committed file's provenance sidecar (`<name>.provenance.json`
 * or `<name>.meta.json`, stripping the file's own extension) at `ref`. Returns null if no
 * sidecar exists, none is valid JSON, or none has a string `card` field -- deliberately
 * conservative, since a file this can't attribute to a card must not be guessed at.
 */
async function readCardOwner({ repoRoot, ref, filePath }) {
  for (const sidecarPath of sidecarPathsFor(filePath)) {
    let stdout;
    try {
      ({ stdout } = await git(["show", `${ref}:${sidecarPath}`], repoRoot));
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(stdout);
      if (typeof parsed.card === "string") {
        return parsed.card;
      }
    } catch {
      // not valid JSON -- try the next sidecar suffix, if any
    }
  }
  return null;
}

/**
 * Counts assets committed under assets/final/ at `ref` that are attributed to `cardId` --
 * the fix for the asset export/reconcile count previously counting a card's *attachments*
 * (review material -- evidence frames, candidate renders -- routinely uploaded by cards that
 * ship nothing) as shipped assets. See T-0320.
 *
 * A file counts once, as its own primary asset, only when its provenance sidecar's `card`
 * field matches `cardId`. Sidecar files (`*.provenance.json`, `*.meta.json`) never count
 * themselves -- they attribute the primary file, they are not a second shippable asset in
 * their own right (a card whose only committed pair is `foo.png` + `foo.provenance.json`
 * ships 1 asset, not 2). A file with no sidecar, or a sidecar with no `card` field, cannot be
 * attributed to any card and never counts toward one.
 *
 * A promoted-then-un-promoted asset (T-0315's live regression: a keyframe promoted, then
 * removed in a later commit because its colour was illegible) costs 0 with no special-casing
 * -- it is simply absent from the tree at `ref`, exactly like an asset that was never promoted
 * at all (T-0272). The tree is the only authority; there is no separate "was ever promoted"
 * bookkeeping to get out of sync with it.
 *
 * Deliberately scoped to assets/final/ only: a committed reference file elsewhere (e.g.
 * assets/src/concept/, as T-0272 committed a costume side reference to) does not count. That
 * mirrors this repo's own deliverable convention (assets/final/ is the curated, shipped
 * output; assets/src/ is working material) and keeps this function's one job -- "what shipped"
 * -- unambiguous.
 */
export async function countCommittedAssets({ repoRoot, ref = "HEAD", cardId }) {
  const files = await listCommittedAssetFinalFiles({ repoRoot, ref });
  const primaryFiles = files.filter((f) => !isSidecarFile(f));

  const owners = await Promise.all(
    primaryFiles.map((filePath) => readCardOwner({ repoRoot, ref, filePath }))
  );

  const matched = primaryFiles.filter((_, i) => owners[i] === cardId);
  return { count: matched.length, files: matched };
}
