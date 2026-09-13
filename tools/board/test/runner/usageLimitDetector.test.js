import { describe, it, expect } from "vitest";
import { eventsContainUsageLimitSignature, usageLimitSignatureForEvents } from "../../src/runner/usageLimitDetector.js";

function assistantText(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

/** Real 429 session-limit stop shape (card evidence, T-0366-2026-09-11T18-15-10-554Z.jsonl). */
function quotaStopResultEvent() {
  return {
    type: "result",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 429,
    result: "You've hit your session limit · resets 6pm (Europe/Budapest)",
    total_cost_usd: 1.42,
    usage: { input_tokens: 12000, output_tokens: 3400, cache_creation_input_tokens: 500, cache_read_input_tokens: 8000 }
  };
}

/** A healthy result event -- the CLI's normal end of turn, whatever prose it happens to quote. */
function completedResultEvent(resultText) {
  return { type: "result", is_error: false, terminal_reason: "completed", result: resultText };
}

function rateLimitEvent(info) {
  return { type: "rate_limit_event", rate_limit_info: info, session_id: "abc-123" };
}

describe("eventsContainUsageLimitSignature -- T-0377 / PR #381: prose alone never counts", () => {
  // Every one of these used to false-positive because eventIndicatesUsageLimit matched
  // USAGE_LIMIT_RE against assistant/tool/result prose. T-0367/PR #381: a card whose own docs,
  // fixtures and reviewer notes quoted "You've hit your session limit" 39 times, on a run whose
  // six `result` events all ended `terminal_reason: "completed"` with no `api_error_status`, had
  // its genuine reviewer FAIL swallowed as a quota pause. Only structured signals count now.

  it("does not treat a usage-limit phrase in an assistant text block as a stop", () => {
    const events = [assistantText("Claude AI usage limit reached. Your limit will reset at 3pm.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does not treat a rate-limit phrase in a completed result event's own result field as a stop", () => {
    const events = [completedResultEvent("Error: rate limited, please retry later")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does not treat a raw 429 marker in tool/system output prose as a stop", () => {
    const events = [{ type: "system", subtype: "error", message: "upstream request failed with status 429" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does not treat a quota-exceeded phrase in prose as a stop", () => {
    const events = [assistantText("You have exceeded your weekly quota for this plan.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does not treat a result event with is_error true but no terminal_reason/api_error_status as a stop", () => {
    // is_error alone doesn't prove a 429 -- could be any other kind of failure quoting the phrase.
    const events = [{ type: "result", is_error: true, result: "Error: rate limited, please retry later" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does not treat quoted session-limit text in a reviewer verdict's prose as a stop", () => {
    const events = [assistantText("Reviewer notes: fixture asserts the CLI's \"You've hit your session limit\" text is handled.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("returns false for a genuine code/test failure with no limit signature", () => {
    const events = [assistantText("TypeError: cannot read properties of undefined (reading 'foo')")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("returns false for an empty events array", () => {
    expect(eventsContainUsageLimitSignature([])).toBe(false);
  });

  it("returns false for a non-array input", () => {
    expect(eventsContainUsageLimitSignature(null)).toBe(false);
    expect(eventsContainUsageLimitSignature(undefined)).toBe(false);
  });

  it("does not false-positive on unrelated text merely containing the word 'limit'", () => {
    const events = [assistantText("I set a character limit of 80 columns for this file per the style guide.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });
});

describe("eventsContainUsageLimitSignature -- the real T-0367-2026-09-12T12-28-47-077Z.jsonl shape", () => {
  it("is classified as no usage limit: six completed results, healthy telemetry, 39x quoted session-limit text", () => {
    const sessionLimitQuote = assistantText(
      "Fixture text under test: the CLI's own refusal message reads \"You've hit your session limit\" verbatim."
    );
    const events = [
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
      sessionLimitQuote,
      completedResultEvent("Attempt 1 complete."),
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
      sessionLimitQuote,
      completedResultEvent("Attempt 2 complete."),
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
      sessionLimitQuote,
      completedResultEvent("Attempt 3 complete."),
      { type: "result", is_error: false, result: "reviewer verdict: FAIL -- three genuine issues, none of them a session limit." },
      completedResultEvent("Attempt 4 complete."),
      completedResultEvent("Attempt 5 complete."),
      completedResultEvent("Attempt 6 complete.")
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
    expect(usageLimitSignatureForEvents(events)).toBeNull();
  });
});

describe("eventsContainUsageLimitSignature -- a genuine structured stop is still detected (T-0366-2026-09-11T18-15-10-554Z.jsonl shape)", () => {
  it("detects a terminal result event with is_error true, terminal_reason api_error, api_error_status 429", () => {
    const events = [quotaStopResultEvent()];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects it among a run of otherwise-healthy events", () => {
    const events = [
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
      assistantText("Running the implementer now."),
      quotaStopResultEvent()
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a rejected rate_limit_info", () => {
    const events = [rateLimitEvent({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1787932800 })];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });
});

describe("usageLimitSignatureForEvents -- names which structured signal fired", () => {
  it("names the rate_limit_info rejection", () => {
    const events = [rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" })];
    expect(usageLimitSignatureForEvents(events)).toMatch(/rate_limit_info/);
    expect(usageLimitSignatureForEvents(events)).toMatch(/rejected/);
  });

  it("names the terminal api_error/429 result", () => {
    const signature = usageLimitSignatureForEvents([quotaStopResultEvent()]);
    expect(signature).toMatch(/api_error/);
    expect(signature).toMatch(/429/);
  });

  it("names the explicit error code", () => {
    const signature = usageLimitSignatureForEvents([{ type: "assistant", error: "rate_limit" }]);
    expect(signature).toMatch(/error=rate_limit/);
  });

  it("returns null when nothing structured matched", () => {
    expect(usageLimitSignatureForEvents([assistantText("session limit reached")])).toBeNull();
  });

  it("returns null for a non-array input", () => {
    expect(usageLimitSignatureForEvents(null)).toBeNull();
  });
});

describe("eventsContainUsageLimitSignature -- structured rate_limit_event telemetry", () => {
  // The claude CLI emits a `rate_limit_event` on EVERY session, including healthy ones.
  // Judging it by substring made `_escalateIfGenuineBlocker` suppress escalation on every
  // exhausted card. These events must be judged by `rate_limit_info.status` alone.

  it("does NOT suppress escalation for a healthy allowed rate_limit_event", () => {
    const events = [
      rateLimitEvent({
        status: "allowed",
        resetsAt: 1787953200,
        rateLimitType: "five_hour",
        isUsingOverage: false
      })
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does NOT suppress escalation for an allowed_warning event, even at high utilization", () => {
    const events = [
      rateLimitEvent({
        status: "allowed_warning",
        resetsAt: 1787932800,
        rateLimitType: "five_hour",
        utilization: 0.99,
        surpassedThreshold: 0.9
      })
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does NOT suppress escalation when overage is unavailable but the request was still allowed", () => {
    // `overageStatus: "rejected"` / `out_of_credits` ride along on healthy events too --
    // only the top-level `status` says whether THIS request was refused.
    const events = [
      rateLimitEvent({
        status: "allowed",
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false
      })
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("DOES suppress escalation for a genuine rejected rate_limit_event", () => {
    const events = [
      rateLimitEvent({
        status: "rejected",
        resetsAt: 1787932800,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits"
      })
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("finds a rejection among a long run of healthy telemetry", () => {
    const events = [
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
      assistantText("Running the test suite now."),
      rateLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95 }),
      rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" })
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("does not suppress a whole run of healthy telemetry plus a real code failure", () => {
    // The T-0233 shape: retries exhausted on an unsatisfiable acceptance criterion,
    // every rate_limit_event `allowed`. This MUST escalate.
    const events = [
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
      assistantText("Criterion 2 is not satisfiable: the approved concept sheet depicts 5 props."),
      { type: "result", is_error: false, result: "reviewer verdict: FAIL" },
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" })
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });
});

describe("eventsContainUsageLimitSignature -- structured error codes and non-prose fields", () => {
  it("detects the CLI's session-limit assistant message via its error code, not its prose", () => {
    // Live shape from run T-0233-2026-08-28T14-51-58-912Z.jsonl, the genuine rejection. The
    // `error: "rate_limit"` field is what makes this count -- the quoted prose alone would not.
    const events = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "You've hit your session limit · resets 6pm (Europe/Budapest)" }]
        },
        error: "rate_limit",
        is_api_error_message: true
      }
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a bare rate_limit error code with no prose at all", () => {
    expect(eventsContainUsageLimitSignature([{ type: "assistant", error: "rate_limit" }])).toBe(true);
  });

  it("is case-insensitive on the error code", () => {
    expect(eventsContainUsageLimitSignature([{ type: "assistant", error: "RATE_LIMIT" }])).toBe(true);
  });

  it("does not match a discriminator field that merely names the rate-limit type", () => {
    // `type` / `subtype` are enum discriminators, not prose -- matching them is what caused the bug.
    const events = [{ type: "rate_limit_event", subtype: "five_hour_rate_limit" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does not match a session id or uuid that happens to contain a marker", () => {
    const events = [{ type: "assistant", session_id: "429-abc", uuid: "rate-limit-0001" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("does not read prose out of a nested assistant content block on its own", () => {
    // No error code, no rate_limit_info, no terminal api_error/429 result -- prose alone.
    const events = [
      {
        type: "assistant",
        message: { content: [{ type: "thinking" }, { type: "text", text: "Claude AI usage limit reached." }] }
      }
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("ignores malformed events instead of throwing", () => {
    expect(eventsContainUsageLimitSignature([null, undefined, 42, [], {}])).toBe(false);
  });
});
