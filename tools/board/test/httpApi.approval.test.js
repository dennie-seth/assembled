import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";
import { assertCanMoveToInProgress, UnmetDependencyError } from "../src/lib/dependencyGuard.js";
import { DEFAULT_HUMAN_ACTOR } from "../src/lib/approvalGate.js";

// Same shape as httpApi.done.test.js: a fake repoRoot plus a mocked gitOps, so the Done path's
// deploy pull is observable without a real git remote (and cannot race the temp-dir cleanup).
vi.mock("../src/runner/gitOps.js", () => ({
  pullDevelop: vi.fn().mockResolvedValue({ advanced: false, before: "aaa", after: "aaa" }),
  commitTaskFile: vi.fn().mockResolvedValue(undefined),
  commitPaths: vi.fn().mockResolvedValue(undefined),
  autoCommitCardsOnCreateFromEnv: vi.fn(() => false)
}));

import { pullDevelop } from "../src/runner/gitOps.js";

/**
 * The human direction-approval gate, end to end over the real HTTP API
 * (docs/board-invariants.md §10, src/lib/approvalGate.js).
 *
 * The bug these pin down: a card whose deliverable is a *direction* (concept art, a style
 * sheet) reached `review` on a reviewer PASS and could then be moved to `done` by anything,
 * with nothing recorded about why. `dependencyGuard` counts `done` as satisfied, so that flip
 * released every dependent -- which is how T-0239's unapproved synthetic props sheet unblocked
 * T-0243. The gate does not change the dep-guard at all; it changes *who* may write `done`.
 */

let tasksDir;
let store;
let server;
let baseUrl;

beforeEach(async () => {
  vi.clearAllMocks();
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-approval-"));
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

/** Whether the dep-guard currently lets `id` start -- i.e. whether its dependencies are met. */
async function dependenciesMet(id) {
  try {
    await assertCanMoveToInProgress(store, id);
    return true;
  } catch (err) {
    if (err instanceof UnmetDependencyError) return false;
    throw err;
  }
}

describe("AP-1: a card can be flagged as requiring human approval", () => {
  it("accepts requires_approval at create time and reports it on the card", async () => {
    const task = await createTask({ requires_approval: true });
    expect(task.requires_approval).toBe(true);
    expect(task.approved_by).toBe(null);
    expect(task.approved_at).toBe(null);
  });

  it("defaults to not gated, leaving every existing card's behaviour unchanged", async () => {
    const task = await createTask();
    expect(task.requires_approval).toBe(false);
  });

  it("lets a human add the gate to an existing card, and persists it", async () => {
    const task = await createTask();
    const res = await patch(task.id, { requires_approval: true });
    expect(res.status).toBe(200);
    expect((await res.json()).requires_approval).toBe(true);
    // Read back through the store, not just the response echo: the flag is only a gate if it
    // survives a round-trip through the card's persisted form.
    expect((await store.get(task.id)).requires_approval).toBe(true);
  });
});

describe("AP-4: approval by a human APPROVED comment", () => {
  it("flips a parked gated card to done and records who approved and when", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await comment(task.id, { author: "DennieSeth", text: "APPROVED" });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.status).toBe("done");
    expect(updated.approved_by).toBe("DennieSeth");
    expect(typeof updated.approved_at).toBe("string");
  });

  it("keeps the approving comment on the card and logs the approval next to it", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    const res = await comment(task.id, {
      author: "DennieSeth",
      text: "APPROVED\n\nReads as one vocabulary with v1."
    });

    const updated = await res.json();
    expect(updated.comments[0]).toMatchObject({ author: "DennieSeth" });
    expect(updated.comments[0].text).toMatch(/^APPROVED/);
    expect(updated.comments[1].author).toBe("assembled-board");
    expect(updated.comments[1].text).toMatch(/APPROVAL RECORDED/);
    expect(updated.comments[1].text).toContain("DennieSeth");
  });

  it("accepts /approve and is case-insensitive", async () => {
    for (const text of ["/approve", "approved", "  Approved  "]) {
      const task = await createTask({ requires_approval: true, status: "review" });
      const updated = await (await comment(task.id, { author: "DennieSeth", text })).json();
      expect(updated.status, text).toBe("done");
    }
  });

  it("does NOT approve on a comment that merely discusses approval", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    const updated = await (
      await comment(task.id, { author: "DennieSeth", text: "not approved yet -- the props read as synthetic" })
    ).json();

    expect(updated.status).toBe("review");
    expect(updated.approved_by).toBe(null);
    expect(updated.comments).toHaveLength(1);
  });

  it("does NOT approve a card that is not gated -- the marker is just a comment there", async () => {
    const task = await createTask({ status: "review" });
    const updated = await (await comment(task.id, { author: "DennieSeth", text: "APPROVED" })).json();

    expect(updated.status).toBe("review");
    expect(updated.approved_by).toBe(null);
  });

  it("does NOT approve a gated card that is not parked -- an in-flight run is not up for a verdict", async () => {
    const task = await createTask({ requires_approval: true, status: "in-progress" });
    const updated = await (await comment(task.id, { author: "DennieSeth", text: "APPROVED" })).json();

    expect(updated.status).toBe("in-progress");
    expect(updated.approved_by).toBe(null);
  });

  it("does not re-approve an already-approved card, leaving the first approver's record intact", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    await comment(task.id, { author: "DennieSeth", text: "APPROVED" });
    const first = await store.get(task.id);

    const updated = await (await comment(task.id, { author: "SomeoneElse", text: "APPROVED" })).json();

    expect(updated.approved_by).toBe("DennieSeth");
    expect(updated.approved_at).toBe(first.approved_at);
  });
});

describe("AP-5: an agent can never approve its own work", () => {
  it("ignores an APPROVED marker from an agent-stamped request", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await comment(task.id, { author: "DennieSeth", text: "APPROVED" }, AGENT);

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.status).toBe("review");
    expect(updated.approved_by).toBe(null);
    // The comment is still recorded -- refusing to *approve* is not refusing to speak.
    expect(updated.comments).toHaveLength(1);
  });

  it("ignores an APPROVED marker authored under an agent identity, even from an unstamped request", async () => {
    for (const author of ["assembled-board", "reviewer", "assets", "planner"]) {
      const task = await createTask({ requires_approval: true, status: "review" });
      const updated = await (
        await comment(task.id, { author, text: "APPROVED" }, { "Content-Type": "application/json" })
      ).json();

      expect(updated.status, author).toBe("review");
      expect(updated.approved_by, author).toBe(null);
    }
  });

  it("refuses an agent-stamped PATCH moving a gated card to done", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await patch(task.id, { status: "done" }, AGENT);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/human direction approval/i);
    expect((await store.get(task.id)).status).toBe("review");
  });

  it("refuses an agent-stamped PATCH that tries to remove the gate instead", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await patch(task.id, { requires_approval: false }, AGENT);

    expect(res.status).toBe(409);
    expect((await store.get(task.id)).requires_approval).toBe(true);
  });

  it("refuses ANY request that tries to write the approval record directly", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    for (const headers of [HUMAN, AGENT]) {
      const res = await patch(task.id, { approved_by: "DennieSeth" }, headers);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/approval record is written by the board/i);
    }
    expect((await store.get(task.id)).approved_by).toBe(null);
  });

  it("still lets an agent-stamped PATCH do ordinary, non-approving work on a gated card", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    const res = await patch(task.id, { attempts: 2 }, AGENT);

    expect(res.status).toBe(200);
    expect((await res.json()).attempts).toBe(2);
  });
});

describe("AP-3: approval by moving the card to Done", () => {
  it("records the human who dragged it as the approver", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    const updated = await (await patch(task.id, { status: "done" })).json();

    expect(updated.status).toBe("done");
    // Was "board-ui" -- the transport identity, which named a browser rather than a person and
    // said about as little as the comment path's old "Anonymous". A placeholder actor now
    // resolves to the configured operator (approvalGate's `resolveHumanActor`).
    expect(updated.approved_by).toBe(DEFAULT_HUMAN_ACTOR);
    expect(typeof updated.approved_at).toBe("string");
  });

  it("leaves a non-gated card's Review -> Done flip exactly as it was, with no approval record", async () => {
    const task = await createTask({ status: "review" });

    const updated = await (await patch(task.id, { status: "done" })).json();

    expect(updated.status).toBe("done");
    expect(updated.approved_by).toBe(null);
    expect(updated.approved_at).toBe(null);
  });
});

describe("an approval-by-comment is a full Done, not a lesser one", () => {
  it("triggers the same deploy pull a drag to the Done column does (PULL-1 parity)", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    await comment(task.id, { author: "DennieSeth", text: "APPROVED" });

    expect(pullDevelop).toHaveBeenCalledWith({ repoRoot: "/fake/repo" });
  });

  it("does not trigger it for an ordinary comment that approves nothing", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });

    await comment(task.id, { author: "DennieSeth", text: "needs darker hiding props" });

    expect(pullDevelop).not.toHaveBeenCalled();
  });
});

describe("AP-6: dependents stay blocked until the approval, and unblock on it", () => {
  it("keeps a dependent blocked while the gated card is parked, through either approval route", async () => {
    for (const approve of [
      (id) => patch(id, { status: "done" }),
      (id) => comment(id, { author: "DennieSeth", text: "APPROVED" })
    ]) {
      const gate = await createTask({ requires_approval: true, status: "review" });
      const dependent = await createTask({ depends_on: [gate.id], status: "ready" });

      // Parked: produced and reviewed, but not approved -- the dependent must not move.
      expect(await dependenciesMet(dependent.id)).toBe(false);
      const blocked = await patch(dependent.id, { status: "in-progress" });
      expect(blocked.status).toBe(409);

      await approve(gate.id);

      expect((await store.get(gate.id)).status).toBe("done");
      expect(await dependenciesMet(dependent.id)).toBe(true);
      const unblocked = await patch(dependent.id, { status: "in-progress" });
      expect(unblocked.status).toBe(200);
    }
  });

  it("keeps the dependent blocked when an AGENT tries both approval routes on the gate", async () => {
    const gate = await createTask({ requires_approval: true, status: "review" });
    const dependent = await createTask({ depends_on: [gate.id], status: "ready" });

    await patch(gate.id, { status: "done" }, AGENT);
    await comment(gate.id, { author: "assets", text: "APPROVED" }, AGENT);

    expect((await store.get(gate.id)).status).toBe("review");
    expect(await dependenciesMet(dependent.id)).toBe(false);
  });
});
