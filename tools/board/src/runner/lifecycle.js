export const STATES = Object.freeze(["ready", "in-progress", "validation", "review", "blocked"]);

/**
 * ready -[run]-> in-progress -[submit]-> validation -[pass]-> review
 *                    ^                        |
 *                    +---[fail_validation]----+
 *
 * Any of ready/in-progress/validation can also [fail] straight to blocked
 * (runner crash, not a graded verdict). blocked can only [requeue] back to
 * ready. `review` has no automated outgoing transitions at all — `done` is
 * reachable only by a human, outside this state machine, and does not
 * appear anywhere in this table.
 */
export const TRANSITIONS = Object.freeze({
  ready: Object.freeze({ run: "in-progress", fail: "blocked" }),
  "in-progress": Object.freeze({ submit: "validation", fail: "blocked" }),
  validation: Object.freeze({ pass: "review", fail_validation: "in-progress", fail: "blocked" }),
  review: Object.freeze({}),
  blocked: Object.freeze({ requeue: "ready" })
});

const REASON_REQUIRED_ACTIONS = new Set(["fail", "fail_validation"]);

export class RunnerLifecycle {
  constructor(initialState = "ready") {
    if (!STATES.includes(initialState)) {
      throw new Error(`Invalid initial state "${initialState}"`);
    }
    this.state = initialState;
    this.reason = null;
    this.history = [{ state: initialState, action: null, reason: null }];
  }

  can(action) {
    const allowed = TRANSITIONS[this.state];
    return Boolean(allowed) && Object.prototype.hasOwnProperty.call(allowed, action);
  }

  transition(action, { reason } = {}) {
    if (!this.can(action)) {
      throw new Error(`Illegal transition: cannot "${action}" from state "${this.state}"`);
    }
    if (REASON_REQUIRED_ACTIONS.has(action) && !reason) {
      throw new Error(`Transition "${action}" requires a reason`);
    }

    const target = TRANSITIONS[this.state][action];
    this.state = target;
    this.reason = REASON_REQUIRED_ACTIONS.has(action) ? reason : null;
    this.history.push({ state: target, action, reason: this.reason });
    return this.state;
  }
}
