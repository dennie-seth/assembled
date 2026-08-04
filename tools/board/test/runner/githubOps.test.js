import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAvailability, findExistingPr, createPr } from "../../src/runner/githubOps.js";

const FAKE_GH = `#!/usr/bin/env bash
set -e
STATE="$FAKE_GH_STATE"
if [ "$1" = "--version" ]; then
  if [ -f "$STATE/version-fail" ]; then exit 1; fi
  echo "gh version 2.0.0 (fake)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "$STATE/auth-fail" ]; then exit 1; fi
  echo "Logged in to github.com as fake-user"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$STATE/existing-pr-url" ]; then
    cat "$STATE/existing-pr-url" | xargs -I{} echo "{\\"url\\":\\"{}\\"}"
    exit 0
  fi
  echo "no pull requests found for branch" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "$STATE/last-create-args"
  echo "https://github.com/example/repo/pull/99"
  exit 0
fi
echo "unknown gh invocation: $@" >&2
exit 1
`;

let tmpDir;
let binDir;
let stateDir;
let originalPath;
let originalState;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-githubops-"));
  binDir = path.join(tmpDir, "bin");
  stateDir = path.join(tmpDir, "state");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "gh"), FAKE_GH, { mode: 0o755 });

  originalPath = process.env.PATH;
  originalState = process.env.FAKE_GH_STATE;
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FAKE_GH_STATE = stateDir;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  process.env.FAKE_GH_STATE = originalState;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("checkAvailability", () => {
  it("reports available when gh is installed and authenticated", async () => {
    expect(await checkAvailability({ worktreeDir: tmpDir })).toEqual({ available: true, reason: null });
  });

  it("reports not-installed when gh --version fails (gh missing)", async () => {
    await fs.writeFile(path.join(stateDir, "version-fail"), "");
    expect(await checkAvailability({ worktreeDir: tmpDir })).toEqual({
      available: false,
      reason: "not-installed"
    });
  });

  it("reports not-authenticated when gh is installed but auth status fails", async () => {
    await fs.writeFile(path.join(stateDir, "auth-fail"), "");
    expect(await checkAvailability({ worktreeDir: tmpDir })).toEqual({
      available: false,
      reason: "not-authenticated"
    });
  });
});

describe("findExistingPr", () => {
  it("returns null when no PR exists for the branch", async () => {
    expect(await findExistingPr({ worktreeDir: tmpDir, branch: "feature/T-0200" })).toBeNull();
  });

  it("returns the PR url when one already exists for the branch", async () => {
    await fs.writeFile(path.join(stateDir, "existing-pr-url"), "https://github.com/example/repo/pull/7");
    expect(await findExistingPr({ worktreeDir: tmpDir, branch: "feature/T-0200" })).toBe(
      "https://github.com/example/repo/pull/7"
    );
  });
});

describe("createPr", () => {
  it("creates a PR and returns its URL", async () => {
    const url = await createPr({
      worktreeDir: tmpDir,
      base: "develop",
      head: "feature/T-0200",
      title: "T-0200: Some card",
      body: "the body"
    });
    expect(url).toBe("https://github.com/example/repo/pull/99");

    const args = await fs.readFile(path.join(stateDir, "last-create-args"), "utf8");
    expect(args).toContain("pr\ncreate");
    expect(args).toContain("--base\ndevelop");
    expect(args).toContain("--head\nfeature/T-0200");
    expect(args).toContain("--title\nT-0200: Some card");
    expect(args).toContain("--body\nthe body");
  });
});
