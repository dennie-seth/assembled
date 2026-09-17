import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";
import { ARTIFACT_CACHE_DIRNAME } from "../src/runner/artifactPreservation.js";

let tmpDir;
let worktreesDir;
let cacheRoot;
let server;
let baseUrl;

// No repoRoot: this suite is about the artifact-cache purge, and leaving repoRoot unset keeps the
// Done-triggered pullDevelop (covered by httpApi.done.test.js) out of the way entirely.
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-artifactcache-"));
  worktreesDir = path.join(tmpDir, "worktrees");
  cacheRoot = path.join(worktreesDir, ARTIFACT_CACHE_DIRNAME);
  const store = new FsTaskStore(tmpDir);
  const idAllocator = new IdAllocator(tmpDir);
  server = await startHttpServer({
    store,
    idAllocator,
    port: 0,
    orchestrator: { worktreesDir, hasActiveRuns: () => false }
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Train the identity LoRA", phase: 1, ...overrides })
  });
  return res.json();
}

async function seedCache(cardId) {
  const filesDir = path.join(cacheRoot, cardId, "files", "assets", "final", "lora");
  await fs.mkdir(filesDir, { recursive: true });
  await fs.writeFile(path.join(filesDir, "v2-step00000024.safetensors"), "weights", "utf8");
}

async function cacheExists(cardId) {
  try {
    await fs.stat(path.join(cacheRoot, cardId));
    return true;
  } catch {
    return false;
  }
}

async function patchStatus(id, status) {
  return fetch(`${baseUrl}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
}

describe("PATCH /api/tasks/:id — preserved-artifact cache cleanup", () => {
  it("clears the card's preserved artifacts when it reaches done", async () => {
    const task = await createTask();
    await seedCache(task.id);

    const res = await patchStatus(task.id, "done");

    expect(res.status).toBe(200);
    expect(await cacheExists(task.id)).toBe(false);
  });

  it("clears them on retired too -- also a status a card never comes back from", async () => {
    const task = await createTask();
    await seedCache(task.id);

    await patchStatus(task.id, "retired");

    expect(await cacheExists(task.id)).toBe(false);
  });

  it("keeps them for a card that is still in flight, so a re-run can still resume", async () => {
    const task = await createTask();
    await seedCache(task.id);

    for (const status of ["ready", "review", "blocked"]) {
      await patchStatus(task.id, status);
      expect(await cacheExists(task.id)).toBe(true);
    }
  });

  it("leaves other cards' caches alone", async () => {
    const [done, other] = [await createTask(), await createTask()];
    await seedCache(done.id);
    await seedCache(other.id);

    await patchStatus(done.id, "done");

    expect(await cacheExists(done.id)).toBe(false);
    expect(await cacheExists(other.id)).toBe(true);
  });

  it("still moves a card to done when it never had a cache at all", async () => {
    const task = await createTask();

    const res = await patchStatus(task.id, "done");

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("done");
  });
});
