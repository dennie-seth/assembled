import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { readTaskBodyAtMergeBase, readRunStartTimestamp } from "../../src/lib/gitTaskHistory.js";
import { serializeTask } from "../../src/lib/taskParser.js";
import { PRE_REGISTRATION_HEADING } from "../../src/lib/preRegisteredFinding.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

function task(overrides = {}) {
  return {
    id: "T-0999",
    title: "Task",
    status: "in-progress",
    priority: "P1",
    phase: 7,
    agent: "assets",
    depends_on: [],
    created: "2026-09-09",
    branch: null,
    commit: null,
    deliverable_type: "artifact",
    body: "## Context\n...\n\n## Acceptance\n- [ ] ...\n",
    ...overrides
  };
}

/**
 * T-0342: pre-registration must be checked against the card as it stood BEFORE the implementer's
 * branch diverged from base -- otherwise a card could add "## Pre-registered experiment" after an
 * empty run to rescue it. `readTaskBodyAtMergeBase` is the git-history primitive that pins "before
 * the run" to the merge-base between the branch and its base, exactly like `gitOps.js`'s
 * `diffNames` (`${baseBranch}...HEAD`) and `plannerDiffGuard.js`'s `collectTasksDiff` already do
 * elsewhere in this codebase -- reusing that same, already-battle-tested git idiom rather than
 * inventing a new one.
 */
describe("readTaskBodyAtMergeBase", () => {
  let tmpDir;
  let repoRoot;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-gittaskhistory-"));
    repoRoot = path.join(tmpDir, "repo");
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await git(["init", "-b", "main"], repoRoot);
    await git(["config", "user.email", "test@example.com"], repoRoot);
    await git(["config", "user.name", "Test"], repoRoot);
    await fs.writeFile(path.join(repoRoot, "README.md"), "root\n", "utf8");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "root"], repoRoot);
    await git(["checkout", "-b", "develop"], repoRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the task body as committed at the point the branch diverged from base", async () => {
    const preRegisteredBody = `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n\n## Acceptance\n- [ ] ...\n`;
    await fs.writeFile(
      path.join(repoRoot, "tasks", "T-0999.md"),
      serializeTask(task({ body: preRegisteredBody })),
      "utf8"
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "card pre-registers an experiment"], repoRoot);
    await git(["checkout", "-b", "feature/T-0999"], repoRoot);

    // A later commit on the feature branch changes the card's body (e.g. adds a Finding section) --
    // the merge-base snapshot must still reflect what was there BEFORE this commit.
    await fs.writeFile(
      path.join(repoRoot, "tasks", "T-0999.md"),
      serializeTask(task({ body: preRegisteredBody + "\n## Finding\ndecisive.\n" })),
      "utf8"
    );
    await git(["commit", "-am", "record finding"], repoRoot);

    const beforeBody = await readTaskBodyAtMergeBase({ cwd: repoRoot, id: "T-0999", baseRef: "develop" });
    expect(beforeBody).toContain(PRE_REGISTRATION_HEADING);
    expect(beforeBody).not.toContain("## Finding");
  });

  it("does NOT see a pre-registration section added only after the branch diverged (the anti-retroactive-registration guarantee)", async () => {
    await fs.writeFile(
      path.join(repoRoot, "tasks", "T-0999.md"),
      serializeTask(task({ body: "## Context\nno pre-registration yet\n\n## Acceptance\n- [ ] ...\n" })),
      "utf8"
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "card created, nothing pre-registered"], repoRoot);
    await git(["checkout", "-b", "feature/T-0999"], repoRoot);

    // The implementer adds pre-registration AND a decisive finding in the same run -- this must
    // never count, since pre-registration has to predate the run it's supposedly gating.
    await fs.writeFile(
      path.join(repoRoot, "tasks", "T-0999.md"),
      serializeTask(
        task({
          body:
            `${PRE_REGISTRATION_HEADING}\nadded retroactively\n\n## Finding\ndecisive, see \`evidence.png\`\n`
        })
      ),
      "utf8"
    );
    await git(["commit", "-am", "retroactively add pre-registration and finding together"], repoRoot);

    const beforeBody = await readTaskBodyAtMergeBase({ cwd: repoRoot, id: "T-0999", baseRef: "develop" });
    expect(beforeBody).not.toContain(PRE_REGISTRATION_HEADING);
  });

  it("returns an empty string when the task file does not exist yet at the merge-base (brand new card)", async () => {
    await git(["checkout", "-b", "feature/T-0999"], repoRoot);
    await fs.writeFile(
      path.join(repoRoot, "tasks", "T-0999.md"),
      serializeTask(task({ body: `${PRE_REGISTRATION_HEADING}\nbrand new card\n` })),
      "utf8"
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "new card"], repoRoot);

    const beforeBody = await readTaskBodyAtMergeBase({ cwd: repoRoot, id: "T-0999", baseRef: "develop" });
    expect(beforeBody).toBe("");
  });

  it("returns an empty string (never throws) for an unresolvable baseRef", async () => {
    const beforeBody = await readTaskBodyAtMergeBase({ cwd: repoRoot, id: "T-0999", baseRef: "no-such-branch" });
    expect(beforeBody).toBe("");
  });

  it("returns an empty string (never throws) when cwd is not a git repository at all", async () => {
    const nonGitDir = path.join(tmpDir, "not-a-repo");
    await fs.mkdir(nonGitDir, { recursive: true });
    const beforeBody = await readTaskBodyAtMergeBase({ cwd: nonGitDir, id: "T-0999", baseRef: "develop" });
    expect(beforeBody).toBe("");
  });
});

/**
 * T-0354: the freshness gate's fs-mode "run start" boundary -- the earliest commit made on this
 * branch beyond `baseRef`, i.e. the implementer's first commit of this run. Deliberately the same
 * coarseness readTaskBodyAtMergeBase already accepts for fs-mode (a per-branch boundary, not a
 * per-attempt one) -- fs-mode task files are the legacy path; db-mode (readRunStartTimestamp in
 * dbTaskHistory.js) is the live board's normal mode and gets the precise per-attempt boundary via
 * card_events.
 */
describe("readRunStartTimestamp", () => {
  let tmpDir;
  let repoRoot;

  async function commitAt(args, cwd, isoDate) {
    await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } });
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-gittaskhistory-runstart-"));
    repoRoot = path.join(tmpDir, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await git(["init", "-b", "main"], repoRoot);
    await git(["config", "user.email", "test@example.com"], repoRoot);
    await git(["config", "user.name", "Test"], repoRoot);
    await fs.writeFile(path.join(repoRoot, "README.md"), "root\n", "utf8");
    await commitAt(["add", "."], repoRoot);
    await commitAt(["commit", "-m", "root"], repoRoot, "2026-01-01T00:00:00Z");
    await git(["checkout", "-b", "develop"], repoRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the date of the earliest commit on the branch beyond baseRef, not the latest", async () => {
    await git(["checkout", "-b", "feature/T-0999"], repoRoot);
    await fs.writeFile(path.join(repoRoot, "gen.py"), "print(1)", "utf8");
    await commitAt(["add", "."], repoRoot);
    await commitAt(["commit", "-m", "first commit of the run"], repoRoot, "2026-09-10T12:00:00Z");

    await fs.writeFile(path.join(repoRoot, "gen.py"), "print(2)", "utf8");
    await commitAt(["add", "."], repoRoot);
    await commitAt(["commit", "-m", "second commit of the run"], repoRoot, "2026-09-10T12:00:09Z");

    const runStartTime = await readRunStartTimestamp({ cwd: repoRoot, baseRef: "develop" });
    expect(runStartTime).toContain("2026-09-10T12:00:00");
  });

  it("falls back to the merge-base's own commit date when the branch has no commits beyond base yet", async () => {
    await git(["checkout", "-b", "feature/T-1000"], repoRoot);

    const runStartTime = await readRunStartTimestamp({ cwd: repoRoot, baseRef: "develop" });
    expect(runStartTime).toContain("2026-01-01T00:00:00");
  });

  it("returns an empty string (never throws) for an unresolvable baseRef", async () => {
    const runStartTime = await readRunStartTimestamp({ cwd: repoRoot, baseRef: "no-such-branch" });
    expect(runStartTime).toBe("");
  });

  it("returns an empty string (never throws) when cwd is not a git repository at all", async () => {
    const nonGitDir = path.join(tmpDir, "not-a-repo");
    await fs.mkdir(nonGitDir, { recursive: true });
    const runStartTime = await readRunStartTimestamp({ cwd: nonGitDir, baseRef: "develop" });
    expect(runStartTime).toBe("");
  });
});
