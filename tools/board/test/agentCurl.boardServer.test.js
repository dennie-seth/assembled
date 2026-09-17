import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WRAPPER = path.join(REPO_ROOT, "tools", "board", "scripts", "agentCurl.js");

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let repoRoot;
let server;
let port;
let baseUrl;

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

/** Runs the wrapper exactly as a granted agent would, with BOARD_PORT pointed at this server. */
async function agentCurl(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [WRAPPER, ...args], {
      env: { ...process.env, BOARD_PORT: String(port) }
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-agentcurl-live-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);

  const tasksDir = path.join(repoRoot, "tasks");
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, repoRoot, tasksDir, port: 0 });
  ({ port } = server.address());
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function createTask() {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test task", phase: 1 })
  });
  return res.json();
}

/**
 * The whole point of the wrapper, proven against a real board server rather
 * than against the policy function alone: the mutating route an agent used to
 * be able to reach is refused, and the two calls agents legitimately make --
 * read your own card, upload an attachment -- still land.
 */
describe("agentCurl against a real board server", () => {
  it("cannot PATCH a card's status; the card is unchanged afterwards", async () => {
    const task = await createTask();
    expect(task.status).toBe("backlog");

    const result = await agentCurl([
      "PATCH",
      `${baseUrl}/api/tasks/${task.id}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ status: "review" })
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/denied/);

    const after = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(after.status).toBe("backlog");
  });

  it("cannot start a run, comment, or delete the card either", async () => {
    const task = await createTask();
    for (const args of [
      ["POST", `${baseUrl}/api/tasks/${task.id}/run`],
      ["POST", `${baseUrl}/api/tasks/${task.id}/comments`, "-d", '{"body":"hi"}'],
      ["DELETE", `${baseUrl}/api/tasks/${task.id}`]
    ]) {
      const result = await agentCurl(args);
      expect(result.code).toBe(2);
    }
    const after = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    expect(after.status).toBe(200);
  });

  it("still uploads an attachment, which is what the grant exists for", async () => {
    const task = await createTask();
    const file = path.join(repoRoot, "curated.png");
    await fs.writeFile(file, TINY_PNG);

    const result = await agentCurl([
      "POST",
      `${baseUrl}/api/tasks/${task.id}/attachments`,
      "-s",
      "-F",
      `file=@${file}`
    ]);

    expect(result.stderr).not.toMatch(/denied/);
    expect(result.code).toBe(0);

    const after = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(after.attachments.map((a) => a.filename)).toContain("curated.png");
  });

  it("still reads the card and its attachment list", async () => {
    const task = await createTask();
    const read = await agentCurl(["GET", `${baseUrl}/api/tasks/${task.id}`, "-s"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout).id).toBe(task.id);
  });
});
