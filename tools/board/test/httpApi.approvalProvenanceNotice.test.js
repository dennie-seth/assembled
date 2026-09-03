import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

vi.mock("../src/runner/gitOps.js", () => ({
  pullDevelop: vi.fn().mockResolvedValue({ advanced: false, before: "aaa", after: "aaa" }),
  commitTaskFile: vi.fn().mockResolvedValue(undefined),
  commitPaths: vi.fn().mockResolvedValue(undefined),
  autoCommitCardsOnCreateFromEnv: vi.fn(() => false)
}));

/**
 * The live counterpart to `checkApprovalProvenanceDrift.js`'s CI check (T-0286, docs/decision-log.md
 * DL-27), over the real HTTP API: when a human's approval is stamped through either AP-3
 * (drag-to-Done) or AP-4 (an "APPROVED" comment) and the current `ASSET_PROVENANCE.md` in
 * `repoRoot` still reads unapproved for that card, the board posts an informational comment
 * flagging the contradiction -- live, on the same machine, at the exact moment the CI job's
 * fresh-checkout runner never has the data to catch (any card from T-0223 onward lives only in
 * the board's own db, outside git by design). This never blocks the approval itself and never
 * touches ASSET_PROVENANCE.md -- Option A's board record stays authoritative regardless.
 */
let repoRoot;
let tasksDir;
let store;
let server;
let baseUrl;

const HUMAN = { "Content-Type": "application/json", "X-Board-Actor": "board-ui" };

beforeEach(async () => {
  vi.clearAllMocks();
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-provenance-notice-repo-"));
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-provenance-notice-tasks-"));
  store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, tasksDir, repoRoot, port: 0 });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tasksDir, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
});

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
  return fetch(`${baseUrl}/api/tasks/${id}/comments`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function writeProvenance(text) {
  await fs.writeFile(path.join(repoRoot, "ASSET_PROVENANCE.md"), text, "utf8");
}

describe("live approval-time ASSET_PROVENANCE.md staleness notice", () => {
  it("posts an informational comment when a drag-to-Done approval leaves a stale provenance row behind", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    await writeProvenance(`| sheet.png (${task.id} -- not yet approved) | MIT | ... |\n`);

    const updated = await (await patch(task.id, { status: "done" })).json();

    expect(updated.status).toBe("done");
    const notice = updated.comments.find((c) => c.author === "assembled-board");
    expect(notice).toBeDefined();
    expect(notice.text).toContain(task.id);
    expect(notice.text.toLowerCase()).toContain("board");
  });

  it("posts the same notice for an APPROVED-comment approval", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    await writeProvenance(`| sheet.png (${task.id} -- not yet approved) | MIT | ... |\n`);

    const updated = await (await comment(task.id, { author: "DennieSeth", text: "APPROVED" })).json();

    const notice = updated.comments.find((c) => c.text.includes("ASSET_PROVENANCE.md"));
    expect(notice).toBeDefined();
    expect(notice.author).toBe("assembled-board");
  });

  it("posts no notice when the provenance row already agrees with the board", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    await writeProvenance(`| sheet.png (${task.id} -- **APPROVED**) | MIT | ... |\n`);

    const updated = await (await patch(task.id, { status: "done" })).json();

    expect(updated.comments.some((c) => c.author === "assembled-board")).toBe(false);
  });

  it("posts no notice when ASSET_PROVENANCE.md has no row for this card, or does not exist", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    // No writeProvenance call at all -- the file does not exist in this fresh repoRoot.

    const updated = await (await patch(task.id, { status: "done" })).json();

    expect(updated.comments).toHaveLength(0);
  });

  it("never rewrites ASSET_PROVENANCE.md itself -- Option A's board record stays authoritative", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    const original = `| sheet.png (${task.id} -- not yet approved) | MIT | ... |\n`;
    await writeProvenance(original);

    await patch(task.id, { status: "done" });

    expect(await fs.readFile(path.join(repoRoot, "ASSET_PROVENANCE.md"), "utf8")).toBe(original);
  });

  it("does not fail the approval itself when repoRoot has no readable ASSET_PROVENANCE.md at all", async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await patch(task.id, { status: "done" });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("done");
  });
});
