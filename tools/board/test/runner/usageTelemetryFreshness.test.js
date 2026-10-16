import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WINDOW_KINDS,
  READING_STATUS,
  PROBEABLE_WINDOW_KINDS,
  DEFAULT_MAX_STALENESS_MS,
  readWindowUsage,
  readUsageTelemetry
} from "../../src/runner/usageTelemetry.js";
import { createAutoLaunchPoller, DEFAULT_PROBE_BOUND_MS } from "../../src/runner/autoLaunchPoller.js";
import { rmTemp } from "../helpers/rmTemp.js";

/**
 * T-0438: the WIP gate's usage comparison logged `five_hour=unknown(stale)
 * seven_day=unknown(unavailable)` on every tick for 48 hours on the live board, because telemetry
 * only ever arrives as a byproduct of a real card run -- on an idle board (or one ticking every
 * 30 minutes per AUTO_LAUNCH_INTERVAL_MS, above the 15-minute five_hour staleness bound), there is
 * nothing fresh to read at decision time. This file pins the decision-time probe that fixes the
 * five_hour side (a minimal `claude` CLI preflight, triggered only when the log-scan reading is
 * not already fresh) and the evidence-based decision to leave seven_day alone (see
 * docs/usage-telemetry.md: no seven_day rate_limit_event has been observed anywhere in
 * tasks/.runs/*.jsonl since 2026-09-23, 23+ days and hundreds of runs ago, while five_hour fires on
 * essentially every run including this card's own).
 */

const NOW_MS = 1_788_000_000_000;
const FUTURE_RESETS_AT = Math.floor(NOW_MS / 1000) + 3600;
const PAST_RESETS_AT = Math.floor(NOW_MS / 1000) - 3600;

function rateLimitEvent(info, { receivedAtMs } = {}) {
  const event = {
    type: "rate_limit_event",
    rate_limit_info: info,
    uuid: "54d022f9-8efd-43e7-a49f-67cac9a3e682",
    session_id: "18d5c168-5e17-4062-8f5a-4d502597766f"
  };
  if (typeof receivedAtMs === "number") event.receivedAtMs = receivedAtMs;
  return event;
}

function fiveHourAllowed(overrides = {}) {
  return {
    status: "allowed",
    resetsAt: FUTURE_RESETS_AT,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    ...overrides
  };
}

function sevenDayAllowed(overrides = {}) {
  return {
    status: "allowed",
    resetsAt: FUTURE_RESETS_AT + 6 * 24 * 3600,
    rateLimitType: "seven_day",
    isUsingOverage: false,
    ...overrides
  };
}

describe("PROBEABLE_WINDOW_KINDS", () => {
  it("names exactly five_hour -- seven_day is deliberately excluded (see docs/usage-telemetry.md)", () => {
    expect(PROBEABLE_WINDOW_KINDS).toEqual(["five_hour"]);
    for (const kind of PROBEABLE_WINDOW_KINDS) {
      expect(WINDOW_KINDS).toContain(kind);
    }
  });
});

describe("readWindowUsage -- decision-time probe (T-0438)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-freshness-"));
  });

  afterEach(async () => {
    await rmTemp(runsDir);
  });

  async function writeLog(name, events, mtimeMs) {
    const filePath = path.join(runsDir, name);
    const stamped = events.map((e) =>
      e && e.type === "rate_limit_event" && typeof e.receivedAtMs !== "number" && mtimeMs !== undefined
        ? { ...e, receivedAtMs: mtimeMs }
        : e
    );
    await fs.writeFile(filePath, stamped.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    if (mtimeMs !== undefined) await fs.utimes(filePath, new Date(mtimeMs), new Date(mtimeMs));
    return filePath;
  }

  it("a stale scan result is replaced by a fresh, measured probe reading", async () => {
    await writeLog(
      "T-0001.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.6 }))],
      NOW_MS - (DEFAULT_MAX_STALENESS_MS.five_hour + 60_000)
    );
    const probeFn = vi.fn(async () => ({ rateLimitInfo: fiveHourAllowed({ status: "allowed_warning", utilization: 0.42 }) }));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(probeFn).toHaveBeenCalledWith({ windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.MEASURED);
    expect(reading.utilization).toBe(0.42);
    expect(reading.ageMs).toBe(0);
    expect(reading.timingTrusted).toBe(true);
    expect(reading.foundVia).toBe("probe");
  });

  it("an unavailable scan result (no matching telemetry anywhere) is replaced by a fresh probe reading", async () => {
    const probeFn = vi.fn(async () => ({ rateLimitInfo: fiveHourAllowed() }));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(reading.classification).toBe(READING_STATUS.ESTIMATED);
    expect(reading.utilization).toBe(0);
    expect(reading.foundVia).toBe("probe");
  });

  it("does not probe when the scan result is already fresh -- a recent real run already paid for this reading", async () => {
    await writeLog("T-0001.jsonl", [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.3 }))], NOW_MS - 1000);
    const probeFn = vi.fn(async () => ({ rateLimitInfo: fiveHourAllowed({ utilization: 0.99 }) }));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(probeFn).not.toHaveBeenCalled();
    expect(reading.classification).toBe(READING_STATUS.MEASURED);
    expect(reading.utilization).toBe(0.3);
  });

  it("never probes seven_day, even when stale -- the CLI does not reliably emit one on demand (see docs/usage-telemetry.md)", async () => {
    const probeFn = vi.fn(async () => ({ rateLimitInfo: sevenDayAllowed() }));

    const reading = await readWindowUsage({ runsDir, windowKind: "seven_day", now: NOW_MS, probeFn });

    expect(probeFn).not.toHaveBeenCalled();
    expect(reading.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(reading.utilization).toBeNull();
  });

  it("a probe that throws leaves the scan result standing -- fail-safe, never a worse guess", async () => {
    const probeFn = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(reading.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(reading.utilization).toBeNull();
  });

  it("a probe that resolves with nothing usable leaves the scan result standing", async () => {
    const probeFn = vi.fn(async () => null);

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(reading.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(reading.utilization).toBeNull();
  });

  it("a probe result for the wrong rateLimitType is discarded, not accepted as this window's reading", async () => {
    const probeFn = vi.fn(async () => ({ rateLimitInfo: sevenDayAllowed({ status: "rejected" }) }));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(reading.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(reading.utilization).toBeNull();
  });

  it("a probe reading with only a status, no numeric utilization, is estimated -- never measured -- same rule as a scanned reading", async () => {
    const probeFn = vi.fn(async () => ({ rateLimitInfo: fiveHourAllowed({ status: "allowed" }) }));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(reading.classification).toBe(READING_STATUS.ESTIMATED);
    expect(reading.utilization).toBe(0);
  });

  it("a probe reading still honors an elapsed reset window", async () => {
    const probeFn = vi.fn(async () => ({
      rateLimitInfo: fiveHourAllowed({ status: "rejected", resetsAt: PAST_RESETS_AT, utilization: 1 })
    }));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS, probeFn });

    expect(reading.classification).toBe(READING_STATUS.ESTIMATED);
    expect(reading.utilization).toBe(0);
    expect(reading.resetElapsed).toBe(true);
  });

  it("omitting probeFn reproduces the exact pre-T-0438 scan-only behavior (non-regression)", async () => {
    await writeLog(
      "T-0001.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.9 }))],
      NOW_MS - (DEFAULT_MAX_STALENESS_MS.five_hour + 60_000)
    );

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });

    expect(reading.classification).toBe(READING_STATUS.STALE);
    expect(reading.utilization).toBeNull();
  });
});

describe("readUsageTelemetry -- threads the probe only to five_hour", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-freshness-telemetry-"));
  });

  afterEach(async () => {
    await rmTemp(runsDir);
  });

  it("calls probeFn for five_hour only, and the resulting telemetry carries a fresh five_hour reading", async () => {
    const probeFn = vi.fn(async ({ windowKind }) =>
      windowKind === "five_hour" ? { rateLimitInfo: fiveHourAllowed({ status: "allowed_warning", utilization: 0.55 }) } : null
    );

    const telemetry = await readUsageTelemetry({ runsDir, now: NOW_MS, probeFn });

    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(probeFn).toHaveBeenCalledWith({ windowKind: "five_hour", now: NOW_MS });
    expect(telemetry.five_hour.classification).toBe(READING_STATUS.MEASURED);
    expect(telemetry.five_hour.utilization).toBe(0.55);
    expect(telemetry.seven_day.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(telemetry.seven_day.utilization).toBeNull();
  });
});

describe("createAutoLaunchPoller -- decision-time probe wiring, demonstrated end to end (T-0438)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-freshness-poller-"));
  });

  afterEach(async () => {
    await rmTemp(runsDir);
  });

  function makeTask(overrides = {}) {
    return {
      id: "T-0001",
      title: "A card",
      status: "ready",
      priority: "P1",
      phase: "P1",
      agent: "server",
      depends_on: [],
      created: "2026-08-29",
      body: "",
      ...overrides
    };
  }

  function makeLogger() {
    return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  function makeStore(tasks) {
    return {
      list: vi.fn(async () => tasks),
      get: vi.fn(async (id) => tasks.find((t) => t.id === id) ?? null),
      update: vi.fn(async (id, patch) => ({ ...tasks.find((t) => t.id === id), ...patch }))
    };
  }

  function logLines(logger) {
    return logger.log.mock.calls.map((call) => call[0]).join("\n");
  }

  /**
   * Builds a real poller around the real (non-mocked) `readUsageTelemetry` -- the ONLY double here
   * is `usageProbeFn`, standing in for the live `claude` CLI invocation (no persona in this runner
   * -- implementer or reviewer -- holds a grant to invoke `claude` directly; see
   * docs/usage-telemetry.md's "Decision-time probe" section for why that makes an injected probe
   * double the honest, available way to demonstrate the real reader/gate/log pipeline here, the
   * same way every spawn-based CLI runner in this codebase is already tested).
   */
  function makeRealPoller({ usageProbeFn, tasks = [makeTask()], logger = makeLogger(), ...overrides } = {}) {
    const store = makeStore(tasks);
    const orchestrator = { hasActiveRuns: vi.fn(() => false), isRunning: vi.fn(() => false), hub: { broadcast: vi.fn() } };
    const poller = createAutoLaunchPoller({
      store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1_800_000,
      usageMax: 0.8,
      readUsage: vi.fn(async () => ({ utilization: null, status: null, logPath: null, telemetryAbsent: true, reason: "no rate-limit telemetry" })),
      launchFn: vi.fn(async ({ id }) => makeTask({ id })),
      usageProbeFn,
      logger,
      now: () => NOW_MS,
      ...overrides
    });
    return { poller, logger };
  }

  it("with the probe explicitly disabled (usageProbeFn: null), the real reader reproduces the live board's own all-unknown log line", async () => {
    const { poller, logger } = makeRealPoller({ usageProbeFn: null });

    await poller.tick();

    expect(logLines(logger)).toMatch(/usage gate comparison.*five_hour=unknown\(unavailable\)/);
  });

  it("with the probe wired in, the poller's own usage gate comparison log line carries a non-null five_hour utilization", async () => {
    const usageProbeFn = vi.fn(async ({ windowKind }) =>
      windowKind === "five_hour" ? { rateLimitInfo: fiveHourAllowed({ status: "allowed_warning", utilization: 0.37 }) } : null
    );
    const { poller, logger } = makeRealPoller({ usageProbeFn });

    await poller.tick();

    const lines = logLines(logger);
    expect(lines).toMatch(/usage gate comparison/);
    expect(lines).toMatch(/five_hour=ok\(0\.37\)/);
    expect(lines).not.toMatch(/five_hour=unknown/);
    expect(usageProbeFn).toHaveBeenCalledWith({ windowKind: "five_hour", now: NOW_MS });
  });

  it("widens the telemetry read's own bound when a probe is wired in -- a probe needs more than the 8s legacy-scan bound", async () => {
    vi.useFakeTimers();
    try {
      const usageProbeFn = vi.fn(() => new Promise(() => {}));
      const { poller, logger } = makeRealPoller({ usageProbeFn });

      const tickPromise = poller.tick();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(logLines(logger)).not.toMatch(/usage gate comparison|usage comparison unavailable/);

      await vi.advanceTimersByTimeAsync(DEFAULT_PROBE_BOUND_MS);
      await tickPromise;

      expect(logLines(logger)).toMatch(/window-aware usage comparison unavailable/);
    } finally {
      vi.useRealTimers();
    }
  });
});
