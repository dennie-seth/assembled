import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A `git status --porcelain` snapshot as a set of lines, for before/after comparison. */
export async function captureGitStatus(repoRoot) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot });
  return new Set(stdout.split("\n").filter(Boolean));
}

/** Lines present in `after` but not `before` -- i.e. newly dirtied since the snapshot. */
export function diffGitStatus(before, after) {
  return [...after].filter((line) => !before.has(line));
}
