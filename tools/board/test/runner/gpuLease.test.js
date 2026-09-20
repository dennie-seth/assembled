import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GPU_SERVER_ID,
  gpuLeasePath,
  acquireGpuLease,
  releaseGpuLease,
  readGpuLease,
  reconcileGpuLeasesOnStartup,
  gpuLeaseEnabledFromEnv,
  GpuLeaseHeldError
} from "../../src/runner/gpuLease.js";

/**
 * T-0371 (WIP gate T-E): one shared, exclusive GPU lease per constrained GPU/ComfyUI server --
 * see docs/gpu-lease.md and docs/gpu-submission-audit.md. Modeled on launchReservation.js's own
 * test suite (T-0370), but the lease itself is EXCLUSIVE (one owner at a time per server), not an
 * additive cost pool -- GPU capacity is its own currency, never summed with USD.
 */

let runsDir;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpu-lease-test-"));
});

afterEach(async () => {
  await fs.rm(runsDir, { recursive: true, force: true });
});

function key(overrides = {}) {
  return { cardId: "T-0001", executionId: "exec-1", invocationId: "inv-1", ...overrides };
}

describe("gpuLeasePath", () => {
  it("is deterministic for the same serverId", () => {
    expect(gpuLeasePath(runsDir, GPU_SERVER_ID)).toBe(gpuLeasePath(runsDir, GPU_SERVER_ID));
  });

  it("differs for a different serverId", () => {
    expect(gpuLeasePath(runsDir, "other-server")).not.toBe(gpuLeasePath(runsDir, GPU_SERVER_ID));
  });

  it("defaults to GPU_SERVER_ID when no serverId is given", () => {
    expect(gpuLeasePath(runsDir)).toBe(gpuLeasePath(runsDir, GPU_SERVER_ID));
  });
});

describe("acquireGpuLease", () => {
  it("writes a lease recording the owner and identity", async () => {
    const entry = await acquireGpuLease({ runsDir, ...key(), owner: "cardLaunch:T-0001", reason: "asset generation" });
    expect(entry).toMatchObject({
      serverId: GPU_SERVER_ID,
      cardId: "T-0001",
      executionId: "exec-1",
      invocationId: "inv-1",
      owner: "cardLaunch:T-0001",
      reason: "asset generation"
    });
    expect(entry.acquiredAt).toEqual(expect.any(String));

    const onDisk = JSON.parse(await fs.readFile(gpuLeasePath(runsDir), "utf8"));
    expect(onDisk).toMatchObject({ cardId: "T-0001" });
  });

  // Acceptance: "a test proves a second controlled GPU launch cannot acquire it while it is held".
  it("refuses a second acquire for a DIFFERENT launch while the lease is held", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" });
    await expect(acquireGpuLease({ runsDir, ...key({ cardId: "T-0002", executionId: "exec-2", invocationId: "inv-2" }), owner: "b" })).rejects.toBeInstanceOf(
      GpuLeaseHeldError
    );
  });

  it("names the current holder in the error", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" });
    await expect(
      acquireGpuLease({ runsDir, ...key({ cardId: "T-0002", executionId: "exec-2", invocationId: "inv-2" }), owner: "b" })
    ).rejects.toThrow(/T-0001/);
  });

  it("refuses re-acquiring the identical key too -- a lease is single-use until released", async () => {
    await acquireGpuLease({ runsDir, ...key(), owner: "a" });
    await expect(acquireGpuLease({ runsDir, ...key(), owner: "a" })).rejects.toBeInstanceOf(GpuLeaseHeldError);
  });

  it("two different servers can each be held independently", async () => {
    const a = await acquireGpuLease({ runsDir, serverId: "server-a", ...key({ cardId: "T-0001" }), owner: "a" });
    const b = await acquireGpuLease({ runsDir, serverId: "server-b", ...key({ cardId: "T-0002" }), owner: "b" });
    expect(a.serverId).toBe("server-a");
    expect(b.serverId).toBe("server-b");
  });

  it("concurrent acquires for the same server: exactly one wins, the other is refused", async () => {
    const [a, b] = await Promise.allSettled([
      acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" }),
      acquireGpuLease({ runsDir, ...key({ cardId: "T-0002", executionId: "exec-2", invocationId: "inv-2" }), owner: "b" })
    ]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
  });

  it("never leaves a half-written lease visible if the write is interrupted before the final link", async () => {
    const linkFn = async () => {
      throw new Error("simulated crash before link");
    };
    await expect(acquireGpuLease({ runsDir, ...key(), owner: "a", linkFn })).rejects.toThrow("simulated crash before link");
    await expect(fs.readFile(gpuLeasePath(runsDir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("acquiring again succeeds once the prior lease has been released", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" });
    await releaseGpuLease({ runsDir, ...key({ cardId: "T-0001" }), outcome: { status: "completed" } });
    const entry = await acquireGpuLease({ runsDir, ...key({ cardId: "T-0002", executionId: "exec-2", invocationId: "inv-2" }), owner: "b" });
    expect(entry.cardId).toBe("T-0002");
  });
});

describe("releaseGpuLease", () => {
  it("releases (removes) a lease held by the matching identity, and is idempotent", async () => {
    await acquireGpuLease({ runsDir, ...key(), owner: "a" });
    const released = await releaseGpuLease({ runsDir, ...key(), outcome: { status: "completed" } });
    expect(released).toMatchObject({ cardId: "T-0001", released: true, outcome: { status: "completed" } });
    expect(await readGpuLease({ runsDir })).toBeNull();

    // Idempotent: releasing again (nothing left to release) does not throw.
    const releasedAgain = await releaseGpuLease({ runsDir, ...key(), outcome: { status: "completed" } });
    expect(releasedAgain).toBeNull();
  });

  it("returns null rather than throwing when no lease was ever recorded", async () => {
    const result = await releaseGpuLease({ runsDir, ...key(), outcome: { status: "completed" } });
    expect(result).toBeNull();
  });

  it("refuses to release a lease held by a DIFFERENT identity -- never lets a stale caller free someone else's lease", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" });
    const result = await releaseGpuLease({ runsDir, ...key({ cardId: "T-0002", executionId: "exec-2", invocationId: "inv-2" }), outcome: { status: "completed" } });
    expect(result).toBeNull();
    // The original holder's lease is untouched.
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-0001" });
  });

  it("frees the server for a new acquire once released", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" });
    await releaseGpuLease({ runsDir, ...key({ cardId: "T-0001" }), outcome: { status: "failed" } });
    await expect(acquireGpuLease({ runsDir, ...key({ cardId: "T-0002", executionId: "exec-2", invocationId: "inv-2" }), owner: "b" })).resolves.toMatchObject({
      cardId: "T-0002"
    });
  });
});

describe("readGpuLease", () => {
  it("returns null when nothing has ever been acquired", async () => {
    expect(await readGpuLease({ runsDir })).toBeNull();
  });

  it("returns the current holder when one is held", async () => {
    await acquireGpuLease({ runsDir, ...key(), owner: "a" });
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-0001", owner: "a" });
  });
});

describe("reconcileGpuLeasesOnStartup -- crash/board-restart recovery", () => {
  it("releases a dangling GPU lease whose card is no longer in-progress/validation", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" });
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "blocked" } : null) };

    const result = await reconcileGpuLeasesOnStartup({ runsDir, store });
    expect(result.released).toEqual([expect.objectContaining({ cardId: "T-0001" })]);
    expect(await readGpuLease({ runsDir })).toBeNull();
  });

  it("leaves a GPU lease alone when its card is still legitimately in-progress", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "a" });
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "in-progress" } : null) };

    const result = await reconcileGpuLeasesOnStartup({ runsDir, store });
    expect(result.released).toEqual([]);
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-0001" });
  });

  it("releases a GPU lease whose card no longer exists at all", async () => {
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-9999" }), owner: "a" });
    const store = { get: async () => null };

    const result = await reconcileGpuLeasesOnStartup({ runsDir, store });
    expect(result.released).toEqual([expect.objectContaining({ cardId: "T-9999" })]);
  });

  it("returns an empty result when nothing has ever been leased", async () => {
    const store = { get: async () => null };
    const result = await reconcileGpuLeasesOnStartup({ runsDir, store });
    expect(result.released).toEqual([]);
  });

  it("logs and leaves a malformed lease file untouched rather than throwing, and never blocks startup", async () => {
    await fs.mkdir(path.join(runsDir, ".gpu-leases"), { recursive: true });
    await fs.writeFile(path.join(runsDir, ".gpu-leases", `${GPU_SERVER_ID}.gpu-lease.json`), "{not json", "utf8");
    const store = { get: async () => null };
    const errorSpy = vi.fn();
    const logger = { log: vi.fn(), error: errorSpy };

    const result = await reconcileGpuLeasesOnStartup({ runsDir, store, logger });
    expect(result.released).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    const untouched = await fs.readFile(path.join(runsDir, ".gpu-leases", `${GPU_SERVER_ID}.gpu-lease.json`), "utf8");
    expect(untouched).toBe("{not json");
  });

  it("never throws when the gpu-leases directory can't be listed at all", async () => {
    const readdirFn = async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const store = { get: async () => null };
    const errorSpy = vi.fn();
    const logger = { log: vi.fn(), error: errorSpy };

    const result = await reconcileGpuLeasesOnStartup({ runsDir, store, logger, readdirFn });
    expect(result.released).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  // Acceptance: "a test proves GPU ownership and the token reservation recover coherently
  // together". Both mechanisms are reconciled against the SAME store/liveness rule, so a card
  // that crashed loses both its GPU lease and its token reservation together, and a card that is
  // still genuinely running keeps both.
  it("recovers GPU ownership and the token reservation coherently together after a simulated crash", async () => {
    const { reserveLaunchSlot, listActiveReservations, reconcileReservationsOnStartup } = await import("../../src/runner/launchReservation.js");
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "cardLaunch:T-0001", reservedCostUsd: 5 });
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "cardLaunch:T-0001" });
    // A second, still-live card holds neither resource in conflict -- distinct identity entirely.
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "blocked" } : null) };

    const [reservationResult, gpuResult] = await Promise.all([
      reconcileReservationsOnStartup({ runsDir, store }),
      reconcileGpuLeasesOnStartup({ runsDir, store })
    ]);

    expect(reservationResult.released).toEqual([expect.objectContaining({ cardId: "T-0001" })]);
    expect(gpuResult.released).toEqual([expect.objectContaining({ cardId: "T-0001" })]);
    expect(await listActiveReservations({ runsDir })).toEqual([]);
    expect(await readGpuLease({ runsDir })).toBeNull();
  });

  it("a still-running card keeps both its GPU lease and its token reservation after reconciliation", async () => {
    const { reserveLaunchSlot, listActiveReservations, reconcileReservationsOnStartup } = await import("../../src/runner/launchReservation.js");
    await reserveLaunchSlot({ runsDir, ...key({ cardId: "T-0001" }), owner: "cardLaunch:T-0001", reservedCostUsd: 5 });
    await acquireGpuLease({ runsDir, ...key({ cardId: "T-0001" }), owner: "cardLaunch:T-0001" });
    const store = { get: async (id) => (id === "T-0001" ? { id, status: "in-progress" } : null) };

    await Promise.all([reconcileReservationsOnStartup({ runsDir, store }), reconcileGpuLeasesOnStartup({ runsDir, store })]);

    expect(await listActiveReservations({ runsDir })).toHaveLength(1);
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-0001" });
  });
});

describe("gpuLeaseEnabledFromEnv", () => {
  const ORIGINAL = process.env.GPU_LEASE_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GPU_LEASE_ENABLED;
    else process.env.GPU_LEASE_ENABLED = ORIGINAL;
  });

  it("defaults to false (off) when unset -- no launch that happens today is refused by default", () => {
    delete process.env.GPU_LEASE_ENABLED;
    expect(gpuLeaseEnabledFromEnv()).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "TRUE"])("is enabled for %s", (value) => {
    process.env.GPU_LEASE_ENABLED = value;
    expect(gpuLeaseEnabledFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", ""])("is disabled for %s", (value) => {
    process.env.GPU_LEASE_ENABLED = value;
    expect(gpuLeaseEnabledFromEnv()).toBe(false);
  });
});
