import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Directory (inside `worktrees/`, alongside the card worktrees themselves) where a card's
 * untracked/ignored artifacts are parked while its worktree is torn down and re-cut.
 *
 * Deliberately a sibling of the worktrees rather than a repoRoot-level dir: it is guaranteed to
 * sit on the same filesystem as the worktree it is rescuing files from, which is what lets
 * preserve/restore be a `rename` (instant, no extra disk) instead of a 2 GB copy; and
 * `worktrees/` is already an untracked, git-invisible runtime dir, so nesting inside it adds no
 * new noise to `git status` at repoRoot.
 */
export const ARTIFACT_CACHE_DIRNAME = ".artifact-cache";

/**
 * Worktree-relative path prefixes whose untracked/ignored contents survive a worktree reclaim.
 *
 * This is an allowlist, not a blanket "everything untracked and ignored" sweep, and that choice
 * is load-bearing. A card worktree's non-tracked set is dominated by things that are worthless
 * to keep and expensive to move: `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`, `build` dirs,
 * `client/bin/`, `.venv/`, and the `tools/board/node_modules` symlink that
 * `linkBoardNodeModules` recreates on every run anyway. Carrying those across a reclaim would
 * cost real time and disk, and restoring a stale `__pycache__` or build tree into a freshly
 * checked-out worktree is actively harmful -- it is exactly the "stale copy shadows new source"
 * failure the tracked-files-win rule exists to prevent, just one level down where git cannot see
 * it. The paths below, by contrast, hold work that is *expensive to recompute and monotonic* --
 * a later run only ever adds to it:
 *
 *   - `assets/final/lora`     -- sd-scripts `--save_state` checkpoint dirs
 *                                (`<name>-step*-state/`) and their `.safetensors` weights. This
 *                                is the T-0248 case: ~86 minutes of GPU training wiped by the
 *                                reclaim, so `find_resume_state` (assets/src/lora/.../train.py)
 *                                found nothing on the re-run and training restarted at step 0.
 *   - `assets/src/lora/refs`  -- the gitignored training corpus (re-fetched over the network by
 *                                `lora_train.fetch`) plus the `--cache_latents` `.npz` files
 *                                sd-scripts writes beside it.
 *   - `assets/out`            -- gitignored generated asset output (matched at any depth by
 *                                .gitignore's globstar `assets/out/` rule), so a re-run of a GPU
 *                                generation card keeps whatever it already rendered.
 *
 * Extend with the `BOARD_PRESERVED_ARTIFACT_PATHS` env var (see `preservedArtifactPathsFromEnv`)
 * rather than editing this list for a one-off.
 */
export const DEFAULT_PRESERVED_ARTIFACT_PATHS = Object.freeze([
  "assets/final/lora",
  "assets/src/lora/refs",
  "assets/out"
]);

/**
 * How many cards' caches the preservation dir may hold before the least-recently-written ones
 * are dropped. The primary cleanup is the terminal-`done`/`retired` purge in httpApi.js; this is
 * the backstop for cards that never reach a terminal state (abandoned, endlessly reworked), so
 * an unbounded pile of multi-GB checkpoint snapshots cannot accumulate unnoticed.
 */
export const DEFAULT_ARTIFACT_CACHE_MAX_CARDS = 8;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** BOARD_PRESERVE_ARTIFACTS env var: default ON; set to "0"/"false"/"off"/"no" (any case) to restore the old wipe-on-reclaim behaviour. */
export function artifactPreservationEnabledFromEnv(env = process.env) {
  return !DISABLE_VALUES.has((env.BOARD_PRESERVE_ARTIFACTS ?? "").toLowerCase());
}

/**
 * BOARD_PRESERVED_ARTIFACT_PATHS env var: comma- or colon-separated worktree-relative paths
 * *added to* (never replacing) DEFAULT_PRESERVED_ARTIFACT_PATHS, so an operator can rescue a new
 * kind of artifact without a deploy and without having to restate the defaults that already
 * matter. Absolute paths and anything escaping the worktree (`..`) are dropped rather than
 * trusted -- this list is fed to `git ls-files` as a pathspec and to `path.join` as a
 * destination.
 */
export function preservedArtifactPathsFromEnv(env = process.env) {
  const extra = (env.BOARD_PRESERVED_ARTIFACT_PATHS ?? "")
    .split(/[,:]/)
    .map((entry) => entry.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((entry) => entry.length > 0 && !path.isAbsolute(entry) && !entry.split("/").includes(".."));
  return [...new Set([...DEFAULT_PRESERVED_ARTIFACT_PATHS, ...extra])];
}

/** The cache root for a set of card worktrees -- `<worktreesDir>/.artifact-cache`. */
export function artifactCacheRootFor({ worktreesDir }) {
  return path.join(worktreesDir, ARTIFACT_CACHE_DIRNAME);
}

/**
 * A card id is used as a single directory name under the cache root, so anything that is not a
 * plain path segment (a separator, `.`/`..`, an empty string) is rejected outright rather than
 * sanitized into something that might still traverse.
 */
function assertSafeCardId(cardId) {
  if (
    typeof cardId !== "string" ||
    cardId.length === 0 ||
    cardId === "." ||
    cardId === ".." ||
    /[\\/]/.test(cardId)
  ) {
    throw new Error(`Unsafe artifact-cache key: ${JSON.stringify(cardId)}`);
  }
  return cardId;
}

/** `<cacheRoot>/<cardId>` -- holds `manifest.json` plus a `files/` tree mirroring worktree-relative paths. */
export function cardCacheDir({ cacheRoot, cardId }) {
  return path.join(cacheRoot, assertSafeCardId(cardId));
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** True when `relPath` is `prefix` itself or sits underneath it. Segment-aware: `assets/outside` is not under `assets/out`. */
function isUnderAnyPrefix(relPath, prefixes) {
  return prefixes.some((prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`));
}

async function gitLines(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter((line) => line.length > 0);
}

/**
 * Every non-tracked file under `artifactPaths`: the union of untracked-but-not-ignored
 * (`--others --exclude-standard`) and ignored (`--others --ignored --exclude-standard`) files.
 * Both are needed -- T-0248's checkpoints are plain untracked (`??` in `git status`), while a
 * corpus under `assets/src/lora/refs` is gitignored -- and neither listing ever includes tracked
 * files, which is what keeps committed source out of the cache by construction.
 *
 * `artifactPaths` is passed to git as a pathspec so the scan never walks `node_modules`,
 * `build` dirs or `.venv/` at all; the same prefixes are re-checked in JS afterwards so a pathspec
 * surprise can never widen the set beyond the allowlist.
 */
export async function listPreservableFiles({ worktreeDir, artifactPaths }) {
  if (artifactPaths.length === 0) return [];
  const base = ["ls-files", "-z", "--others", "--exclude-standard"];
  const [untracked, ignored] = await Promise.all([
    gitLines([...base, "--", ...artifactPaths], worktreeDir),
    gitLines([...base, "--ignored", "--", ...artifactPaths], worktreeDir)
  ]);
  return [...new Set([...untracked, ...ignored])]
    .filter((rel) => isUnderAnyPrefix(rel, artifactPaths))
    .sort();
}

/** Worktree-relative paths git currently tracks -- the set the restore step refuses to overwrite. */
export async function listTrackedFiles({ worktreeDir }) {
  return new Set(await gitLines(["ls-files", "-z"], worktreeDir));
}

/**
 * Moves one file, falling back to copy+unlink when source and destination straddle a filesystem
 * boundary (`rename` returns EXDEV). Uses `fs.cp` with `verbatimSymlinks` rather than
 * `fs.copyFile` so a symlink is reproduced as a symlink instead of being dereferenced into a
 * copy of whatever it pointed at.
 */
async function moveFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

/** Drops a card's whole preservation cache. Idempotent; never throws on a cache that was never created. */
export async function clearPreservedArtifacts({ cacheRoot, cardId }) {
  await fs.rm(cardCacheDir({ cacheRoot, cardId }), { recursive: true, force: true });
}

/**
 * Backstop bound on total cache size: keeps the `maxCards` most recently written card caches and
 * removes the rest. Returns the card ids dropped. Never throws -- a cache root that does not
 * exist yet is simply empty.
 */
export async function pruneArtifactCache({ cacheRoot, maxCards = DEFAULT_ARTIFACT_CACHE_MAX_CARDS }) {
  let entries;
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (dirs.length <= maxCards) return [];

  const stamped = await Promise.all(
    dirs.map(async (name) => {
      const mtime = await fs
        .stat(path.join(cacheRoot, name))
        .then((stat) => stat.mtimeMs)
        .catch(() => 0);
      return { name, mtime };
    })
  );
  const evicted = stamped.sort((a, b) => b.mtime - a.mtime).slice(maxCards);
  for (const { name } of evicted) {
    await fs.rm(path.join(cacheRoot, name), { recursive: true, force: true });
  }
  return evicted.map(({ name }) => name);
}

/**
 * Moves a card's preservable artifacts out of `worktreeDir` and into its cache, so the caller can
 * destroy the worktree without destroying them. Call immediately before
 * `git worktree remove --force`.
 *
 * Move, not copy: the worktree is about to be deleted anyway, the cache is a sibling of it on the
 * same filesystem, and a 2 GB checkpoint set copies in minutes but renames in milliseconds -- and
 * a rename means peak disk never doubles.
 *
 * A capture that finds nothing (a fresh card, a worktree that no longer exists, a card with no
 * artifacts under the allowlist) leaves any *existing* cache untouched rather than clearing it.
 * That is deliberate: if a previous reclaim moved artifacts out and then crashed before the
 * worktree was re-created, the next run sees an absent/empty worktree, and clearing on "nothing
 * captured" would destroy exactly the checkpoints this exists to save.
 *
 * @returns {Promise<{preserved: string[], cacheDir: string|null}>}
 */
export async function preserveArtifacts({
  worktreeDir,
  cacheRoot,
  cardId = path.basename(worktreeDir),
  artifactPaths = preservedArtifactPathsFromEnv(),
  maxCards = DEFAULT_ARTIFACT_CACHE_MAX_CARDS
}) {
  if (!(await pathExists(worktreeDir))) {
    return { preserved: [], cacheDir: null };
  }
  const files = await listPreservableFiles({ worktreeDir, artifactPaths });
  if (files.length === 0) {
    return { preserved: [], cacheDir: null };
  }

  const dir = cardCacheDir({ cacheRoot, cardId });
  // Only now that there is a genuinely newer snapshot to write is the previous one dropped, so
  // the cache holds exactly one generation per card rather than accumulating them.
  await fs.rm(dir, { recursive: true, force: true });
  const filesDir = path.join(dir, "files");
  await fs.mkdir(filesDir, { recursive: true });

  const preserved = [];
  for (const rel of files) {
    try {
      await moveFile(path.join(worktreeDir, rel), path.join(filesDir, rel));
      preserved.push(rel);
    } catch (err) {
      // One unreadable file must not cost the card every other checkpoint in the set.
      console.warn(`Board: could not preserve ${cardId}/${rel} across worktree reclaim: ${err.message}`);
    }
  }

  await fs.writeFile(
    path.join(dir, "manifest.json"),
    `${JSON.stringify({ cardId, capturedAt: new Date().toISOString(), paths: preserved }, null, 2)}\n`,
    "utf8"
  );
  await pruneArtifactCache({ cacheRoot, maxCards });
  return { preserved, cacheDir: dir };
}

/**
 * Moves a card's preserved artifacts back into a freshly created worktree. Call immediately after
 * `git worktree add`.
 *
 * **The fresh checkout always wins.** A preserved path that is a *tracked* file in the new tree
 * is never written: that copy is stale by definition (git has just materialized the committed
 * version), and restoring over it would silently shadow committed source with whatever a previous
 * run happened to leave on disk. Such paths are reported in `skippedTracked` and left in the
 * cache rather than deleted, so nothing is destroyed by the decision not to restore them.
 *
 * @returns {Promise<{restored: string[], skippedTracked: string[]}>}
 */
export async function restoreArtifacts({
  worktreeDir,
  cacheRoot,
  cardId = path.basename(worktreeDir)
}) {
  const dir = cardCacheDir({ cacheRoot, cardId });
  const filesDir = path.join(dir, "files");
  if (!(await pathExists(filesDir))) {
    return { restored: [], skippedTracked: [] };
  }

  const tracked = await listTrackedFiles({ worktreeDir });
  const entries = await fs.readdir(filesDir, { recursive: true, withFileTypes: true });
  const relPaths = entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      path
        .relative(filesDir, path.join(entry.parentPath ?? entry.path, entry.name))
        .split(path.sep)
        .join("/")
    )
    .sort();

  const restored = [];
  const skippedTracked = [];
  for (const rel of relPaths) {
    if (tracked.has(rel)) {
      skippedTracked.push(rel);
      continue;
    }
    try {
      await moveFile(path.join(filesDir, rel), path.join(worktreeDir, rel));
      restored.push(rel);
    } catch (err) {
      console.warn(`Board: could not restore preserved ${cardId}/${rel} into the new worktree: ${err.message}`);
    }
  }

  // Everything restorable has now been moved out; what remains is the stale-vs-tracked set, which
  // stays cached (never silently deleted) until the card's terminal-done purge or its next
  // capture.
  if (skippedTracked.length === 0) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { restored, skippedTracked };
}
