import { describe, it, expect } from "vitest";
import { eventsContainUsageLimitSignature } from "../../src/runner/usageLimitDetector.js";

function assistantText(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("eventsContainUsageLimitSignature", () => {
  it("detects a usage-limit phrase in an assistant text block", () => {
    const events = [assistantText("Claude AI usage limit reached. Your limit will reset at 3pm.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a rate-limit phrase in a result event's result field", () => {
    const events = [{ type: "result", is_error: true, result: "Error: rate limited, please retry later" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a raw 429 marker anywhere in the event payload", () => {
    const events = [{ type: "system", subtype: "error", message: "upstream request failed with status 429" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a quota-exceeded phrase", () => {
    const events = [assistantText("You have exceeded your weekly quota for this plan.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("is case-insensitive", () => {
    const events = [assistantText("USAGE LIMIT REACHED")];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
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

describe("eventsContainUsageLimitSignature — structured rate_limit_event telemetry", () => {
  // The claude CLI emits a `rate_limit_event` on EVERY session, including healthy ones.
  // Judging it by substring made `_escalateIfGenuineBlocker` suppress escalation on every
  // exhausted card. These events must be judged by `rate_limit_info.status` alone.
  function rateLimitEvent(info) {
    return { type: "rate_limit_event", rate_limit_info: info, session_id: "abc-123" };
  }

  it("does NOT suppress escalation for a healthy allowed rate_limit_event", () => {
    const events = [
      rateLimitEvent({
        status: "allowed",
        resetsAt: 1787953200,
        rateLimitType: "five_hour",
        isUsingOverage: false,
      }),
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
        surpassedThreshold: 0.9,
      }),
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
        isUsingOverage: false,
      }),
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
        overageDisabledReason: "out_of_credits",
      }),
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("finds a rejection among a long run of healthy telemetry", () => {
    const events = [
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
      assistantText("Running the test suite now."),
      rateLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95 }),
      rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" }),
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
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }),
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });
});

describe("eventsContainUsageLimitSignature — structured error codes and prose", () => {
  it("detects the CLI's session-limit assistant message", () => {
    // Live shape from run T-0233-2026-08-28T14-51-58-912Z.jsonl, the genuine rejection.
    const events = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "You've hit your session limit · resets 6pm (Europe/Budapest)" }],
        },
        error: "rate_limit",
        is_api_error_message: true,
      },
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a bare rate_limit error code with no prose at all", () => {
    expect(eventsContainUsageLimitSignature([{ type: "assistant", error: "rate_limit" }])).toBe(true);
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

  it("still reads prose out of a nested assistant content block", () => {
    const events = [
      {
        type: "assistant",
        message: { content: [{ type: "thinking" }, { type: "text", text: "Claude AI usage limit reached." }] },
      },
    ];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("ignores malformed events instead of throwing", () => {
    expect(eventsContainUsageLimitSignature([null, undefined, 42, [], {}])).toBe(false);
  });
});
