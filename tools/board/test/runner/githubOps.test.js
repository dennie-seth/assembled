import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkAvailability,
  findExistingPr,
  findExistingPrRest,
  createPr,
  createPrRest,
  classifyGhError
} from "../../src/runner/githubOps.js";

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
  if [ -f "$STATE/pr-view-fail-message" ]; then
    cat "$STATE/pr-view-fail-message" >&2
    exit 1
  fi
  echo "no pull requests found for branch" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ -f "$STATE/create-fail-message" ]; then
    cat "$STATE/create-fail-message" >&2
    exit 1
  fi
  printf '%s\\n' "$@" > "$STATE/last-create-args"
  echo "https://github.com/example/repo/pull/99"
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "POST" ]; then
  printf '%s\\n' "$@" > "$STATE/last-rest-create-args"
  if [ -f "$STATE/rest-create-fail-message" ]; then
    cat "$STATE/rest-create-fail-message" >&2
    exit 1
  fi
  if [ -f "$STATE/rest-create-result.json" ]; then
    cat "$STATE/rest-create-result.json"
    exit 0
  fi
  echo '{"html_url":"https://github.com/example/repo/pull/199"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '%s\\n' "$@" > "$STATE/last-rest-list-args"
  if [ -f "$STATE/rest-list-fail-message" ]; then
    cat "$STATE/rest-list-fail-message" >&2
    exit 1
  fi
  if [ -f "$STATE/rest-list-result.json" ]; then
    cat "$STATE/rest-list-result.json"
    exit 0
  fi
  echo '[]'
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

describe("classifyGhError", () => {
  it("classifies HTTP 5xx responses as transient", () => {
    expect(classifyGhError("HTTP 503: Service Unavailable (https://api.github.com/graphql)")).toBe("transient");
    expect(classifyGhError("HTTP 502 Bad Gateway")).toBe("transient");
    expect(classifyGhError("HTTP 504 Gateway Timeout")).toBe("transient");
  });

  it("classifies 'No server is currently available' as transient", () => {
    expect(classifyGhError("No server is currently available to handle this request.")).toBe("transient");
  });

  it("classifies secondary rate limit / abuse detection as transient", () => {
    expect(classifyGhError("You have exceeded a secondary rate limit. Please retry-after some time.")).toBe(
      "transient"
    );
    expect(classifyGhError("You have triggered an abuse detection mechanism")).toBe("transient");
  });

  it("classifies 'pull request already exists' as already-exists", () => {
    expect(
      classifyGhError("GraphQL: A pull request already exists for me:feature/T-0200. (createPullRequest)")
    ).toBe("already-exists");
  });

  it("classifies auth and validation errors as terminal (not worth retrying)", () => {
    expect(classifyGhError("HTTP 401: Bad credentials")).toBe("terminal");
    expect(classifyGhError("head and base branches are the same branch")).toBe("terminal");
    expect(classifyGhError("gh: not authenticated")).toBe("terminal");
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

  it("falls back to the REST listing when `gh pr view` (GraphQL) fails transiently", async () => {
    await fs.writeFile(path.join(stateDir, "pr-view-fail-message"), "HTTP 503: Service Unavailable\n");
    await fs.writeFile(
      path.join(stateDir, "rest-list-result.json"),
      JSON.stringify([{ head: { ref: "feature/T-0200" }, html_url: "https://github.com/example/repo/pull/203" }])
    );
    expect(await findExistingPr({ worktreeDir: tmpDir, branch: "feature/T-0200" })).toBe(
      "https://github.com/example/repo/pull/203"
    );
  });

  it("does not fall back to REST when `gh pr view` genuinely reports no PR found", async () => {
    expect(await findExistingPr({ worktreeDir: tmpDir, branch: "feature/T-0200" })).toBeNull();
    await expect(fs.access(path.join(stateDir, "last-rest-list-args"))).rejects.toThrow();
  });
});

describe("findExistingPrRest", () => {
  it("returns null when no open PR matches the branch", async () => {
    await fs.writeFile(
      path.join(stateDir, "rest-list-result.json"),
      JSON.stringify([{ head: { ref: "other-branch" }, html_url: "https://github.com/example/repo/pull/1" }])
    );
    expect(await findExistingPrRest({ worktreeDir: tmpDir, branch: "feature/T-0200" })).toBeNull();
  });

  it("returns the html_url of the open PR matching the branch", async () => {
    await fs.writeFile(
      path.join(stateDir, "rest-list-result.json"),
      JSON.stringify([{ head: { ref: "feature/T-0200" }, html_url: "https://github.com/example/repo/pull/202" }])
    );
    expect(await findExistingPrRest({ worktreeDir: tmpDir, branch: "feature/T-0200" })).toBe(
      "https://github.com/example/repo/pull/202"
    );
  });

  it("returns null (not throw) when the REST call itself fails", async () => {
    await fs.writeFile(path.join(stateDir, "rest-list-fail-message"), "HTTP 503: Service Unavailable\n");
    expect(await findExistingPrRest({ worktreeDir: tmpDir, branch: "feature/T-0200" })).toBeNull();
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

  it("throws an error classified 'transient' on a 503 (no internal retry -- that's the orchestrator's job)", async () => {
    await fs.writeFile(
      path.join(stateDir, "create-fail-message"),
      "HTTP 503: Service Unavailable (https://api.github.com/graphql)\n"
    );
    await expect(
      createPr({ worktreeDir: tmpDir, base: "develop", head: "feature/T-0200", title: "t", body: "b" })
    ).rejects.toMatchObject({ ghClassification: "transient" });
  });

  it("throws an error classified 'already-exists' when gh reports a duplicate PR", async () => {
    await fs.writeFile(
      path.join(stateDir, "create-fail-message"),
      "GraphQL: A pull request already exists for me:feature/T-0200. (createPullRequest)\n"
    );
    await expect(
      createPr({ worktreeDir: tmpDir, base: "develop", head: "feature/T-0200", title: "t", body: "b" })
    ).rejects.toMatchObject({ ghClassification: "already-exists" });
  });

  it("throws an error classified 'terminal' on an auth failure", async () => {
    await fs.writeFile(path.join(stateDir, "create-fail-message"), "HTTP 401: Bad credentials\n");
    await expect(
      createPr({ worktreeDir: tmpDir, base: "develop", head: "feature/T-0200", title: "t", body: "b" })
    ).rejects.toMatchObject({ ghClassification: "terminal" });
  });
});

describe("createPrRest", () => {
  it("opens a PR via the REST API (repos/{owner}/{repo}/pulls) and returns its html_url", async () => {
    await fs.writeFile(
      path.join(stateDir, "rest-create-result.json"),
      JSON.stringify({ html_url: "https://github.com/example/repo/pull/201" })
    );
    const url = await createPrRest({
      worktreeDir: tmpDir,
      base: "develop",
      head: "feature/T-0200",
      title: "t",
      body: "b"
    });
    expect(url).toBe("https://github.com/example/repo/pull/201");

    const args = await fs.readFile(path.join(stateDir, "last-rest-create-args"), "utf8");
    expect(args).toContain("api\n--method\nPOST\nrepos/{owner}/{repo}/pulls");
    expect(args).toContain("title=t");
    expect(args).toContain("head=feature/T-0200");
    expect(args).toContain("base=develop");
  });

  it("classifies a REST failure the same way as a GraphQL failure", async () => {
    await fs.writeFile(path.join(stateDir, "rest-create-fail-message"), "HTTP 503: Service Unavailable\n");
    await expect(
      createPrRest({ worktreeDir: tmpDir, base: "develop", head: "feature/T-0200", title: "t", body: "b" })
    ).rejects.toMatchObject({ ghClassification: "transient" });
  });

  it("classifies an already-exists REST failure (422) the same as GraphQL", async () => {
    await fs.writeFile(
      path.join(stateDir, "rest-create-fail-message"),
      "HTTP 422: A pull request already exists for me:feature/T-0200.\n"
    );
    await expect(
      createPrRest({ worktreeDir: tmpDir, base: "develop", head: "feature/T-0200", title: "t", body: "b" })
    ).rejects.toMatchObject({ ghClassification: "already-exists" });
  });
});
