import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reservationLeasePath,
  reserveLaunchSlot,
  releaseReservation,
  listActiveReservations,
  sumActiveReservedCostUsd,
  reconcileReservationsOnStartup,
  DuplicateReservationError
} from "../../src/runner/launchReservation.js";

let runsDir;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "launch-reservation-test-"));
});

afterEach(async () => {
  await fs.rm(runsDir, { recursive: true, force: true });
});

function key(overrides = {}) {
  return { cardId: "T-0001", executionId: "exec-1", invocationId: "inv-1", ...overrides };
}

describe("reservationLeasePath", () => {
  it("is deterministic for the same (cardId, executionId, invocationId) key", () => {
    expect(reservationLeasePath(runsDir, key())).toBe(reservationLeasePath(runsDir, key()));
  });

  it("differs when any part of the key differs", () => {
    const base = reservationLeasePath(runsDir, key());
    expect(reservationLeasePath(runsDir, key({ executionId: "exec-2" }))).not.toBe(base);
    expect(reservationLeasePath(runsDir, key({ invocationId: "inv-2" }))).not.toBe(base);
  });
});

describe("reserveLaunchSlot", () => {
  it("writes a lease recording the owner, the reserved cost, and the windows it applies to", async () => {
    const entry = await reserveLaunchSlot({
      runsDir,
      ...key(),
      owner: "cardLaunch:T-0001",
      reservedCostUsd: 3.5,
      windows: ["five_hour", "seven_day"],
      reason: "reserved execution cycle for T-0001"
    });
    expect(entry).toMatchObject({
      cardId: "T-0001",
      executionId: "exec-1",
      invocationId: "inv-1",
      owner: "cardLaunch:T-0001",
      reservedCostUsd: 3.5,
      windows: ["five_hour", "seven_day"],
      released: false
    });

    const onDisk = JSON.parse(await fs.readFile(reservationLeasePath(runsDir, key()), "utf8"));
    expect(onDisk).toMatchObject({ cardId: "T-0001", reservedCostUsd: 3.5, released: false });
  });

  it("refuses to double-reserve the identical (cardId, executionId, invocationId) key", async () => {
    await reserveLaunchSlot({ runsDir, ...key(), owner: "a", reservedCostUsd: 1 });
    await expect(reserveLaunchSlot({ runsDir, ...key(), owner: "b", reservedCostUsd: 2 })).rejects.toBeInstanceOf(
      DuplicateReservationError
    );
  });

  it("two concurrent reservations for different launches both persist their full reserved amount -- neither clobbers the other", async () => {
    const [a, b] = await Promise.all([
      reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 2 }),
      reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0002" }), owner: "b", reservedCostUsd: 3 })
    ]);
    expect(a.reservedCostUsd).toBe(2);
    expect(b.reservedCostUsd).toBe(3);

    const active = await listActiveReservations({ runsDir });
    expect(active).toHaveLength(2);
    expect(sumActiveReservedCostUsd(active)).toBe(5);
  });
});

describe("listActiveReservations / sumActiveReservedCostUsd", () => {
  it("excludes released leases from the active list and the sum", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 2 });
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0002" }), owner: "b", reservedCostUsd: 3 });
    await releaseReservation({ runsDir, ...key({ cardId: "T-0001" }), outcome: { status: "completed" } });

    const active = await listActiveReservations({ runsDir });
    expect(active.map((r) => r.cardId)).toEqual(["T-0002"]);
    expect(sumActiveReservedCostUsd(active)).toBe(3);
  });

  it("returns an empty list when runsDir has never been written to", async () => {
    const missing = path.join(runsDir, "never-created");
    expect(await listActiveReservations({ runsDir: missing })).toEqual([]);
    expect(sumActiveReservedCostUsd(await listActiveReservations({ runsDir: missing }))).toBe(0);
  });
});

describe("releaseReservation", () => {
  it("marks a lease released with an outcome and a timestamp, and is idempotent", async () => {
    await reserveLaunchSlot({ runsDir, ...key(), owner: "a", reservedCostUsd: 2 });
    const released = await releaseReservation({ runsDir, ...key(), outcome: { status: "completed" } });
    expect(released.released).toBe(true);
    expect(released.outcome).toEqual({ status: "completed" });
    expect(released.releasedAt).toEqual(expect.any(String));

    // Idempotent: releasing an already-released lease again does not throw and keeps it released.
    const releasedAgain = await releaseReservation({ runsDir, ...key(), outcome: { status: "failed" } });
    expect(releasedAgain.released).toBe(true);
  });

  it("returns null rather than throwing when no lease was ever recorded for this key", async () => {
    const result = await releaseReservation({ runsDir, ...key(), outcome: { status: "completed" } });
    expect(result).toBeNull();
  });
});

describe("reconcileReservationsOnStartup", () => {
  it("releases a dangling reservation whose card is no longer in-progress/validation (crash recovery)", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 4 });
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "blocked" } : null) };

    const result = await reconcileReservationsOnStartup({ runsDir, store });
    expect(result.released).toEqual([expect.objectContaining({ cardId: "T-0001" })]);

    const active = await listActiveReservations({ runsDir });
    expect(active).toEqual([]);
  });

  it("leaves a reservation alone when its card is still legitimately in-progress", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 4 });
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "in-progress" } : null) };

    const result = await reconcileReservationsOnStartup({ runsDir, store });
    expect(result.released).toEqual([]);

    const active = await listActiveReservations({ runsDir });
    expect(active).toHaveLength(1);
  });

  it("releases a reservation whose card no longer exists at all", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-9999" }), owner: "a", reservedCostUsd: 1 });
    const store = { get: async () => null };

    const result = await reconcileReservationsOnStartup({ runsDir, store });
    expect(result.released).toEqual([expect.objectContaining({ cardId: "T-9999" })]);
  });

  it("leaves the reserved budget coherent after reconciling a mix of live, dead, and completed reservations", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 2 });
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0002" }), owner: "b", reservedCostUsd: 3 });
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0003" }), owner: "c", reservedCostUsd: 5 });
    await releaseReservation({ runsDir, ...key({ cardId: "T-0003" }), outcome: { status: "completed" } });

    const store = {
      get: async (id) => {
        if (id === "T-0001") return { id, status: "in-progress" }; // still legitimately running
        if (id === "T-0002") return { id, status: "blocked" }; // crashed -- dangling
        return null;
      }
    };

    await reconcileReservationsOnStartup({ runsDir, store });
    const active = await listActiveReservations({ runsDir });
    expect(active.map((r) => r.cardId)).toEqual(["T-0001"]);
    expect(sumActiveReservedCostUsd(active)).toBe(2);
  });
});
