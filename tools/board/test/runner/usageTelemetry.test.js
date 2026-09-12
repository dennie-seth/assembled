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

  /**
   * Stamps a `rate_limit_event` lacking its own `receivedAtMs` with `mtimeMs` before writing --
   * every existing test in this file writes a log once, at one coherent instant, so treating that
   * instant as this event's trusted receive timestamp preserves exactly the same behavior these
   * tests already pinned before the receive-timestamp fix (Codex review 2026-09-12, P1). Tests
   * exercising the NEW "no trustworthy timing" fallback bypass this helper and write raw JSON
   * lines directly, the same way Codex's own reproduction probe does.
   */
  async function writeLog(name, events, mtimeMs) {
    const filePath = path.join(runsDir, name);
    const stamped = events.map((e) =>
      e && e.type === "rate_limit_event" && typeof e.receivedAtMs !== "number" && mtimeMs !== undefined
        ? { ...e, receivedAtMs: mtimeMs }
        : e
    );
    await fs.writeFile(filePath, stamped.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
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
    const stamped = events.map((e) =>
      e && e.type === "rate_limit_event" && typeof e.receivedAtMs !== "number" && mtimeMs !== undefined
        ? { ...e, receivedAtMs: mtimeMs }
        : e
    );
    await fs.writeFile(filePath, stamped.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
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

describe("receive-timestamp freshness, not log-file mtime (Codex review 2026-09-12, P1)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-telemetry-receive-ts-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  /** Writes raw JSON lines with no auto-stamping -- full control, matching Codex's own probe. */
  async function writeRaw(name, lines) {
    const filePath = path.join(runsDir, name);
    await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return filePath;
  }

  it("Codex's exact reproduction: a weekly reading in a log last modified 3 hours ago stays stale after an unrelated event is appended", async () => {
    const logPath = await writeRaw("old-event.jsonl", [rateLimitEvent(sevenDayAllowed({ status: "allowed_warning", utilization: 0.75 }))]);
    const threeHoursAgo = NOW_MS - 3 * 3600 * 1000;
    await fs.utimes(logPath, new Date(threeHoursAgo), new Date(threeHoursAgo));

    const before = await readWindowUsage({ runsDir, windowKind: "seven_day", now: NOW_MS });
    expect(before.classification).toBe(READING_STATUS.STALE);

    await fs.appendFile(logPath, JSON.stringify({ type: "assistant", timestamp: new Date(NOW_MS).toISOString(), message: { content: [] } }) + "\n");

    const after = await readWindowUsage({ runsDir, windowKind: "seven_day", now: NOW_MS });
    expect(after.classification).toBe(READING_STATUS.STALE);
    expect(after.utilization).toBeNull();
  });

  it("an actively-growing log does not make an old receive-stamped reading look fresh", async () => {
    const logPath = await writeRaw("active.jsonl", [
      rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.6 }), {
        receivedAtMs: NOW_MS - (DEFAULT_MAX_STALENESS_MS.five_hour + 60_000)
      })
    ]);
    // Many later, unrelated writes keep bumping the file's mtime close to "now".
    for (let i = 0; i < 5; i += 1) {
      await fs.appendFile(logPath, JSON.stringify({ type: "assistant", timestamp: new Date(NOW_MS).toISOString(), message: { content: [] } }) + "\n");
    }
    await fs.utimes(logPath, new Date(NOW_MS), new Date(NOW_MS));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.STALE);
    expect(reading.utilization).toBeNull();
  });

  it("sparse weekly events are aged from their own receive timestamp, not the file's mtime", async () => {
    const logPath = await writeRaw("sparse-weekly.jsonl", [
      rateLimitEvent(sevenDayAllowed({ status: "allowed_warning", utilization: 0.4 }), { receivedAtMs: NOW_MS - 1000 })
    ]);
    for (let i = 0; i < 20; i += 1) {
      await fs.appendFile(logPath, JSON.stringify({ type: "assistant", timestamp: new Date(NOW_MS).toISOString(), message: { content: [] } }) + "\n");
    }
    await fs.utimes(logPath, new Date(NOW_MS), new Date(NOW_MS));

    const reading = await readWindowUsage({ runsDir, windowKind: "seven_day", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.MEASURED);
    expect(reading.utilization).toBe(0.4);
  });

  it("conflicting observations across files: the newer receive-stamped event wins, even from a log with an older mtime", async () => {
    await writeRaw("file-a.jsonl", [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.2 }), { receivedAtMs: NOW_MS - 5000 })]);
    await fs.utimes(path.join(runsDir, "file-a.jsonl"), new Date(NOW_MS), new Date(NOW_MS));

    await writeRaw("file-b.jsonl", [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.8 }), { receivedAtMs: NOW_MS - 500 })]);
    await fs.utimes(path.join(runsDir, "file-b.jsonl"), new Date(NOW_MS - 100_000), new Date(NOW_MS - 100_000));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    // file-b's event is the NEWER observation (receivedAtMs closer to now) even though file-a
    // has the newer mtime -- the old mtime-sorted reader would have picked file-a's 0.2 instead.
    expect(reading.utilization).toBe(0.8);
    expect(reading.logPath).toContain("file-b.jsonl");
  });

  it("a historical record with no trustworthy timing is classified conservatively as stale, never measured/estimated", async () => {
    const logPath = await writeRaw("no-receipt.jsonl", [rateLimitEvent(fiveHourAllowed({ status: "allowed_warning", utilization: 0.3 }))]);
    await fs.utimes(logPath, new Date(NOW_MS), new Date(NOW_MS));

    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.STALE);
    expect(reading.utilization).toBeNull();
  });

  it("an elapsed reset invalidates the old window's observation rather than reporting verified empty capacity", async () => {
    await writeRaw("elapsed.jsonl", [
      rateLimitEvent(fiveHourAllowed({ status: "rejected", resetsAt: PAST_RESETS_AT, utilization: 1 }), { receivedAtMs: NOW_MS - 1000 })
    ]);
    const reading = await readWindowUsage({ runsDir, windowKind: "five_hour", now: NOW_MS });
    expect(reading.classification).toBe(READING_STATUS.ESTIMATED);
    expect(reading.utilization).toBe(0);
    expect(reading.resetElapsed).toBe(true);
  });
});
