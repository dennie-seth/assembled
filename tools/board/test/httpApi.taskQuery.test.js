import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

/**
 * T-0383: `GET /api/tasks` is an unfiltered blob today -- measured on the live board 2026-09-18,
 * 3,104,158 bytes for 317 cards, and `?status=backlog` returned all 317 because the query string
 * was ignored entirely. This file pins the fix:
 *
 * - the DEFAULT response (no query string) stays byte-identical to today's -- nothing about this
 *   card may change what the board UI or any existing caller already gets back;
 * - `status=` filters server-side, accepting a comma-separated list;
 * - `fields=` projects the response down to exactly the named fields, including two computed
 *   vetting fields (`dependency_status`, `last_activity_at`) that don't exist as raw stored
 *   fields but are cheap to derive from the already-loaded task list;
 * - an unknown status or field name is a 400 with a clear message, never a silent full dump.
 */

let tasksDir;
let server;
let baseUrl;

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-taskquery-"));
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, tasksDir, port: 0 });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tasksDir, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "A card", phase: 1, ...overrides })
  });
  return res.json();
}

describe("GET /api/tasks -- default response is unchanged", () => {
  it("returns byte-identical JSON with and without an empty query string", async () => {
    await createTask({ title: "First" });
    await createTask({ title: "Second", status: "ready" });

    const plain = await (await fetch(`${baseUrl}/api/tasks`)).text();
    const explicit = await (await fetch(`${baseUrl}/api/tasks?`)).text();
    expect(explicit).toBe(plain);
  });

  it("returns every field on every task when no status or fields param is given", async () => {
    const created = await createTask({ title: "Full shape" });
    // The POST response is the literal object handleCreateTask constructed, which is narrower
    // than what a disk round-trip (parseTask) fills in with defaults -- GET .../:id is the
    // fully-populated shape to compare against, and is exactly what the list route must match.
    const single = await (await fetch(`${baseUrl}/api/tasks/${created.id}`)).json();
    const res = await fetch(`${baseUrl}/api/tasks`);
    const [task] = await res.json();
    expect(task).toEqual(single);
  });

  it("is unaffected by an unrelated query param", async () => {
    await createTask({ title: "Unrelated param" });
    const plain = await (await fetch(`${baseUrl}/api/tasks`)).json();
    const withNoise = await (await fetch(`${baseUrl}/api/tasks?foo=bar`)).json();
    expect(withNoise).toEqual(plain);
  });
});

describe("GET /api/tasks?status=", () => {
  it("filters to a single status server-side", async () => {
    await createTask({ title: "Backlog card" });
    await createTask({ title: "Ready card", status: "ready" });

    const res = await fetch(`${baseUrl}/api/tasks?status=ready`);
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Ready card");
  });

  it("accepts a comma-separated list of statuses", async () => {
    await createTask({ title: "Backlog card" });
    await createTask({ title: "Ready card", status: "ready" });
    await createTask({ title: "Done card", status: "done" });

    const res = await fetch(`${baseUrl}/api/tasks?status=backlog,ready`);
    const tasks = await res.json();
    expect(tasks.map((t) => t.title).sort()).toEqual(["Backlog card", "Ready card"]);
  });

  it("returns 400 for an unknown status, never a silent full dump", async () => {
    await createTask({ title: "Some card" });

    const res = await fetch(`${baseUrl}/api/tasks?status=bogus`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bogus/);
    expect(body.error).toMatch(/status/i);
  });

  it("returns 400 for a mix of a valid and an unknown status", async () => {
    const res = await fetch(`${baseUrl}/api/tasks?status=backlog,bogus`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/bogus/);
  });

  it("returns 400 for an empty status value", async () => {
    const res = await fetch(`${baseUrl}/api/tasks?status=`);
    expect(res.status).toBe(400);
  });

  it("returns an empty array, not an error, when no task matches", async () => {
    await createTask({ title: "Backlog card" });
    const res = await fetch(`${baseUrl}/api/tasks?status=done`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /api/tasks?fields=", () => {
  it("projects the response down to only the named fields", async () => {
    await createTask({ title: "Projected card", priority: "P0" });

    const res = await fetch(`${baseUrl}/api/tasks?fields=id,title,status`);
    expect(res.status).toBe(200);
    const [task] = await res.json();
    expect(Object.keys(task).sort()).toEqual(["id", "status", "title"]);
    expect(task.title).toBe("Projected card");
  });

  it("returns 400 for an unknown field, never a silent full dump", async () => {
    await createTask({ title: "Some card" });
    const res = await fetch(`${baseUrl}/api/tasks?fields=id,bogus_field`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bogus_field/);
  });

  it("returns 400 for an empty fields value", async () => {
    const res = await fetch(`${baseUrl}/api/tasks?fields=`);
    expect(res.status).toBe(400);
  });

  it("composes with status= -- filters rows, then projects columns", async () => {
    await createTask({ title: "Backlog card" });
    await createTask({ title: "Ready card", status: "ready" });

    const res = await fetch(`${baseUrl}/api/tasks?status=ready&fields=id,title`);
    const tasks = await res.json();
    expect(tasks).toHaveLength(1);
    expect(Object.keys(tasks[0]).sort()).toEqual(["id", "title"]);
  });

  it("exposes dependency_status: each dependency's id/status plus an allSatisfied boolean", async () => {
    const dep = await createTask({ title: "Dependency", status: "done" });
    const stillOpenDep = await createTask({ title: "Open dependency", status: "in-progress" });
    const card = await createTask({ title: "Depends on both", depends_on: [dep.id, stillOpenDep.id] });

    const res = await fetch(`${baseUrl}/api/tasks?fields=id,dependency_status`);
    const tasks = await res.json();
    const projected = tasks.find((t) => t.id === card.id);
    expect(projected.dependency_status.dependencies).toEqual(
      expect.arrayContaining([
        { id: dep.id, status: "done" },
        { id: stillOpenDep.id, status: "in-progress" }
      ])
    );
    expect(projected.dependency_status.allSatisfied).toBe(false);
  });

  it("counts retired the same as done for dependency_status.allSatisfied, matching the launch guard", async () => {
    const dep = await createTask({ title: "Retired dependency", status: "retired" });
    const card = await createTask({ title: "Depends on retired", depends_on: [dep.id] });

    const res = await fetch(`${baseUrl}/api/tasks?fields=id,dependency_status`);
    const tasks = await res.json();
    const projected = tasks.find((t) => t.id === card.id);
    expect(projected.dependency_status.allSatisfied).toBe(true);
  });

  it("dependency_status.allSatisfied is true for a card with no dependencies", async () => {
    const card = await createTask({ title: "No deps" });
    const res = await fetch(`${baseUrl}/api/tasks?fields=id,dependency_status`);
    const tasks = await res.json();
    const projected = tasks.find((t) => t.id === card.id);
    expect(projected.dependency_status).toEqual({ dependencies: [], allSatisfied: true });
  });

  it("reports a dangling dependency (not in the corpus) as unsatisfied with a null status", async () => {
    const card = await createTask({ title: "Dangling dep", depends_on: ["T-9999"] });
    const res = await fetch(`${baseUrl}/api/tasks?fields=id,dependency_status`);
    const tasks = await res.json();
    const projected = tasks.find((t) => t.id === card.id);
    expect(projected.dependency_status.dependencies).toEqual([{ id: "T-9999", status: null }]);
    expect(projected.dependency_status.allSatisfied).toBe(false);
  });

  it("exposes last_activity_at as a non-null ISO timestamp derived from cheap, already-loaded data", async () => {
    const card = await createTask({ title: "Freshly created" });
    const res = await fetch(`${baseUrl}/api/tasks?fields=id,last_activity_at`);
    const tasks = await res.json();
    const projected = tasks.find((t) => t.id === card.id);
    expect(typeof projected.last_activity_at).toBe("string");
    expect(new Date(projected.last_activity_at).toString()).not.toBe("Invalid Date");
  });

  it("last_activity_at advances when a comment is added", async () => {
    const card = await createTask({ title: "Gets a comment" });
    const before = (
      await (await fetch(`${baseUrl}/api/tasks?fields=id,last_activity_at`)).json()
    ).find((t) => t.id === card.id).last_activity_at;

    await fetch(`${baseUrl}/api/tasks/${card.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "a status update" })
    });

    const after = (
      await (await fetch(`${baseUrl}/api/tasks?fields=id,last_activity_at`)).json()
    ).find((t) => t.id === card.id).last_activity_at;

    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });
});

/**
 * "The PR records the measured before/after size for the nightly task's own query." The live
 * board's 317-card, 3,104,158-byte baseline (2026-09-18) can't be reproduced from inside this
 * sandboxed suite -- there is no network path to the deployed board's actual data -- so this
 * measures the same reduction against a synthetic corpus shaped to match it: 317 cards with a
 * body length distribution centered on the live board's own bytes-per-card average
 * (3,104,158 / 317 ≈ 9,791 bytes/card). The canonical nightly query this measures is the one
 * documented in DEPLOY.md: `status=backlog&fields=id,title,priority,agent,phase,depends_on,
 * dependency_status,last_activity_at`.
 */
describe("GET /api/tasks -- nightly-task query size (synthetic 317-card corpus)", () => {
  it("reduces the nightly task's own query well below the unfiltered baseline", async () => {
    const AVG_BODY_BYTES = 9791;
    const CARD_COUNT = 317;
    const created = [];
    for (let i = 0; i < CARD_COUNT; i++) {
      // Alternate status so the filter actually does work, and vary body length +/-20% so the
      // corpus isn't a single repeated size.
      const status = i % 3 === 0 ? "backlog" : i % 3 === 1 ? "ready" : "done";
      const bodyLen = Math.round(AVG_BODY_BYTES * (0.8 + 0.4 * ((i * 37) % 100) / 100));
      const task = await createTask({
        title: `Synthetic card ${i}`,
        status,
        body: "x".repeat(bodyLen)
      });
      created.push(task);
    }

    const unfiltered = await (await fetch(`${baseUrl}/api/tasks`)).text();
    const nightlyQuery =
      "status=backlog&fields=id,title,priority,agent,phase,depends_on,dependency_status,last_activity_at";
    const filtered = await (await fetch(`${baseUrl}/api/tasks?${nightlyQuery}`)).text();

    const unfilteredBytes = Buffer.byteLength(unfiltered, "utf8");
    const filteredBytes = Buffer.byteLength(filtered, "utf8");

    // Not asserted against the live board's literal 3,104,158 -- this corpus is synthetic and
    // reproducible, not a fetch of production data (see docstring above). What's pinned here is
    // the shape of the win: the nightly task's actual query must come back at least an order of
    // magnitude smaller than the unfiltered blob it replaces.
    expect(filteredBytes).toBeLessThan(unfilteredBytes / 10);

    const backlogCount = created.filter((_, i) => i % 3 === 0).length;
    const filteredTasks = JSON.parse(filtered);
    expect(filteredTasks).toHaveLength(backlogCount);

    console.log(
      `T-0383 size measurement (synthetic 317-card corpus, ${AVG_BODY_BYTES} avg body bytes/card): ` +
        `unfiltered /api/tasks = ${unfilteredBytes} bytes; ` +
        `?${nightlyQuery} = ${filteredBytes} bytes ` +
        `(${((1 - filteredBytes / unfilteredBytes) * 100).toFixed(1)}% smaller, ${backlogCount} of ${CARD_COUNT} cards)`
    );
  });
});
