import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  utilizationFromRateLimitInfo,
  readNewestRateLimitInfo,
  readUsageSnapshot,
  ALLOWED_UTILIZATION,
  WARNING_UTILIZATION,
  REJECTED_UTILIZATION
} from "../../src/runner/usageWindow.js";

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

/** The exact shape a live `claude` CLI run writes today (captured from a real tasks/.runs log). */
function liveAllowedInfo(overrides = {}) {
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

describe("utilizationFromRateLimitInfo", () => {
  it("returns null for a missing or non-object payload", () => {
    expect(utilizationFromRateLimitInfo(null, { now: NOW_MS })).toBeNull();
    expect(utilizationFromRateLimitInfo(undefined, { now: NOW_MS })).toBeNull();
    expect(utilizationFromRateLimitInfo("allowed", { now: NOW_MS })).toBeNull();
    expect(utilizationFromRateLimitInfo([], { now: NOW_MS })).toBeNull();
  });

  it("returns null for an unrecognized status, so the caller treats usage as undetermined", () => {
    expect(utilizationFromRateLimitInfo({ status: "something_new", resetsAt: FUTURE_RESETS_AT }, { now: NOW_MS })).toBeNull();
    expect(utilizationFromRateLimitInfo({ resetsAt: FUTURE_RESETS_AT }, { now: NOW_MS })).toBeNull();
  });

  it("maps status:allowed to the floor, the shape a healthy live run actually emits", () => {
    expect(utilizationFromRateLimitInfo(liveAllowedInfo(), { now: NOW_MS })).toBe(ALLOWED_UTILIZATION);
  });

  it("does not read the healthy-event overage fields as a refusal", () => {
    // overageStatus:"rejected" + overageDisabledReason:"out_of_credits" ride along on healthy
    // events -- the same false-positive that disabled escalation board-wide on T-0233.
    const info = liveAllowedInfo({ overageStatus: "rejected", overageDisabledReason: "out_of_credits" });
    expect(utilizationFromRateLimitInfo(info, { now: NOW_MS })).toBe(ALLOWED_UTILIZATION);
  });

  it("maps status:allowed_warning to a near-cap utilization", () => {
    const info = liveAllowedInfo({ status: "allowed_warning" });
    expect(utilizationFromRateLimitInfo(info, { now: NOW_MS })).toBe(WARNING_UTILIZATION);
    expect(WARNING_UTILIZATION).toBeGreaterThan(0.8);
  });

  it("maps status:rejected to a saturated utilization", () => {
    const info = liveAllowedInfo({ status: "rejected" });
    expect(utilizationFromRateLimitInfo(info, { now: NOW_MS })).toBe(REJECTED_UTILIZATION);
    expect(REJECTED_UTILIZATION).toBe(1);
  });

  it("prefers an explicit numeric utilization field over the status proxy when one is present", () => {
    const info = liveAllowedInfo({ status: "allowed", utilization: 0.93 });
    expect(utilizationFromRateLimitInfo(info, { now: NOW_MS })).toBe(0.93);
  });

  it("ignores a numeric utilization that is out of the 0..1 range and falls back to the status", () => {
    expect(utilizationFromRateLimitInfo(liveAllowedInfo({ utilization: 42 }), { now: NOW_MS })).toBe(ALLOWED_UTILIZATION);
    expect(utilizationFromRateLimitInfo(liveAllowedInfo({ utilization: -1 }), { now: NOW_MS })).toBe(ALLOWED_UTILIZATION);
    expect(utilizationFromRateLimitInfo(liveAllowedInfo({ utilization: "0.5" }), { now: NOW_MS })).toBe(ALLOWED_UTILIZATION);
  });

  it("treats an elapsed window as a fresh one, even for a rejected event", () => {
    const info = liveAllowedInfo({ status: "rejected", resetsAt: PAST_RESETS_AT, utilization: 1 });
    expect(utilizationFromRateLimitInfo(info, { now: NOW_MS })).toBe(ALLOWED_UTILIZATION);
  });

  it("treats the exact boundary (now === resetsAt) as an elapsed window", () => {
    const info = liveAllowedInfo({ status: "rejected", resetsAt: Math.floor(NOW_MS / 1000) });
    expect(utilizationFromRateLimitInfo(info, { now: NOW_MS })).toBe(ALLOWED_UTILIZATION);
  });
});

describe("readNewestRateLimitInfo / readUsageSnapshot", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-window-"));
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

  it("returns null when the runs directory does not exist yet", async () => {
    const result = await readNewestRateLimitInfo({ runsDir: path.join(runsDir, "nope") });
    expect(result).toBeNull();
  });

  it("returns null when no run log contains rate-limit telemetry", async () => {
    await writeLog("T-0001-a.jsonl", [{ type: "assistant", message: { content: [{ text: "hi" }] } }]);
    expect(await readNewestRateLimitInfo({ runsDir })).toBeNull();
  });

  it("skips a zero-byte run log without erroring", async () => {
    await fs.writeFile(path.join(runsDir, "T-0002-empty.jsonl"), "", "utf8");
    await writeLog("T-0001-a.jsonl", [rateLimitEvent(liveAllowedInfo())], NOW_MS - 60_000);
    const result = await readNewestRateLimitInfo({ runsDir });
    expect(result.info.status).toBe("allowed");
  });

  it("ignores unparseable lines rather than throwing", async () => {
    const filePath = path.join(runsDir, "T-0001-a.jsonl");
    await fs.writeFile(filePath, `{not json\n${JSON.stringify(rateLimitEvent(liveAllowedInfo()))}\n`, "utf8");
    const result = await readNewestRateLimitInfo({ runsDir });
    expect(result.info.status).toBe("allowed");
  });

  it("takes the LAST rate-limit event in a log, not the first", async () => {
    await writeLog("T-0001-a.jsonl", [
      rateLimitEvent(liveAllowedInfo({ status: "allowed" })),
      { type: "assistant", message: { content: [{ text: "working" }] } },
      rateLimitEvent(liveAllowedInfo({ status: "rejected" }))
    ]);
    const result = await readNewestRateLimitInfo({ runsDir });
    expect(result.info.status).toBe("rejected");
  });

  it("prefers the newest log by mtime over an older one", async () => {
    await writeLog("T-0001-old.jsonl", [rateLimitEvent(liveAllowedInfo({ status: "rejected" }))], NOW_MS - 3_600_000);
    await writeLog("T-0002-new.jsonl", [rateLimitEvent(liveAllowedInfo({ status: "allowed" }))], NOW_MS - 1_000);
    const result = await readNewestRateLimitInfo({ runsDir });
    expect(result.info.status).toBe("allowed");
    expect(result.logPath).toContain("T-0002-new.jsonl");
  });

  it("falls through to an older log when the newest one has no telemetry", async () => {
    await writeLog("T-0001-old.jsonl", [rateLimitEvent(liveAllowedInfo({ status: "rejected" }))], NOW_MS - 3_600_000);
    await writeLog("T-0002-new.jsonl", [{ type: "assistant", message: { content: [{ text: "no telemetry" }] } }], NOW_MS - 1_000);
    const result = await readNewestRateLimitInfo({ runsDir });
    expect(result.info.status).toBe("rejected");
  });

  it("ignores non-.jsonl files such as the runstate sidecars", async () => {
    await fs.writeFile(path.join(runsDir, "T-0001.runstate.json"), JSON.stringify({ pid: 1 }), "utf8");
    expect(await readNewestRateLimitInfo({ runsDir })).toBeNull();
  });

  it("finds telemetry in the tail of a log far larger than the tail window", async () => {
    const filler = { type: "assistant", message: { content: [{ text: "x".repeat(2000) }] } };
    const events = [];
    for (let i = 0; i < 200; i += 1) events.push(filler);
    events.push(rateLimitEvent(liveAllowedInfo({ status: "allowed_warning" })));
    await writeLog("T-0001-big.jsonl", events);
    const result = await readNewestRateLimitInfo({ runsDir, tailBytes: 8 * 1024 });
    expect(result.info.status).toBe("allowed_warning");
  });

  it("readUsageSnapshot reports a null utilization plus a reason when nothing is readable", async () => {
    const snapshot = await readUsageSnapshot({ runsDir, now: NOW_MS });
    expect(snapshot.utilization).toBeNull();
    expect(snapshot.reason).toMatch(/no rate-limit telemetry/i);
  });

  it("readUsageSnapshot reports the utilization and status of the newest telemetry", async () => {
    await writeLog("T-0001-a.jsonl", [rateLimitEvent(liveAllowedInfo({ status: "allowed_warning" }))]);
    const snapshot = await readUsageSnapshot({ runsDir, now: NOW_MS });
    expect(snapshot.utilization).toBe(WARNING_UTILIZATION);
    expect(snapshot.status).toBe("allowed_warning");
    expect(snapshot.logPath).toContain("T-0001-a.jsonl");
  });

  it("readUsageSnapshot reports a null utilization when the newest telemetry has an unknown status", async () => {
    await writeLog("T-0001-a.jsonl", [rateLimitEvent({ status: "brand_new_status", resetsAt: FUTURE_RESETS_AT })]);
    const snapshot = await readUsageSnapshot({ runsDir, now: NOW_MS });
    expect(snapshot.utilization).toBeNull();
    expect(snapshot.reason).toMatch(/brand_new_status/);
  });

  it("readUsageSnapshot never throws on an unreadable runs directory -- it reports undetermined", async () => {
    const snapshot = await readUsageSnapshot({
      runsDir,
      now: NOW_MS,
      readdirFn: async () => {
        throw new Error("EIO");
      }
    });
    expect(snapshot.utilization).toBeNull();
    expect(snapshot.reason).toMatch(/EIO/);
  });
});

describe("telemetry EARLY in a large log -- the 2026-09-04 poller stall", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-early-"));
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

  const filler = () => ({ type: "assistant", message: { content: [{ text: "x".repeat(2000) }] } });

  /** A real run's shape: rate_limit_event near the START, then megabytes of turns after it. */
  async function logWithEarlyTelemetry(name, { status = "allowed", trailingEvents = 200, mtimeMs } = {}) {
    const events = [rateLimitEvent(liveAllowedInfo({ status }))];
    for (let i = 0; i < trailingEvents; i += 1) events.push(filler());
    return writeLog(name, events, mtimeMs);
  }

  it("finds telemetry emitted BEFORE the tail window -- the exact stall on the live board", async () => {
    // Observed 2026-09-04: T-0295's log was 4,726,017 bytes with its last rate_limit_event at
    // byte 4,376,864 -- 87,009 bytes before the 256 KB tail window. All five scanned logs missed
    // the same way, so the poller reported "no rate-limit telemetry found" and skipped at gate 2
    // (usage, ahead of the idle gate) every 30 minutes while ready cards sat idle.
    await logWithEarlyTelemetry("T-0001-big.jsonl", { status: "allowed_warning" });

    const result = await readNewestRateLimitInfo({ runsDir, tailBytes: 8 * 1024 });

    expect(result, "telemetry before the tail window was not found").not.toBeNull();
    expect(result.info.status).toBe("allowed_warning");
  });

  it("still prefers the NEWEST event when the tail does contain one", async () => {
    // head-fallback must not override a fresher reading that the cheap tail read already found
    const events = [rateLimitEvent(liveAllowedInfo({ status: "allowed" }))];
    for (let i = 0; i < 200; i += 1) events.push(filler());
    events.push(rateLimitEvent(liveAllowedInfo({ status: "rejected" })));
    await writeLog("T-0001-both.jsonl", events);

    const result = await readNewestRateLimitInfo({ runsDir, tailBytes: 8 * 1024 });

    expect(result.info.status).toBe("rejected");
  });

  it("a zero-byte log does not consume a scan slot", async () => {
    // T-0299 died on spawn and left a 0-byte log. It burned one of only five slots with a
    // guaranteed miss, pushing a log that DID have telemetry out of range.
    await fs.writeFile(path.join(runsDir, "T-0099-dead.jsonl"), "", "utf8");
    for (let i = 0; i < 4; i += 1) {
      await writeLog(`T-010${i}-noise.jsonl`, [filler()], NOW_MS - (i + 1) * 1000);
    }
    await logWithEarlyTelemetry("T-0200-has-telemetry.jsonl", {
      status: "allowed_warning",
      mtimeMs: NOW_MS - 10_000
    });

    const result = await readNewestRateLimitInfo({ runsDir, tailBytes: 8 * 1024, maxLogsScanned: 5 });

    expect(result, "the empty log consumed a scan slot").not.toBeNull();
    expect(result.info.status).toBe("allowed_warning");
  });

  it("scans more than five logs before giving up", async () => {
    for (let i = 0; i < 8; i += 1) {
      await writeLog(`T-030${i}-noise.jsonl`, [filler()], NOW_MS - (i + 1) * 1000);
    }
    await logWithEarlyTelemetry("T-0400-old.jsonl", { mtimeMs: NOW_MS - 100_000 });

    const result = await readNewestRateLimitInfo({ runsDir, tailBytes: 8 * 1024 });

    expect(result).not.toBeNull();
    expect(result.info.status).toBe("allowed");
  });

  it("does not read whole multi-megabyte logs -- both reads stay bounded", async () => {
    // The tail cap exists because a live log reaches tens of MB and the poller re-reads every
    // tick. The head fallback must be bounded the same way, not a full-file parse.
    const reads = [];
    const openFn = async (filePath, flags) => {
      const handle = await fs.open(filePath, flags);
      return {
        stat: () => handle.stat(),
        read: (buf, off, len, pos) => {
          reads.push(len);
          return handle.read(buf, off, len, pos);
        },
        close: () => handle.close()
      };
    };
    await logWithEarlyTelemetry("T-0500-big.jsonl", { trailingEvents: 400 });

    await readNewestRateLimitInfo({ runsDir, tailBytes: 8 * 1024, openFn });

    expect(reads.length).toBeGreaterThan(0);
    for (const len of reads) expect(len).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("genuinely-absent telemetry is distinguished from unreadable telemetry", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-absent-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  it("flags telemetryAbsent when no log carries any rate-limit event", async () => {
    await fs.writeFile(
      path.join(runsDir, "T-0001-a.jsonl"),
      JSON.stringify({ type: "assistant", message: { content: [{ text: "hi" }] } }) + "\n",
      "utf8"
    );

    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.utilization).toBeNull();
    expect(snap.telemetryAbsent).toBe(true);
  });

  it("flags telemetryAbsent on a brand-new board with no runs directory at all", async () => {
    const snap = await readUsageSnapshot({ runsDir: path.join(runsDir, "nope"), now: NOW_MS });

    expect(snap.utilization).toBeNull();
    expect(snap.telemetryAbsent).toBe(true);
  });

  it("does NOT flag telemetryAbsent when telemetry exists but its status is unrecognized", async () => {
    // Bad data, not absent data -- a misread signal must still fail closed.
    await fs.writeFile(
      path.join(runsDir, "T-0001-a.jsonl"),
      JSON.stringify(rateLimitEvent(liveAllowedInfo({ status: "who-knows" }))) + "\n",
      "utf8"
    );

    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.utilization).toBeNull();
    expect(snap.telemetryAbsent).toBe(false);
  });

  it("does NOT flag telemetryAbsent when the runs directory is unreadable", async () => {
    const snap = await readUsageSnapshot({
      runsDir,
      now: NOW_MS,
      readdirFn: async () => {
        throw new Error("EIO: disk on fire");
      }
    });

    expect(snap.utilization).toBeNull();
    expect(snap.telemetryAbsent).toBe(false);
    expect(snap.reason).toMatch(/unreadable/);
  });

  it("telemetryAbsent is false on a healthy reading", async () => {
    await fs.writeFile(
      path.join(runsDir, "T-0001-a.jsonl"),
      JSON.stringify(rateLimitEvent(liveAllowedInfo())) + "\n",
      "utf8"
    );

    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.utilization).toBe(ALLOWED_UTILIZATION);
    expect(snap.telemetryAbsent).toBe(false);
  });
});

describe("reset-awareness: the poller must know WHEN the limit frees up", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-reset-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  async function writeOne(info) {
    await fs.writeFile(
      path.join(runsDir, "T-0001-a.jsonl"),
      JSON.stringify(rateLimitEvent(info)) + "\n",
      "utf8"
    );
  }

  it("surfaces resetsAt as epoch ms, an ISO string, and the window type", async () => {
    // The CLI has no `usage`/`limits`/`status` subcommand (verified on 2.1.241) -- but the
    // rate_limit_event it already writes carries the reset instant. This is the authoritative
    // reset signal that IS available.
    await writeOne(liveAllowedInfo({ status: "rejected", rateLimitType: "five_hour" }));

    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.resetsAtMs).toBe(FUTURE_RESETS_AT * 1000);
    expect(snap.resetsAtIso).toBe(new Date(FUTURE_RESETS_AT * 1000).toISOString());
    expect(snap.rateLimitType).toBe("five_hour");
    expect(snap.msUntilReset).toBe(FUTURE_RESETS_AT * 1000 - NOW_MS);
  });

  it("reports the window as already elapsed rather than a negative wait", async () => {
    await writeOne(liveAllowedInfo({ status: "rejected", resetsAt: PAST_RESETS_AT }));

    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.resetElapsed).toBe(true);
    expect(snap.msUntilReset).toBe(0);
    // an elapsed window is a fresh one -- utilization must not still read as saturated
    expect(snap.utilization).toBe(ALLOWED_UTILIZATION);
  });

  it("carries the overage window's reset too, when the payload has one", async () => {
    await writeOne(
      liveAllowedInfo({ status: "rejected", overageResetsAt: FUTURE_RESETS_AT + 600 })
    );

    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.overageResetsAtMs).toBe((FUTURE_RESETS_AT + 600) * 1000);
  });

  it("leaves the reset fields null when the payload has no resetsAt", async () => {
    await writeOne({ status: "allowed_warning", rateLimitType: "five_hour" });

    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.resetsAtMs).toBeNull();
    expect(snap.msUntilReset).toBeNull();
    expect(snap.resetsAtIso).toBeNull();
  });

  it("reset fields are null (not undefined) when telemetry is absent entirely", async () => {
    const snap = await readUsageSnapshot({ runsDir, now: NOW_MS });

    expect(snap.telemetryAbsent).toBe(true);
    expect(snap.resetsAtMs).toBeNull();
    expect(snap.msUntilReset).toBeNull();
  });
});
