import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

export async function getCurrentBranch(repoRoot) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
}

export async function getHeadInfo(repoRoot) {
  const sha = await git(["rev-parse", "HEAD"], repoRoot);
  const isoDate = await git(["log", "-1", "--format=%cI"], repoRoot);
  return { sha, isoDate };
}

export async function getGitStatus(repoRoot) {
  const branch = await getCurrentBranch(repoRoot);
  const { sha, isoDate } = await getHeadInfo(repoRoot);
  return { branch, head: sha, headTimestamp: isoDate };
}
