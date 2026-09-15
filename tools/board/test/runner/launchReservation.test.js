import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reservationLeasePath,
  reserveLaunchSlot,
  releaseReservation,
  listActiveReservations,
  sumActiveReservedCostUsd,
  remainingReservedCostUsd,
  reconcileReservationsOnStartup,
  DuplicateReservationError,
  ReservationPoolReadError
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

  // T-0370 fix round 2 finding 5: "in every helper that sums lease costs, never 0" for an unknown cost.
  it("is an explicit unknown (null), never 0, when any active reservation's own reservedCostUsd is unknown", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 2 });
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0002" }), owner: "b", reservedCostUsd: null });

    const active = await listActiveReservations({ runsDir });
    expect(sumActiveReservedCostUsd(active)).toBeNull();
  });
});

describe("remainingReservedCostUsd -- T-0370 fix round finding 6: a live reservation is counted at its REMAINING future cost", () => {
  it("subtracts what the execution has already charged from the raw reserved amount", () => {
    expect(remainingReservedCostUsd({ reservedCostUsd: 10 }, 4)).toBe(6);
  });

  it("never goes negative when the execution charged more than was reserved", () => {
    expect(remainingReservedCostUsd({ reservedCostUsd: 10 }, 15)).toBe(0);
  });

  it("treats a non-numeric spend as nothing spent", () => {
    expect(remainingReservedCostUsd({ reservedCostUsd: 10 }, null)).toBe(10);
  });

  // T-0370 fix round 2 finding 5: a non-numeric reservedCostUsd is an explicit UNKNOWN cost, never
  // "nothing reserved" -- this assertion changes from the round-1 value (0) because round 1's
  // "nothing reserved" reading is exactly the unknown-as-zero bug round 2 requires fixed (a launch
  // with an unknown cost estimate must count as unknown, not free, to every later admission).
  it("is an explicit unknown (null), never 0, when reservedCostUsd is not a finite non-negative number", () => {
    expect(remainingReservedCostUsd({ reservedCostUsd: null }, 4)).toBeNull();
    expect(remainingReservedCostUsd({ reservedCostUsd: "10" }, 4)).toBeNull();
    expect(remainingReservedCostUsd({ reservedCostUsd: -1 }, 4)).toBeNull();
    expect(remainingReservedCostUsd({ reservedCostUsd: NaN }, 4)).toBeNull();
  });
});

describe("remainingReservedCostUsd / reserveLaunchSlot -- T-0370 fix round 2 finding 3: prior spend subtracted exactly once", () => {
  it("a lease written with a charged-usage baseline subtracts only spend AFTER that baseline, not the full lifetime spend again", async () => {
    // The lease already nets out the $4 spent before it was written (cycle $7 - prior spend $4 =
    // remaining $3, stored alongside the $4 baseline it was computed against).
    const entry = await reserveLaunchSlot({
      runsDir,
      ...key(),
      owner: "a",
      reservedCostUsd: 3,
      chargedAtReservationUsd: 4
    });
    expect(entry.chargedAtReservationUsd).toBe(4);

    // A later reader passing the execution's TOTAL lifetime spend ($4 -- nothing new since the
    // lease was written) must count the full $3 remaining, not $3 - $4 clamped to 0.
    expect(remainingReservedCostUsd(entry, 4)).toBe(3);
  });

  it("subtracts only the spend that happened after the baseline once more usage is charged", async () => {
    const entry = await reserveLaunchSlot({
      runsDir,
      ...key(),
      owner: "a",
      reservedCostUsd: 3,
      chargedAtReservationUsd: 4
    });
    // $2 more was charged since the lease was written (total lifetime spend now $6).
    expect(remainingReservedCostUsd(entry, 6)).toBe(1);
  });

  it("defaults chargedAtReservationUsd to 0 for a lease written without one (backward compatible with round-1 leases)", async () => {
    const entry = await reserveLaunchSlot({ runsDir, ...key(), owner: "a", reservedCostUsd: 10 });
    expect(entry.chargedAtReservationUsd).toBe(0);
    expect(remainingReservedCostUsd(entry, 4)).toBe(6);
  });
});

describe("listActiveReservations -- T-0370 fix round finding 1: an unreadable/malformed lease never silently disappears", () => {
  it("throws ReservationPoolReadError instead of silently skipping a malformed lease file", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 2 });
    await fs.writeFile(path.join(runsDir, ".launch-reservations", "corrupt.reservation.json"), "{not json", "utf8");

    await expect(listActiveReservations({ runsDir })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });

  it("throws ReservationPoolReadError (never an empty pool) when the reservation directory can't be listed for a reason other than ENOENT", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 2 });
    const readdirFn = async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    await expect(listActiveReservations({ runsDir, readdirFn })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });
});

describe("listActiveReservations -- T-0370 fix round 2 finding 5: every parsed lease is validated, not just JSON-parseable", () => {
  async function writeRawLease(name, content) {
    await fs.mkdir(path.join(runsDir, ".launch-reservations"), { recursive: true });
    await fs.writeFile(path.join(runsDir, ".launch-reservations", name), content, "utf8");
  }

  it("throws ReservationPoolReadError for a lease that parses to JSON null", async () => {
    await writeRawLease("T-0001-execexec-1-invinv-1.reservation.json", "null");
    await expect(listActiveReservations({ runsDir })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });

  it("throws ReservationPoolReadError for a lease that parses to a bare number", async () => {
    await writeRawLease("T-0001-execexec-1-invinv-1.reservation.json", "42");
    await expect(listActiveReservations({ runsDir })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });

  it("throws ReservationPoolReadError for a lease that parses to an array", async () => {
    await writeRawLease("T-0001-execexec-1-invinv-1.reservation.json", "[]");
    await expect(listActiveReservations({ runsDir })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });

  it("throws ReservationPoolReadError when the lease identity does not match its file name", async () => {
    await writeRawLease(
      "T-0001-execexec-1-invinv-1.reservation.json",
      JSON.stringify({ cardId: "T-9999", executionId: "exec-1", invocationId: "inv-1", released: false, reservedCostUsd: 1 })
    );
    await expect(listActiveReservations({ runsDir })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });

  it("throws ReservationPoolReadError when an identity field is missing", async () => {
    await writeRawLease(
      "T-0001-execexec-1-invinv-1.reservation.json",
      JSON.stringify({ cardId: "T-0001", invocationId: "inv-1", released: false, reservedCostUsd: 1 })
    );
    await expect(listActiveReservations({ runsDir })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });

  it("throws ReservationPoolReadError when released is not a boolean", async () => {
    await writeRawLease(
      "T-0001-execexec-1-invinv-1.reservation.json",
      JSON.stringify({ cardId: "T-0001", executionId: "exec-1", invocationId: "inv-1", released: "no", reservedCostUsd: 1 })
    );
    await expect(listActiveReservations({ runsDir })).rejects.toBeInstanceOf(ReservationPoolReadError);
  });

  it("accepts a validly-shaped lease with an unknown (null) reservedCostUsd -- shape validation is independent of cost validation", async () => {
    await writeRawLease(
      "T-0001-execexec-1-invinv-1.reservation.json",
      JSON.stringify({ cardId: "T-0001", executionId: "exec-1", invocationId: "inv-1", released: false, reservedCostUsd: null })
    );
    const active = await listActiveReservations({ runsDir });
    expect(active).toHaveLength(1);
    expect(active[0].reservedCostUsd).toBeNull();
  });
});

describe("reserveLaunchSlot -- T-0370 fix round finding 1: atomic write", () => {
  it("never leaves a half-written lease visible at its final path even if the write is interrupted after the content lands on disk but before the final link", async () => {
    // Simulate a crash between "temp file fully written" and "linked into place": the caller
    // sees the write fail, and the final path must not exist at all -- not present-but-truncated.
    const linkFn = async () => {
      throw new Error("simulated crash before link");
    };
    await expect(reserveLaunchSlot({ runsDir, ...key(), owner: "a", reservedCostUsd: 2, linkFn })).rejects.toThrow(
      "simulated crash before link"
    );
    await expect(fs.readFile(reservationLeasePath(runsDir, key()), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

describe("reconcileReservationsOnStartup -- T-0370 follow-up: board startup is never blocked by an unreadable reservation pool", () => {
  it("logs and skips a malformed lease file instead of throwing ReservationPoolReadError, and still reconciles a well-formed dangling lease beside it", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: 4 });
    await fs.writeFile(path.join(runsDir, ".launch-reservations", "corrupt.reservation.json"), "{not json", "utf8");
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "blocked" } : null) };
    const errorSpy = vi.fn();
    const logger = { log: vi.fn(), error: errorSpy };

    const result = await reconcileReservationsOnStartup({ runsDir, store, logger });

    // The readable dangling lease is still released even though an unreadable one sits beside it.
    // (listActiveReservations itself would still throw here -- the malformed file is left in the
    // pool on purpose -- so read the specific lease file directly instead.)
    expect(result.released).toEqual([expect.objectContaining({ cardId: "T-0001" })]);
    const leaseOnDisk = JSON.parse(await fs.readFile(reservationLeasePath(runsDir, key({ cardId: "T-0001" })), "utf8"));
    expect(leaseOnDisk.released).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt.reservation.json"));

    // The malformed file itself is left exactly as it was -- never deleted or rewritten.
    const corruptContents = await fs.readFile(path.join(runsDir, ".launch-reservations", "corrupt.reservation.json"), "utf8");
    expect(corruptContents).toBe("{not json");
  });

  it("logs and continues, reconciling nothing, when the reservation directory itself can't be listed", async () => {
    const readdirFn = async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const store = { get: async () => null };
    const errorSpy = vi.fn();
    const logger = { log: vi.fn(), error: errorSpy };

    const result = await reconcileReservationsOnStartup({ runsDir, store, logger, readdirFn });

    expect(result.released).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  // T-0370 fix round 2 finding 5: the new valid-JSON-but-malformed-shape cases (null, identity
  // mismatch, non-boolean released) must be just as tolerated at startup as an unparseable file --
  // logged and left untouched, never stopping reconciliation of a valid lease beside them.
  it("logs and leaves a valid-JSON but malformed-shape lease untouched, and still reconciles a valid lease -- including one with an unknown cost -- beside it", async () => {
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "a", reservedCostUsd: null });
    await fs.mkdir(path.join(runsDir, ".launch-reservations"), { recursive: true });
    await fs.writeFile(path.join(runsDir, ".launch-reservations", "T-9999-execexec-1-invinv-1.reservation.json"), "null", "utf8");
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "blocked" } : null) };
    const errorSpy = vi.fn();
    const logger = { log: vi.fn(), error: errorSpy };

    const result = await reconcileReservationsOnStartup({ runsDir, store, logger });

    expect(result.released).toEqual([expect.objectContaining({ cardId: "T-0001" })]);
    const leaseOnDisk = JSON.parse(await fs.readFile(reservationLeasePath(runsDir, key({ cardId: "T-0001" })), "utf8"));
    expect(leaseOnDisk.released).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("T-9999-execexec-1-invinv-1.reservation.json"));

    const untouched = await fs.readFile(path.join(runsDir, ".launch-reservations", "T-9999-execexec-1-invinv-1.reservation.json"), "utf8");
    expect(untouched).toBe("null");
  });
});
