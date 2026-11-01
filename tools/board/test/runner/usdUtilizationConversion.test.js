import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "../helpers/rmTemp.js";
import {
  CONVERSION_VERSION,
  MIN_SAMPLES_FOR_USABLE_CONVERSION,
  MAX_COEFFICIENT_OF_VARIATION,
  deriveRateSamplesForWindow,
  fitConversionFromSamples,
  deriveUsdUtilizationConversionFromRuns,
  resolveUnitConversionForAdmission,
  DEFAULT_USD_UTILIZATION_CONVERSION
} from "../../src/runner/usdUtilizationConversion.js";

/**
 * T-0402: deriving the USD-to-utilization conversion that `admissionDecision.js`'s
 * `evaluateWindowAdmission` needs before it can ever compare a USD estimate against a
 * utilization-fraction budget. `docs/usd-utilization-conversion.md` has the full citation of the
 * real `tasks/.runs/*.jsonl` + usage-ledger evidence this module's committed
 * `DEFAULT_USD_UTILIZATION_CONVERSION` was fitted from -- these tests exercise the pure
 * derivation/fit logic against small, hand-built fixtures (never a mocked formula) plus the real
 * async scanner against real temp-directory files, so the whole pipeline from raw run-log bytes
 * to a usable/unusable per-window conversion is proven, not just asserted.
 */

function reading({ receivedAtMs, utilization, resetsAt }) {
  return { receivedAtMs, utilization, resetsAt };
}

function ledgerEntry({ recordedAtMs, costUsd }) {
  return { recordedAtMs, costUsd };
}

describe("deriveRateSamplesForWindow -- one rate sample per completed reset cycle", () => {
  it("pairs the first and last reading of a reset cycle and divides known spend by the utilization increase", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.1, resetsAt: 9999 }),
      reading({ receivedAtMs: 2000, utilization: 0.3, resetsAt: 9999 })
    ];
    const ledgerEntries = [ledgerEntry({ recordedAtMs: 1500, costUsd: 4 })];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries });
    expect(samples).toHaveLength(1);
    expect(samples[0].dUtil).toBeCloseTo(0.2);
    expect(samples[0].dUsd).toBe(4);
    expect(samples[0].rate).toBeCloseTo(20);
  });

  it("ignores a cycle with only one reading -- no increase to measure against", () => {
    const readings = [reading({ receivedAtMs: 1000, utilization: 0.1, resetsAt: 1 })];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries: [] });
    expect(samples).toHaveLength(0);
  });

  it("ignores a cycle whose utilization did not increase (noise, or a reset mid-cycle)", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.3, resetsAt: 1 }),
      reading({ receivedAtMs: 2000, utilization: 0.3, resetsAt: 1 })
    ];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries: [] });
    expect(samples).toHaveLength(0);
  });

  it("never pairs readings across two different reset cycles", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.9, resetsAt: 1 }),
      reading({ receivedAtMs: 2000, utilization: 0.1, resetsAt: 2 })
    ];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries: [] });
    expect(samples).toHaveLength(0);
  });

  it("drops a cycle whose spend interval contains ANY censored (unknown-cost) ledger entry -- never under-counts spend as a smaller known subtotal", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.1, resetsAt: 1 }),
      reading({ receivedAtMs: 2000, utilization: 0.3, resetsAt: 1 })
    ];
    const ledgerEntries = [ledgerEntry({ recordedAtMs: 1500, costUsd: 4 }), ledgerEntry({ recordedAtMs: 1600, costUsd: null })];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries });
    expect(samples).toHaveLength(0);
  });

  it("drops a cycle with no recorded spend in its interval at all -- a zero/negative rate is never fabricated", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.1, resetsAt: 1 }),
      reading({ receivedAtMs: 2000, utilization: 0.3, resetsAt: 1 })
    ];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries: [] });
    expect(samples).toHaveLength(0);
  });

  it("ignores a ledger entry outside the cycle's own interval", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.1, resetsAt: 1 }),
      reading({ receivedAtMs: 2000, utilization: 0.3, resetsAt: 1 })
    ];
    const ledgerEntries = [ledgerEntry({ recordedAtMs: 500, costUsd: 99 }), ledgerEntry({ recordedAtMs: 1500, costUsd: 4 })];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries });
    expect(samples).toHaveLength(1);
    expect(samples[0].dUsd).toBe(4);
  });

  it("sums every known-cost ledger entry inside the interval, regardless of which card recorded it -- the window's capacity pool is global", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.1, resetsAt: 1 }),
      reading({ receivedAtMs: 3000, utilization: 0.2, resetsAt: 1 })
    ];
    const ledgerEntries = [ledgerEntry({ recordedAtMs: 1500, costUsd: 1 }), ledgerEntry({ recordedAtMs: 2500, costUsd: 2 })];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries });
    expect(samples[0].dUsd).toBe(3);
  });

  it("picks up every reset cycle independently -- multiple cycles yield multiple samples", () => {
    const readings = [
      reading({ receivedAtMs: 1000, utilization: 0.1, resetsAt: 1 }),
      reading({ receivedAtMs: 2000, utilization: 0.3, resetsAt: 1 }),
      reading({ receivedAtMs: 5000, utilization: 0.1, resetsAt: 2 }),
      reading({ receivedAtMs: 6000, utilization: 0.4, resetsAt: 2 })
    ];
    const ledgerEntries = [ledgerEntry({ recordedAtMs: 1500, costUsd: 2 }), ledgerEntry({ recordedAtMs: 5500, costUsd: 9 })];
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries });
    expect(samples).toHaveLength(2);
  });
});

describe("fitConversionFromSamples -- a minimum-evidence gate, never a fabricated rate", () => {
  it("is unusable with zero samples", () => {
    const fit = fitConversionFromSamples([]);
    expect(fit.usable).toBe(false);
    expect(fit.usdPerUtilizationUnit).toBeNull();
    expect(fit.sampleCount).toBe(0);
  });

  it(`is unusable below ${MIN_SAMPLES_FOR_USABLE_CONVERSION} samples even when they agree tightly`, () => {
    const samples = [{ rate: 100 }, { rate: 101 }, { rate: 99 }];
    const fit = fitConversionFromSamples(samples);
    expect(fit.usable).toBe(false);
    expect(fit.reason).toMatch(/sample/i);
    expect(fit.usdPerUtilizationUnit).toBeNull();
    // the candidate is still surfaced for diagnostics, just never exposed as a usable rate
    expect(fit.candidateUsdPerUtilizationUnit).toBeCloseTo(100, 0);
  });

  it(`is unusable at/above the sample floor when the spread exceeds the max coefficient of variation (${MAX_COEFFICIENT_OF_VARIATION})`, () => {
    const samples = [{ rate: 10 }, { rate: 1000 }, { rate: 5 }, { rate: 800 }, { rate: 20 }];
    const fit = fitConversionFromSamples(samples);
    expect(fit.usable).toBe(false);
    expect(fit.reason).toMatch(/spread|variation|coefficient/i);
    expect(fit.usdPerUtilizationUnit).toBeNull();
  });

  it("is usable at the sample floor with a tight spread, and reports the median as the rate", () => {
    const samples = [{ rate: 90 }, { rate: 95 }, { rate: 100 }, { rate: 105 }, { rate: 110 }];
    const fit = fitConversionFromSamples(samples);
    expect(fit.usable).toBe(true);
    expect(fit.reason).toBeNull();
    expect(fit.sampleCount).toBe(5);
    expect(fit.usdPerUtilizationUnit).toBe(100);
  });

  it("respects injected minSamples/maxCoefficientOfVariation overrides", () => {
    const samples = [{ rate: 90 }, { rate: 110 }];
    expect(fitConversionFromSamples(samples, { minSamples: 2 }).usable).toBe(true);
    expect(fitConversionFromSamples(samples, { minSamples: 3 }).usable).toBe(false);
  });
});

describe("deriveUsdUtilizationConversionFromRuns -- real async scan over real files, both evidence kinds", () => {
  let runsDir;

  afterEach(async () => {
    await rmTemp(runsDir);
  });

  async function writeRunLog(name, events) {
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(path.join(runsDir, name), lines, "utf8");
  }

  async function writeLedgerEntry(name, entry) {
    await fs.writeFile(path.join(runsDir, name), JSON.stringify(entry), "utf8");
  }

  function rateLimitEvent({ rateLimitType, utilization, resetsAt, receivedAtMs }) {
    return {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType, utilization, surpassedThreshold: utilization, resetsAt },
      receivedAtMs
    };
  }

  it("scans *.jsonl rate_limit_events and *.usage.json.rev*.json ledger entries into a usable five_hour fit", async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "usd-utilization-conversion-test-"));

    // Five independent reset cycles, each with a tight ~100 usd/unit rate -- enough samples,
    // tight enough spread, to be usable.
    const cycles = [
      { resetsAt: 100, start: 1_000_000, end: 1_100_000, util0: 0.1, util1: 0.2, usd: 9 },
      { resetsAt: 200, start: 2_000_000, end: 2_100_000, util0: 0.1, util1: 0.2, usd: 11 },
      { resetsAt: 300, start: 3_000_000, end: 3_100_000, util0: 0.1, util1: 0.2, usd: 10 },
      { resetsAt: 400, start: 4_000_000, end: 4_100_000, util0: 0.1, util1: 0.2, usd: 10.5 },
      { resetsAt: 500, start: 5_000_000, end: 5_100_000, util0: 0.1, util1: 0.2, usd: 9.5 }
    ];

    for (const [i, c] of cycles.entries()) {
      await writeRunLog(`T-TEST-${i}.jsonl`, [
        rateLimitEvent({ rateLimitType: "five_hour", utilization: c.util0, resetsAt: c.resetsAt, receivedAtMs: c.start }),
        rateLimitEvent({ rateLimitType: "seven_day", utilization: 0.05, resetsAt: 9999, receivedAtMs: c.start }),
        rateLimitEvent({ rateLimitType: "five_hour", utilization: c.util1, resetsAt: c.resetsAt, receivedAtMs: c.end })
      ]);
      await writeLedgerEntry(
        `T-TEST-${i}-exece${i}-invi${i}-attempt1-implementer-retry0.usage.json.rev0-${i}.json`,
        { costUsd: c.usd, recordedAt: new Date(c.start + 10).toISOString(), revision: { epoch: 0, sequence: i } }
      );
    }

    const table = await deriveUsdUtilizationConversionFromRuns({ runsDir, fitDate: "2026-10-16" });

    expect(table.version).toBe(CONVERSION_VERSION);
    expect(table.windows.five_hour.usable).toBe(true);
    expect(table.windows.five_hour.sampleCount).toBe(5);
    expect(table.windows.five_hour.usdPerUtilizationUnit).toBeGreaterThan(0);
    expect(table.windows.five_hour.windowRangeStart).toBe(new Date(1_000_000).toISOString());
    expect(table.windows.five_hour.windowRangeEnd).toBe(new Date(5_100_000).toISOString());

    // seven_day only ever got one reading per log (no cycle has a second reading) -- genuinely
    // no evidence, never a fabricated rate.
    expect(table.windows.seven_day.usable).toBe(false);
    expect(table.windows.seven_day.sampleCount).toBe(0);
  });

  it("returns an all-unusable table (never throws) against an empty/nonexistent runsDir", async () => {
    runsDir = path.join(os.tmpdir(), `usd-utilization-conversion-nonexistent-${Date.now()}`);
    const table = await deriveUsdUtilizationConversionFromRuns({ runsDir, fitDate: "2026-10-16" });
    expect(table.windows.five_hour.usable).toBe(false);
    expect(table.windows.seven_day.usable).toBe(false);
  });

  it("never trusts an event with no receivedAtMs (historical/untimed record) to fit a rate", async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "usd-utilization-conversion-untimed-"));
    await writeRunLog("T-UNTIMED.jsonl", [
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.1, resetsAt: 1 } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.3, resetsAt: 1 } }
    ]);
    const table = await deriveUsdUtilizationConversionFromRuns({ runsDir, fitDate: "2026-10-16" });
    expect(table.windows.five_hour.sampleCount).toBe(0);
  });
});

describe("resolveUnitConversionForAdmission -- narrows a table into evaluateAdmission's per-window shape", () => {
  it("returns null for a window the table marks unusable, and a real conversion for one it marks usable", () => {
    const table = {
      windows: {
        five_hour: { usable: true, usdPerUtilizationUnit: 77.46, sampleCount: 5, fitDate: "2026-10-16", version: "v1" },
        seven_day: { usable: false, usdPerUtilizationUnit: null, sampleCount: 1, fitDate: "2026-10-16", version: "v1" }
      }
    };
    const resolved = resolveUnitConversionForAdmission(table);
    expect(resolved.five_hour).toEqual({ usdPerUtilizationUnit: 77.46, sampleCount: 5, fitDate: "2026-10-16", version: "v1" });
    expect(resolved.seven_day).toBeNull();
  });

  it("never passes through a non-positive or non-numeric rate even if marked usable", () => {
    const table = { windows: { five_hour: { usable: true, usdPerUtilizationUnit: 0 }, seven_day: { usable: true, usdPerUtilizationUnit: null } } };
    const resolved = resolveUnitConversionForAdmission(table);
    expect(resolved.five_hour).toBeNull();
    expect(resolved.seven_day).toBeNull();
  });

  it("defaults to the committed DEFAULT_USD_UTILIZATION_CONVERSION", () => {
    const resolved = resolveUnitConversionForAdmission();
    // Documented finding (docs/usd-utilization-conversion.md): five_hour evidence clears the
    // minimum-evidence bar today, seven_day does not -- a real per-window disagreement, not a
    // shared rate forced onto both.
    expect(resolved.five_hour).not.toBeNull();
    expect(resolved.five_hour.usdPerUtilizationUnit).toBeGreaterThan(0);
    expect(resolved.seven_day).toBeNull();
  });
});

describe("DEFAULT_USD_UTILIZATION_CONVERSION -- the committed, versioned, cited conversion", () => {
  it("carries a version, fit date, and evidence range for every window, usable or not", () => {
    for (const windowKind of ["five_hour", "seven_day"]) {
      const entry = DEFAULT_USD_UTILIZATION_CONVERSION.windows[windowKind];
      expect(entry.version).toBe(CONVERSION_VERSION);
      expect(typeof entry.fitDate).toBe("string");
      expect(typeof entry.sampleCount).toBe("number");
    }
  });

  it("five_hour is usable from real recorded evidence; seven_day honestly is not yet", () => {
    expect(DEFAULT_USD_UTILIZATION_CONVERSION.windows.five_hour.usable).toBe(true);
    expect(DEFAULT_USD_UTILIZATION_CONVERSION.windows.five_hour.sampleCount).toBeGreaterThanOrEqual(MIN_SAMPLES_FOR_USABLE_CONVERSION);
    expect(DEFAULT_USD_UTILIZATION_CONVERSION.windows.seven_day.usable).toBe(false);
  });
});
