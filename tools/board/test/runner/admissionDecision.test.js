import { describe, it, expect, vi, afterEach } from "vitest";
import { READING_STATUS } from "../../src/runner/usageTelemetry.js";
import {
  HOLD_REASON,
  DEFAULT_ADMISSION_CONFIG,
  evaluateWindowAdmission,
  evaluateAdmission,
  admissionEnforcementEnabledFromEnv,
  loadAdmissionConfigFromEnv
} from "../../src/runner/admissionDecision.js";
import { resolveUnitConversionForAdmission, DEFAULT_USD_UTILIZATION_CONVERSION } from "../../src/runner/usdUtilizationConversion.js";

function reading(overrides = {}) {
  return {
    windowKind: "five_hour",
    classification: READING_STATUS.MEASURED,
    utilization: 0.2,
    resetElapsed: false,
    status: "allowed",
    ...overrides
  };
}

function estimate(overrides = {}) {
  return { value: 1, unit: "usd", classification: "empirical", ...overrides };
}

const config = { dial: 1, externalBurnAllowance: 0.05, uncertaintyReserve: 0.05 };

describe("evaluateWindowAdmission -- only a measured reading is verified capacity", () => {
  it.each([READING_STATUS.ESTIMATED, READING_STATUS.STALE, READING_STATUS.UNAVAILABLE])(
    "holds with NO_MEASURED_READING for a %s reading",
    (classification) => {
      const decision = evaluateWindowAdmission({
        windowKind: "five_hour",
        reading: reading({ classification, utilization: null }),
        estimate: estimate(),
        reservedUnspentCostUsd: 0,
        config
      });
      expect(decision.admitted).toBeNull();
      expect(decision.holdReason).toBe(HOLD_REASON.NO_MEASURED_READING);
    }
  );

  it("holds for an elapsed-reset estimated-0 reading, never treating it as verified headroom (2026-09-12 design note)", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ classification: READING_STATUS.ESTIMATED, utilization: 0, resetElapsed: true }),
      estimate: estimate(),
      reservedUnspentCostUsd: 0,
      config
    });
    expect(decision.admitted).toBeNull();
    expect(decision.holdReason).toBe(HOLD_REASON.NO_MEASURED_READING);
  });

  it("holds for a status-only allowed reading, never treating it as verified headroom (2026-09-12 design note)", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ classification: READING_STATUS.ESTIMATED, utilization: 0, status: "allowed" }),
      estimate: estimate(),
      reservedUnspentCostUsd: 0,
      config
    });
    expect(decision.admitted).toBeNull();
    expect(decision.holdReason).toBe(HOLD_REASON.NO_MEASURED_READING);
  });
});

describe("evaluateWindowAdmission -- estimate must be a real known number", () => {
  it("holds with ESTIMATE_UNKNOWN for a null-value indeterminate estimate", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading(),
      estimate: estimate({ value: null, classification: "indeterminate" }),
      reservedUnspentCostUsd: 0,
      config
    });
    expect(decision.admitted).toBeNull();
    expect(decision.holdReason).toBe(HOLD_REASON.ESTIMATE_UNKNOWN);
  });

  it("holds with ESTIMATE_UNKNOWN for a large_hold_for_sizing estimate", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading(),
      estimate: estimate({ value: null, classification: "large_hold_for_sizing" }),
      reservedUnspentCostUsd: 0,
      config
    });
    expect(decision.holdReason).toBe(HOLD_REASON.ESTIMATE_UNKNOWN);
  });
});

describe("evaluateWindowAdmission -- T-0370 fix round finding 1/6: an unknown reserved-unspent-cost is an explicit hold, never a fabricated zero", () => {
  const unitConversion = { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" };

  it("holds with RESERVED_COST_UNKNOWN when reservedUnspentCostUsd is null (a failed pool listing or unreadable ledger, never coerced to 0)", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.1 }),
      estimate: estimate({ value: 0.5 }),
      reservedUnspentCostUsd: null,
      config,
      unitConversion
    });
    expect(decision.admitted).toBeNull();
    expect(decision.holdReason).toBe(HOLD_REASON.RESERVED_COST_UNKNOWN);
  });

  it("still admits normally when reservedUnspentCostUsd is a real number (unaffected by the new guard)", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.1 }),
      estimate: estimate({ value: 0.5 }),
      reservedUnspentCostUsd: 1,
      config,
      unitConversion
    });
    expect(decision.holdReason).not.toBe(HOLD_REASON.RESERVED_COST_UNKNOWN);
  });
});

describe("evaluateWindowAdmission -- units must match", () => {
  it("holds with UNITS_NOT_COMPARABLE for a USD estimate against a utilization-only reading, with no conversion supplied (the default)", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.1 }),
      estimate: estimate({ value: 0.5 }),
      reservedUnspentCostUsd: 0,
      config
    });
    expect(decision.admitted).toBeNull();
    expect(decision.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
  });

  it("never fabricates a number even when the estimate is small and capacity looks ample", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.01 }),
      estimate: estimate({ value: 0.01 }),
      reservedUnspentCostUsd: 0,
      config
    });
    expect(decision.admitted).toBeNull();
    expect(decision.budget).toBeNull();
  });
});

describe("evaluateWindowAdmission -- with a versioned unit conversion, applies spec §4's formula", () => {
  const unitConversion = { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" };

  it("admits when the predicted cost fits inside the remaining budget", () => {
    // remaining = 1 - 0.2 = 0.8; reserved 1usd/10 = 0.1 (utilization units); allowance 0.05; uncertainty 0.05
    // budget = 0.8 - 0.1 - 0.05 - 0.05 = 0.6 (utilization units); predicted 1usd/10 = 0.1 utilization units <= 0.6 -> admitted
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.2 }),
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 1,
      config,
      unitConversion
    });
    expect(decision.admitted).toBe(true);
    expect(decision.holdReason).toBeNull();
    expect(decision.budget).toBeCloseTo(0.6);
  });

  it("refuses when the predicted cost exceeds the remaining budget", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.95 }),
      estimate: estimate({ value: 10 }),
      reservedUnspentCostUsd: 0,
      config,
      unitConversion
    });
    // remaining = 0.05, allowance 0.05, uncertainty 0.05 -> budget = max(0, 0.05-0-0.05-0.05) = 0
    expect(decision.admitted).toBe(false);
    expect(decision.budget).toBe(0);
  });

  it("clamps the subtractable budget at zero rather than going negative", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.99 }),
      estimate: estimate({ value: 0.01 }),
      reservedUnspentCostUsd: 50,
      config,
      unitConversion
    });
    expect(decision.budget).toBe(0);
    expect(decision.admitted).toBe(false);
  });

  it("the dial scales the effective budget", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.2 }),
      estimate: estimate({ value: 5 }),
      reservedUnspentCostUsd: 0,
      config: { ...config, dial: 0.5 },
      unitConversion
    });
    // budget (unscaled) = 0.8-0.05-0.05 = 0.7 -> 7usd; dial*budget = 3.5usd; predicted 5usd > 3.5usd -> refused
    expect(decision.admitted).toBe(false);
  });
});

describe("evaluateWindowAdmission -- T-0379: an estimate that could never fit, even at full headroom, is named distinctly", () => {
  const unitConversion = { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" };

  it("holds with OVERSIZED_ESTIMATE_NEVER_FITS when the estimate exceeds the theoretical max budget even at 0% utilization", () => {
    // max possible budget at utilization=0: 1 - 0.05 - 0.05 = 0.9 window units = 9usd. A 100usd
    // estimate (10 window units) can never fit this window, no matter how idle it is.
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0 }),
      estimate: estimate({ value: 100 }),
      reservedUnspentCostUsd: 0,
      config,
      unitConversion
    });
    expect(decision.admitted).toBe(false);
    expect(decision.holdReason).toBe(HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS);
  });

  it("does NOT hold OVERSIZED_ESTIMATE_NEVER_FITS for a refusal that would fit at a lower current utilization", () => {
    // remaining = 0.5, budget = 0.5-0.05-0.05 = 0.4 window units = 4usd; a 5usd estimate is refused
    // right now, but max possible budget at utilization=0 is 0.9 window units = 9usd >= 5usd, so it
    // is NOT permanently oversized -- just currently too tight.
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.5 }),
      estimate: estimate({ value: 5 }),
      reservedUnspentCostUsd: 0,
      config,
      unitConversion
    });
    expect(decision.admitted).toBe(false);
    expect(decision.holdReason).toBeNull();
  });

  it("never marks an admitted decision as oversized", () => {
    const decision = evaluateWindowAdmission({
      windowKind: "five_hour",
      reading: reading({ utilization: 0.1 }),
      estimate: estimate({ value: 0.1 }),
      reservedUnspentCostUsd: 0,
      config,
      unitConversion
    });
    expect(decision.admitted).toBe(true);
    expect(decision.holdReason).toBeNull();
  });
});

describe("evaluateAdmission -- evaluates both windows independently, in the same verified units", () => {
  // T-0402: `unitConversion` is keyed per window -- each window's own derived rate (or lack of
  // one) applies ONLY to that window, never shared across both. These tests give both windows the
  // identical rate (there's nothing in this describe block exercising a real disagreement between
  // them); see the next describe block for a per-window conversion that differs or is absent.
  const perWindowConversion = { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" };
  const unitConversion = { five_hour: perWindowConversion, seven_day: perWindowConversion };
  const nestedConfig = {
    dial: 1,
    externalBurnAllowance: { five_hour: 0.05, seven_day: 0.05 },
    uncertaintyReserve: { five_hour: 0.05, seven_day: 0.05 }
  };

  it("a healthy 5-hour reading never masks an exhausted weekly window", () => {
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.05 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 1 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion
    });
    expect(result.windows.five_hour.admitted).toBe(true);
    expect(result.windows.seven_day.admitted).toBe(false);
    expect(result.admitted).toBe(false);
  });

  it("a healthy weekly reading never masks an exhausted 5-hour window", () => {
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.05 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion
    });
    expect(result.windows.five_hour.admitted).toBe(false);
    expect(result.windows.seven_day.admitted).toBe(true);
    expect(result.admitted).toBe(false);
  });

  it("admits only when every window admits", () => {
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.1 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion
    });
    expect(result.admitted).toBe(true);
  });

  it("is a hold (never an admit) when any window holds, even without a unit conversion", () => {
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.1 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig
    });
    expect(result.admitted).toBeNull();
    expect(result.windows.five_hour.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
  });
});

describe("evaluateAdmission -- T-0402: a per-window unitConversion, never a shared flat rate", () => {
  const nestedConfig = {
    dial: 1,
    externalBurnAllowance: { five_hour: 0.05, seven_day: 0.05 },
    uncertaintyReserve: { five_hour: 0.05, seven_day: 0.05 }
  };

  it("T-0402 fix round (human CHANGES REQUESTED on #449): a window's own UNITS_NOT_COMPARABLE gap still vetoes the aggregate, even when the OTHER window genuinely fits", () => {
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.1 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion: { five_hour: { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" }, seven_day: null }
    });
    expect(result.windows.five_hour.holdReason).not.toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    expect(result.windows.five_hour.admitted).toBe(true);
    expect(result.windows.seven_day.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    // T-0402 fix round: a round-2 attempt treated `UNITS_NOT_COMPARABLE` as a non-veto so this
    // case returned `admitted: true`. @DennieSeth's #449 review (2026-10-16T17:12) rejected that:
    // a window whose capacity CANNOT be compared with the estimate is an unresolved unknown, not
    // an absent window -- the aggregate must stay the documented fail-safe (`null`), exactly as
    // it did before any conversion existed, until `seven_day` itself clears the evidence bar.
    expect(result.admitted).toBeNull();
  });

  it("T-0402 fix round: a fully-exhausted weekly window with no usable conversion must never let a fitting five_hour window admit the aggregate -- the exact scenario from #449's review", () => {
    // @DennieSeth's review measured this precise pair directly against the committed default:
    // five_hour utilization 0.10 (fits), seven_day utilization 1.00 (fully consumed), a known
    // $0.50 estimate, no reservations -- and found the round-2 code returned aggregate
    // `admitted: true` anyway, because `seven_day`'s only reported problem was
    // `UNITS_NOT_COMPARABLE`. A fully consumed window must never be waved through just because it
    // also happens to lack a conversion.
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 1 })
      },
      estimate: estimate({ value: 0.5 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion: { five_hour: { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" }, seven_day: null }
    });
    expect(result.windows.five_hour.admitted).toBe(true);
    expect(result.windows.seven_day.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    expect(result.admitted).not.toBe(true);
    expect(result.admitted).toBeNull();
  });

  it("T-0402 fix round: the restored guard never overrides an actual measured shortage in the OTHER window either -- a real `false` still vetoes", () => {
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.99 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.1 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion: { five_hour: { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" }, seven_day: null }
    });
    expect(result.windows.five_hour.admitted).toBe(false);
    expect(result.windows.seven_day.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    // A real measured `false` always wins over a `null`, regardless of hold reason.
    expect(result.admitted).toBe(false);
  });

  it("when NO window has a usable conversion, the aggregate stays the original fail-safe (null), unchanged from before this card", () => {
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.1 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion: { five_hour: null, seven_day: null }
    });
    expect(result.windows.five_hour.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    expect(result.windows.seven_day.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    expect(result.admitted).toBeNull();
  });

  it("two windows with very different per-window rates each apply only to their own window, never averaged or shared", () => {
    const cheapFiveHour = { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" };
    const expensiveSevenDay = { usdPerUtilizationUnit: 1000, sampleCount: 20, fitDate: "2026-09-01", version: "v1" };
    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.1 })
      },
      // 5usd: comfortably inside five_hour's (10usd/unit) budget, but 5usd/1000usd-per-unit is a
      // vanishingly small ask of seven_day's budget too -- both windows admit, each against its
      // OWN rate, never the other's.
      estimate: estimate({ value: 5 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion: { five_hour: cheapFiveHour, seven_day: expensiveSevenDay }
    });
    expect(result.windows.five_hour.predictedRemainingCostUpperBound).toBeCloseTo(0.5); // 5usd / 10usd-per-unit
    expect(result.windows.seven_day.predictedRemainingCostUpperBound).toBeCloseTo(0.005); // 5usd / 1000usd-per-unit
  });
});

/**
 * T-0457 investigated why seven_day's censoring drops its one other candidate rate-sample cycle
 * and found that recovering it would not clear MIN_SAMPLES_FOR_USABLE_CONVERSION regardless (see
 * docs/usd-utilization-conversion.md) -- so `DEFAULT_USD_UTILIZATION_CONVERSION.windows.seven_day`
 * stays `null` through `resolveUnitConversionForAdmission`, exactly as it did before this card.
 * This exercises the REAL committed table (not a hand-built stub) through the REAL
 * evaluateAdmission fail-safe T-0402 restored, so a future change to either module can't silently
 * let a fitting five_hour window wave through an aggregate seven_day can't yet be compared against.
 */
describe("evaluateAdmission -- T-0457: the real committed conversion's seven_day gap still vetoes the aggregate", () => {
  const nestedConfig = {
    dial: 1,
    externalBurnAllowance: { five_hour: 0.05, seven_day: 0.05 },
    uncertaintyReserve: { five_hour: 0.05, seven_day: 0.05 }
  };

  it("resolveUnitConversionForAdmission(DEFAULT_USD_UTILIZATION_CONVERSION) still resolves seven_day to null, and the aggregate still holds on it even with a genuinely fitting five_hour window", () => {
    const unitConversion = resolveUnitConversionForAdmission(DEFAULT_USD_UTILIZATION_CONVERSION);
    expect(unitConversion.five_hour).not.toBeNull();
    expect(unitConversion.seven_day).toBeNull();

    const result = evaluateAdmission({
      telemetryReadings: {
        five_hour: reading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: reading({ windowKind: "seven_day", utilization: 0.1 })
      },
      estimate: estimate({ value: 1 }),
      reservedUnspentCostUsd: 0,
      config: nestedConfig,
      unitConversion
    });
    expect(result.windows.five_hour.holdReason).not.toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    expect(result.windows.seven_day.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    expect(result.admitted).toBeNull();
  });
});

describe("admissionEnforcementEnabledFromEnv", () => {
  const originalEnv = process.env.WIP_GATE_ENFORCEMENT_ENABLED;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WIP_GATE_ENFORCEMENT_ENABLED;
    else process.env.WIP_GATE_ENFORCEMENT_ENABLED = originalEnv;
  });

  it("defaults to false (advisory) when unset", () => {
    delete process.env.WIP_GATE_ENFORCEMENT_ENABLED;
    expect(admissionEnforcementEnabledFromEnv()).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "TRUE"])("accepts %s as enabled", (v) => {
    process.env.WIP_GATE_ENFORCEMENT_ENABLED = v;
    expect(admissionEnforcementEnabledFromEnv()).toBe(true);
  });

  it("stays false for garbage input", () => {
    process.env.WIP_GATE_ENFORCEMENT_ENABLED = "banana";
    expect(admissionEnforcementEnabledFromEnv()).toBe(false);
  });
});

describe("loadAdmissionConfigFromEnv", () => {
  const keys = [
    "WIP_GATE_DIAL",
    "WIP_GATE_EXTERNAL_BURN_ALLOWANCE_FIVE_HOUR",
    "WIP_GATE_EXTERNAL_BURN_ALLOWANCE_SEVEN_DAY",
    "WIP_GATE_UNCERTAINTY_RESERVE_FIVE_HOUR",
    "WIP_GATE_UNCERTAINTY_RESERVE_SEVEN_DAY"
  ];
  const saved = {};

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns the documented defaults when nothing is set, and logs nothing", () => {
    for (const k of keys) delete process.env[k];
    const logger = { log: vi.fn() };
    const cfg = loadAdmissionConfigFromEnv({ logger });
    expect(cfg).toEqual(DEFAULT_ADMISSION_CONFIG);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("applies and logs an explicit dial override", () => {
    for (const k of keys) delete process.env[k];
    process.env.WIP_GATE_DIAL = "0.5";
    const logger = { log: vi.fn() };
    const cfg = loadAdmissionConfigFromEnv({ logger });
    expect(cfg.dial).toBe(0.5);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("WIP_GATE_DIAL"));
  });

  it("applies and logs explicit per-window external burn allowance and uncertainty reserve overrides", () => {
    for (const k of keys) delete process.env[k];
    process.env.WIP_GATE_EXTERNAL_BURN_ALLOWANCE_FIVE_HOUR = "0.2";
    process.env.WIP_GATE_UNCERTAINTY_RESERVE_SEVEN_DAY = "0.3";
    const logger = { log: vi.fn() };
    const cfg = loadAdmissionConfigFromEnv({ logger });
    expect(cfg.externalBurnAllowance.five_hour).toBe(0.2);
    expect(cfg.uncertaintyReserve.seven_day).toBe(0.3);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("WIP_GATE_EXTERNAL_BURN_ALLOWANCE_FIVE_HOUR"));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("WIP_GATE_UNCERTAINTY_RESERVE_SEVEN_DAY"));
  });

  it("falls back to the default for garbage numeric input", () => {
    for (const k of keys) delete process.env[k];
    process.env.WIP_GATE_DIAL = "not-a-number";
    const cfg = loadAdmissionConfigFromEnv({ logger: { log: vi.fn() } });
    expect(cfg.dial).toBe(DEFAULT_ADMISSION_CONFIG.dial);
  });
});
