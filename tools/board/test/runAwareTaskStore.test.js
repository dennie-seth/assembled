import { describe, it, expect, vi } from "vitest";
import {
  createRunAwareTaskStore,
  LiveRunTransitionError
} from "../src/lib/runAwareTaskStore.js";

// Fix-plan item #5 from docs/reviews/2026-09-03-run-lifecycle-state-management.md §2.3:
// "store.update(id, {status}) should reject illegal transitions. A live run's card must not be
//  settable to `blocked` by a non-owner ... Enforce at the store boundary so BOTH writers are
//  covered -- this is the invariant that would have prevented every false `blocked` today
//  regardless of how the liveness check behaved."
//
// §1.1 names the two writers: RunOrchestrator (authoritative, in-memory activeCardIds) and
// orphanReaper (inferred from disk, writes `blocked` only). #322 taught the reaper to suppress
// its own writes for an orchestrator-owned card. This is the layer BENEATH that: even a writer
// that never consults ownership cannot blocked-write a card the orchestrator is tracking,
// because the store view it holds refuses.
//
// Ownership is expressed as a CAPABILITY, not a caller identity: the orchestrator keeps the raw
// store, every other consumer gets this guarded view. Nothing has to remember to pass a token,
// and there is no "unidentified caller is trusted" hole.

function fakeStore(initial = []) {
  const tasks = new Map(initial.map((t) => [t.id, { ...t }]));
  return {
    tasks,
    list: vi.fn(async () => [...tasks.values()].map((t) => ({ ...t }))),
    get: vi.fn(async (id) => (tasks.has(id) ? { ...tasks.get(id) } : null)),
    create: vi.fn(async (t) => {
      tasks.set(t.id, { ...t });
      return { ...t };
    }),
    update: vi.fn(async (id, updates) => {
      const merged = { ...tasks.get(id), ...updates, id };
      tasks.set(id, merged);
      return { ...merged };
    }),
    move: vi.fn(async (id, status) => {
      const merged = { ...tasks.get(id), status, id };
      tasks.set(id, merged);
      return { ...merged };
    }),
    remove: vi.fn(async (id) => tasks.delete(id))
  };
}

const card = (over = {}) => ({ id: "T-0001", title: "t", status: "in-progress", ...over });

/** live set stands in for the orchestrator's activeCardIds, shared by reference as in boardServer */
function guarded(initial, liveIds = []) {
  const inner = fakeStore(initial);
  const live = new Set(liveIds);
  const store = createRunAwareTaskStore({ store: inner, isRunLive: (id) => live.has(id) });
  return { store, inner, live };
}

describe("runAwareTaskStore -- blocks a non-owner blocked-write on a live card (review item #5)", () => {
  it("rejects update({status:'blocked'}) for a card the orchestrator is tracking", async () => {
    const { store, inner } = guarded([card()], ["T-0001"]);

    await expect(store.update("T-0001", { status: "blocked" })).rejects.toBeInstanceOf(
      LiveRunTransitionError
    );
    // and the write never reached the underlying store
    expect(inner.update).not.toHaveBeenCalled();
  });

  it("rejects move(id,'blocked') the same way -- move is a status write too", async () => {
    const { store, inner } = guarded([card()], ["T-0001"]);

    await expect(store.move("T-0001", "blocked")).rejects.toBeInstanceOf(LiveRunTransitionError);
    expect(inner.move).not.toHaveBeenCalled();
  });

  it("carries the card id, the attempted status and a 409 statusCode for callers to surface", async () => {
    const { store } = guarded([card()], ["T-0001"]);

    const err = await store.update("T-0001", { status: "blocked" }).catch((e) => e);
    expect(err.taskId).toBe("T-0001");
    expect(err.attemptedStatus).toBe("blocked");
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/T-0001/);
    expect(err.message).toMatch(/live run/i);
  });

  it("leaves the card's real status untouched after a rejected write", async () => {
    const { store } = guarded([card({ status: "in-progress" })], ["T-0001"]);

    await store.update("T-0001", { status: "blocked" }).catch(() => {});

    expect((await store.get("T-0001")).status).toBe("in-progress");
  });
});

describe("runAwareTaskStore -- legitimate transitions still work", () => {
  it("allows blocked when NO run is live for that card", async () => {
    const { store, inner } = guarded([card()], []); // nothing live

    const out = await store.update("T-0001", { status: "blocked" });

    expect(out.status).toBe("blocked");
    expect(inner.update).toHaveBeenCalledOnce();
  });

  it("allows blocked on a live card that is NOT the one being written", async () => {
    const { store } = guarded([card(), card({ id: "T-0002" })], ["T-0002"]);

    expect((await store.update("T-0001", { status: "blocked" })).status).toBe("blocked");
  });

  it("allows every other status on a live card -- only `blocked` is guarded", async () => {
    for (const status of ["in-progress", "validation", "review", "done", "ready", "backlog"]) {
      const { store } = guarded([card()], ["T-0001"]);
      expect((await store.update("T-0001", { status })).status).toBe(status);
    }
  });

  it("allows non-status updates on a live card (comments, attempts, pr, ...)", async () => {
    const { store, inner } = guarded([card()], ["T-0001"]);

    const out = await store.update("T-0001", { attempts: 3, pr: "https://example.invalid/1" });

    expect(out.attempts).toBe(3);
    expect(inner.update).toHaveBeenCalledOnce();
  });

  it("does not guard create/get/list/remove -- it is a status guard, not a lock", async () => {
    const { store, inner } = guarded([card()], ["T-0001"]);

    await store.create(card({ id: "T-0003", status: "blocked" }));
    await store.get("T-0001");
    await store.list();
    await store.remove("T-0001");

    expect(inner.create).toHaveBeenCalledOnce();
    expect(inner.get).toHaveBeenCalled();
    expect(inner.list).toHaveBeenCalledOnce();
    expect(inner.remove).toHaveBeenCalledOnce();
  });
});

describe("runAwareTaskStore -- wiring contract", () => {
  it("reads liveness at write time, not at construction -- the set is shared by reference", async () => {
    const { store, live } = guarded([card()], []);

    expect((await store.update("T-0001", { status: "blocked" })).status).toBe("blocked");

    live.add("T-0001"); // a run starts after the wrapper was built
    await expect(store.update("T-0001", { status: "blocked" })).rejects.toBeInstanceOf(
      LiveRunTransitionError
    );
  });

  it("is a drop-in for the TaskStore interface -- every method is delegated", () => {
    const { store } = guarded([card()], []);
    for (const m of ["list", "get", "create", "update", "move", "remove"]) {
      expect(typeof store[m]).toBe("function");
    }
  });

  it("without an isRunLive predicate it guards nothing, so mis-wiring cannot silently lock the board", async () => {
    const inner = fakeStore([card()]);
    const store = createRunAwareTaskStore({ store: inner });

    expect((await store.update("T-0001", { status: "blocked" })).status).toBe("blocked");
  });
});
