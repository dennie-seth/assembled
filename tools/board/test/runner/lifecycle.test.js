import { describe, it, expect } from "vitest";
import { RunnerLifecycle, STATES, TRANSITIONS } from "../../src/runner/lifecycle.js";

describe("RunnerLifecycle — every valid transition", () => {
  it("ready --run--> in-progress", () => {
    const lc = new RunnerLifecycle("ready");
    expect(lc.transition("run")).toBe("in-progress");
    expect(lc.state).toBe("in-progress");
  });

  it("in-progress --submit--> validation (implementer hands off)", () => {
    const lc = new RunnerLifecycle("in-progress");
    expect(lc.transition("submit")).toBe("validation");
  });

  it("validation --pass--> review", () => {
    const lc = new RunnerLifecycle("validation");
    expect(lc.transition("pass")).toBe("review");
  });

  it("validation --fail_validation(reason)--> in-progress, carrying the reason", () => {
    const lc = new RunnerLifecycle("validation");
    lc.transition("fail_validation", { reason: "lint failed on src/foo.js:12" });
    expect(lc.state).toBe("in-progress");
    expect(lc.reason).toBe("lint failed on src/foo.js:12");
  });

  it("blocked --requeue--> ready (human requeues after investigating)", () => {
    const lc = new RunnerLifecycle("blocked");
    expect(lc.transition("requeue")).toBe("ready");
  });

  it("ready --fail(reason)--> blocked (worktree/spawn failure before a run even starts)", () => {
    const lc = new RunnerLifecycle("ready");
    lc.transition("fail", { reason: "worktree creation failed" });
    expect(lc.state).toBe("blocked");
    expect(lc.reason).toBe("worktree creation failed");
  });

  it("in-progress --fail(reason)--> blocked (stream died mid-run)", () => {
    const lc = new RunnerLifecycle("in-progress");
    lc.transition("fail", { reason: "child process crashed, exit code 1" });
    expect(lc.state).toBe("blocked");
    expect(lc.reason).toBe("child process crashed, exit code 1");
  });

  it("validation --fail(reason)--> blocked (reviewer couldn't complete, not a FAIL verdict)", () => {
    const lc = new RunnerLifecycle("validation");
    lc.transition("fail", { reason: "build environment broken, tests would not start" });
    expect(lc.state).toBe("blocked");
    expect(lc.reason).toBe("build environment broken, tests would not start");
  });
});

describe("RunnerLifecycle — illegal transitions are rejected", () => {
  it("review has no automated outgoing transitions at all", () => {
    const lc = new RunnerLifecycle("review");
    expect(lc.can("run")).toBe(false);
    expect(lc.can("pass")).toBe(false);
    expect(lc.can("submit")).toBe(false);
    expect(() => lc.transition("run")).toThrow(/illegal transition/i);
  });

  it("rejects skipping in-progress: ready cannot go straight to validation", () => {
    const lc = new RunnerLifecycle("ready");
    expect(() => lc.transition("pass")).toThrow(/illegal transition/i);
  });

  it("rejects skipping ready: blocked cannot go straight to in-progress", () => {
    const lc = new RunnerLifecycle("blocked");
    expect(() => lc.transition("submit")).toThrow(/illegal transition/i);
  });

  it("rejects review going backwards to in-progress via automation", () => {
    const lc = new RunnerLifecycle("review");
    expect(() => lc.transition("fail_validation", { reason: "human bounced it" })).toThrow(
      /illegal transition/i
    );
  });

  it("rejects an unknown action name", () => {
    const lc = new RunnerLifecycle("ready");
    expect(() => lc.transition("teleport")).toThrow(/illegal transition/i);
  });

  it("requires a reason for fail and fail_validation", () => {
    expect(() => new RunnerLifecycle("ready").transition("fail")).toThrow(/reason/i);
    expect(() => new RunnerLifecycle("validation").transition("fail_validation")).toThrow(/reason/i);
  });

  it("rejects an invalid initial state", () => {
    expect(() => new RunnerLifecycle("done")).toThrow();
    expect(() => new RunnerLifecycle("bogus")).toThrow();
  });
});

describe("RunnerLifecycle — the FAIL loop-back path", () => {
  it("validation FAIL sends the card back to in-progress, and it can be resubmitted", () => {
    const lc = new RunnerLifecycle("ready");
    lc.transition("run");
    lc.transition("submit");
    expect(lc.state).toBe("validation");

    lc.transition("fail_validation", { reason: "missing test coverage for edge case" });
    expect(lc.state).toBe("in-progress");
    expect(lc.reason).toBe("missing test coverage for edge case");

    lc.transition("submit");
    expect(lc.state).toBe("validation");

    lc.transition("pass");
    expect(lc.state).toBe("review");
  });

  it("records the full transition history in order, including the reason", () => {
    const lc = new RunnerLifecycle("ready");
    lc.transition("run");
    lc.transition("submit");
    lc.transition("fail_validation", { reason: "nope" });

    expect(lc.history.map((h) => h.state)).toEqual(["ready", "in-progress", "validation", "in-progress"]);
    expect(lc.history.at(-1).action).toBe("fail_validation");
    expect(lc.history.at(-1).reason).toBe("nope");
  });
});

describe("RunnerLifecycle — done is unreachable by automation", () => {
  it("'done' is not one of the managed states", () => {
    expect(STATES).not.toContain("done");
  });

  it("no transition table entry, in any state, targets 'done'", () => {
    for (const [, actions] of Object.entries(TRANSITIONS)) {
      for (const target of Object.values(actions)) {
        expect(target).not.toBe("done");
      }
    }
  });

  it("calling transition with action 'done' throws from every reachable state", () => {
    for (const state of STATES) {
      const lc = new RunnerLifecycle(state);
      expect(() => lc.transition("done")).toThrow(/illegal transition/i);
    }
  });

  it("exposes no complete()/markDone()-style escape hatch", () => {
    const lc = new RunnerLifecycle("review");
    expect(typeof lc.done).not.toBe("function");
    expect(typeof lc.complete).not.toBe("function");
    expect(typeof lc.markDone).not.toBe("function");
    expect(typeof lc.finish).not.toBe("function");
  });

  it("the transition table is frozen and cannot be mutated to add a done path", () => {
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    expect(() => {
      TRANSITIONS.review.hack = "done";
    }).toThrow();
    const lc = new RunnerLifecycle("review");
    expect(() => lc.transition("hack")).toThrow(/illegal transition/i);
  });
});
