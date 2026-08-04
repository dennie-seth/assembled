import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gh(args, cwd) {
  return execFileAsync("gh", args, { cwd });
}

/**
 * Whether the `gh` CLI can open a PR right now: installed AND authenticated.
 * Distinguishes the two so the caller can log an actionable, specific reason.
 */
export async function checkAvailability({ worktreeDir }) {
  try {
    await gh(["--version"], worktreeDir);
  } catch {
    return { available: false, reason: "not-installed" };
  }
  try {
    await gh(["auth", "status"], worktreeDir);
  } catch {
    return { available: false, reason: "not-authenticated" };
  }
  return { available: true, reason: null };
}

/** URL of an already-open PR for `branch`, or null if none exists. */
export async function findExistingPr({ worktreeDir, branch }) {
  try {
    const { stdout } = await gh(["pr", "view", branch, "--json", "url"], worktreeDir);
    const data = JSON.parse(stdout);
    return typeof data.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

/** Opens a PR for `head` -> `base` and returns its URL. */
export async function createPr({ worktreeDir, base, head, title, body }) {
  const { stdout } = await gh(
    ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body],
    worktreeDir
  );
  const match = stdout.match(/https:\/\/\S+/);
  return match ? match[0] : stdout.trim();
}
