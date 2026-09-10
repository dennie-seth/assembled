import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";
import { ROUND_CAP } from "../src/lib/roundCap.js";

// Same shape as httpApi.approval.test.js: a fake repoRoot plus a mocked gitOps, so writes are
// observable without a real git remote.
vi.mock("../src/runner/gitOps.js", () => ({
  pullDevelop: vi.fn().mockResolvedValue({ advanced: false, before: "aaa", after: "aaa" }),
  commitTaskFile: vi.fn().mockResolvedValue(undefined),
  commitPaths: vi.fn().mockResolvedValue(undefined),
  autoCommitCardsOnCreateFromEnv: vi.fn(() => false)
}));

/**
 * The experiment-round cap (T-0344), end to end over the real HTTP API
 * (docs/board-invariants.md, src/lib/roundCap.js). A card that has settled two rounds without a
 * promoted deliverable cannot be moved to `in-progress` -- manually, the same as via Run -- until
 * a human comments "RESCOPED" (or "/rescope") on it, which resets the round counter.
 */

let tasksDir;
let store;
let server;
let baseUrl;

beforeEach(async () => {
  vi.clearAllMocks();
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-roundcap-"));
  store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({
    store,
    idAllocator,
    tasksDir,
    repoRoot: "/fake/repo",
    port: 0
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tasksDir, { recursive: true, force: true });
});

/** The board UI's own headers -- a person clicking things. */
const HUMAN = { "Content-Type": "application/json", "X-Board-Actor": "board-ui" };
/** What `scripts/agentCurl.js` stamps on every request it forwards. */
const AGENT = { "Content-Type": "application/json", "X-Board-Actor": "agent" };

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: HUMAN,
    body: JSON.stringify({ title: "Test task", phase: 1, ...overrides })
  });
  return res.json();
}

function patch(id, body, headers = HUMAN) {
  return fetch(`${baseUrl}/api/tasks/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
}

function comment(id, body, headers = HUMAN) {
  return fetch(`${baseUrl}/api/tasks/${id}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

describe("round cap: manual PATCH to in-progress is gated the same as Run", () => {
  it("refuses to move a card at the cap to in-progress", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP });

    const res = await patch(task.id, { status: "in-progress" });

    expect(res.status).toBe(409);
    const errBody = await res.json();
    expect(errBody.error ?? JSON.stringify(errBody)).toMatch(/RESCOPED/);
    expect((await store.get(task.id)).status).toBe("blocked");
  });

  it("allows the move below the cap", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP - 1 });

    const res = await patch(task.id, { status: "in-progress" });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("in-progress");
  });
});

describe("round cap: acknowledging a re-scope by comment", () => {
  it("resets the round counter and records who/when, for a card at the cap", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP });

    const res = await comment(task.id, { author: "DennieSeth", text: "RESCOPED" });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.round).toBe(0);
    expect(updated.rescoped_by).toBe("DennieSeth");
    expect(typeof updated.rescoped_at).toBe("string");
  });

  it("keeps the rescoping comment on the card and logs the acknowledgment next to it", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP });

    const res = await comment(task.id, {
      author: "DennieSeth",
      text: "RESCOPED\n\nSwitching to the two-tier compositing approach."
    });

    const updated = await res.json();
    expect(updated.comments[0]).toMatchObject({ author: "DennieSeth" });
    expect(updated.comments[0].text).toMatch(/^RESCOPED/);
    expect(updated.comments[1].author).toBe("assembled-board");
    expect(updated.comments[1].text).toMatch(/RESCOPE RECORDED/);
    expect(updated.comments[1].text).toContain("DennieSeth");
  });

  it("accepts /rescope and is case-insensitive", async () => {
    for (const text of ["/rescope", "rescoped", "  Rescoped  "]) {
      const task = await createTask({ status: "blocked" });
      await store.update(task.id, { round: ROUND_CAP });
      const updated = await (await comment(task.id, { author: "DennieSeth", text })).json();
      expect(updated.round, text).toBe(0);
    }
  });

  it("does NOT rescope on a comment that merely discusses re-scoping", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP });

    const updated = await (
      await comment(task.id, { author: "DennieSeth", text: "not rescoped yet -- still deciding" })
    ).json();

    expect(updated.round).toBe(ROUND_CAP);
    expect(updated.rescoped_by).toBe(null);
  });

  it("does NOT rescope a card that has not reached the cap -- the marker is just a comment there", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP - 1 });

    const updated = await (await comment(task.id, { author: "DennieSeth", text: "RESCOPED" })).json();

    expect(updated.round).toBe(ROUND_CAP - 1);
    expect(updated.rescoped_by).toBe(null);
  });

  it("an agent can never rescope its own capped card", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP });

    const res = await comment(task.id, { author: "DennieSeth", text: "RESCOPED" }, AGENT);

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.round).toBe(ROUND_CAP);
    expect(updated.rescoped_by).toBe(null);
    expect(updated.comments).toHaveLength(1);
  });

  it("unblocks the manual in-progress move once rescoped", async () => {
    const task = await createTask({ status: "blocked" });
    await store.update(task.id, { round: ROUND_CAP });
    await comment(task.id, { author: "DennieSeth", text: "RESCOPED" });

    const res = await patch(task.id, { status: "in-progress" });

    expect(res.status).toBe(200);
  });
});
