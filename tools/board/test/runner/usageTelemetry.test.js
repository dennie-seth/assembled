import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WINDOW_KINDS,
  READING_STATUS,
  DEFAULT_MAX_STALENESS_MS,
  readWindowUsage,
  readUsageTelemetry
} from "../../src/runner/usageTelemetry.js";

/** Far enough in the future that a `resetsAt` built from it never reads as an elapsed window. */
const NOW_MS = 1_788_000_000_000;
const FUTURE_RESETS_AT = Math.floor(NOW_MS / 1000) + 3600;
const PAST_RESETS_AT = Math.floor(NOW_MS / 1000) - 3600;

function rateLimitEvent(info) {
  return {
    type: "rate_limit_event",
    rate_limit_info: info,
    uuid: "54d022f9-8efd-43e7-a49f-67cac9a3e682",
    session_id: "18d5c168-5e17-4062-8f5a-4d502597766f"
  };
}

/** The exact shape a live `claude` CLI run writes for a healthy 5-hour reading. */
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

describe("WINDOW_KINDS / READING_STATUS", () => {
  it("names exactly the two verified window kinds", () => {
    expect(WINDOW_KINDS).toEqual(["five_hour", "seven_day"]);
  });

  it("names exactly the four classification buckets", () => {
    expect(Object.values(READING_STATUS).sort()).toEqual(
      ["estimated", "measured", "stale", "unavailable"].sort()
    );
  });
});

describe("readWindowUsage", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-telemetry-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  async function writeLog(name, events, mtimeMs) {
    const filePath = path.join(runsDir, name);
    await fs.writeFile(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    if (mtimeMs !== undefined) {
      await fs.utimes(filePath, new Date(mtimeMs), new Date(mtimeMs));
    }
    return filePath;
  }

  it("rejects an unrecognized window kind", async () => {
    await expect(readWindowUsage({ runsDir, windowKind: "monthly", now: NOW_MS })).rejects.toThrow(
      /unknown usage window kind/
    );
  });

  it("is unavailable when the runs directory does not exist", async () => {
    const reading = await readWindowUsage({
      runsDir: path.join(runsDir, "nope"),
      windowKind: "five_hour",
      now: NOW_MS
    });
    expect(reading.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(reading.utilization).toBeNull();
    expect(reading.logPath).toBeNull();
    expect(reading.observedAtMs).toBeNull();
  });

  it("is unavailable when no log carries this window's rate limit type", async () => {
    await writeLog("T-0001-a.jsonl", [rateLimitEvent(sevenDayAllowed())], NOW_MS - 1000);
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(reading.utilization).toBeNull();
  });

  it("a status-only allowed event is never reported as measured -- it is estimated", async () => {
    await writeLog("T-0001-a.jsonl", [rateLimitEvent(fiveHourAllowed())], NOW_MS - 1000);
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.ESTIMATED);
    expect(reading.utilization).toBe(0);
  });

  it("an explicit numeric utilization is measured, not estimated", async () => {
    await writeLog(
      "T-0001-a.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.57, surpassedThreshold: 0.5 }))],
      NOW_MS - 1000
    );
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.MEASURED);
    expect(reading.utilization).toBe(0.57);
    expect(reading.surpassedThreshold).toBe(0.5);
  });

  it("does not read healthy-event overage fields as a refusal", async () => {
    // regression guard duplicated from usageLimitDetector/usageWindow: overageStatus:"rejected" +
    // overageDisabledReason:"out_of_credits" ride along on healthy events (T-0233).
    await writeLog(
      "T-0001-a.jsonl",
      [rateLimitEvent(fiveHourAllowed({ overageStatus: "rejected", overageDisabledReason: "out_of_credits" }))],
      NOW_MS - 1000
    );
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.ESTIMATED);
    expect(reading.utilization).toBe(0);
  });

  it("a reading older than the max staleness is stale, with utilization withheld", async () => {
    await writeLog(
      "T-0001-a.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.9 }))],
      NOW_MS - (DEFAULT_MAX_STALENESS_MS.five_hour + 60_000)
    );
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.STALE);
    expect(reading.utilization).toBeNull();
  });

  it("stale and unavailable are distinguishable", async () => {
    await writeLog(
      "T-0001-a.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "rejected" }))],
      NOW_MS - (DEFAULT_MAX_STALENESS_MS.five_hour + 60_000)
    );
    const stale = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    const unavailable = await readWindowUsage({ runsDir, windowKind: "seven_day", now: NOW_MS });

    expect(stale.classification).toBe(READING_STATUS.STALE);
    expect(unavailable.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(stale.classification).not.toBe(unavailable.classification);
    expect(stale.logPath).not.toBeNull();
    expect(unavailable.logPath).toBeNull();
  });

  it("an unrecognized status is unavailable, not a guess", async () => {
    await writeLog(
      "T-0001-a.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "brand_new_status" }))],
      NOW_MS - 1000
    );
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(reading.utilization).toBeNull();
  });

  it("treats an elapsed reset window as fresh and estimated at zero", async () => {
    await writeLog(
      "T-0001-a.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "rejected", resetsAt: PAST_RESETS_AT, utilization: 1 }))],
      NOW_MS - 1000
    );
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.ESTIMATED);
    expect(reading.utilization).toBe(0);
    expect(reading.resetElapsed).toBe(true);
  });

  it("carries the reset window fields for a measured/estimated reading", async () => {
    await writeLog(
      "T-0001-a.jsonl",
      [rateLimitEvent(fiveHourAllowed({ status: "rejected" }))],
      NOW_MS - 1000
    );
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.resetsAtMs).toBe(FUTURE_RESETS_AT * 1000);
    expect(reading.resetsAtIso).toBe(new Date(FUTURE_RESETS_AT * 1000).toISOString());
  });
});

describe("independent windows -- the bug this card fixes", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-telemetry-independent-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  async function writeLog(name, events, mtimeMs) {
    const filePath = path.join(runsDir, name);
    await fs.writeFile(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    if (mtimeMs !== undefined) await fs.utimes(filePath, new Date(mtimeMs), new Date(mtimeMs));
    return filePath;
  }

  it("a healthy five_hour reading cannot mask an exhausted seven_day one", async () => {
    // The newest event in the newest log is five_hour:allowed. An older event in the same log
    // is seven_day:rejected. A newest-event-wins reader (the old readNewestRateLimitInfo
    // behavior) would report only the healthy five_hour reading and never surface the
    // exhausted weekly window at all.
    await writeLog(
      "T-0001-a.jsonl",
      [
        rateLimitEvent(sevenDayAllowed({ status: "rejected" })),
        { type: "assistant", message: { content: [{ text: "working" }] } },
        rateLimitEvent(fiveHourAllowed({ status: "allowed" }))
      ],
      NOW_MS - 1000
    );

    const telemetry = await readUsageTelemetry({ runsDir, now: NOW_MS });

    expect(telemetry.five_hour.classification).toBe(READING_STATUS.ESTIMATED);
    expect(telemetry.five_hour.utilization).toBe(0);
    expect(telemetry.seven_day.classification).toBe(READING_STATUS.ESTIMATED);
    expect(telemetry.seven_day.utilization).toBe(1);
  });

  it("one window resetting does not reset the other", async () => {
    await writeLog(
      "T-0001-a.jsonl",
      [
        // five_hour's window has already elapsed -- reads fresh/zero.
        rateLimitEvent(fiveHourAllowed({ status: "rejected", resetsAt: PAST_RESETS_AT, utilization: 1 })),
        // seven_day's window has NOT elapsed and is still saturated.
        rateLimitEvent(sevenDayAllowed({ status: "rejected", resetsAt: FUTURE_RESETS_AT, utilization: 1 }))
      ],
      NOW_MS - 1000
    );

    const telemetry = await readUsageTelemetry({ runsDir, now: NOW_MS });

    expect(telemetry.five_hour.resetElapsed).toBe(true);
    expect(telemetry.five_hour.utilization).toBe(0);
    expect(telemetry.seven_day.resetElapsed).toBe(false);
    expect(telemetry.seven_day.classification).toBe(READING_STATUS.MEASURED);
    expect(telemetry.seven_day.utilization).toBe(1);
  });

  it("reads each window from whichever log actually carries it, across separate log files", async () => {
    await writeLog("T-0001-old.jsonl", [rateLimitEvent(sevenDayAllowed({ status: "rejected" }))], NOW_MS - 5000);
    await writeLog("T-0002-new.jsonl", [rateLimitEvent(fiveHourAllowed({ status: "allowed" }))], NOW_MS - 1000);

    const telemetry = await readUsageTelemetry({ runsDir, now: NOW_MS });

    expect(telemetry.five_hour.logPath).toContain("T-0002-new.jsonl");
    expect(telemetry.seven_day.logPath).toContain("T-0001-old.jsonl");
  });
});
