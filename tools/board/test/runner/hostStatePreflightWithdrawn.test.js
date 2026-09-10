// A known-host-issue entry can be WITHDRAWN as well as resolved, and a withdrawn entry must not
// block anything.
//
// The two closure states are not the same thing and must not be conflated:
//
//   resolved  -- a human performed the entry's `action` and confirmed it per `verify`.
//   withdrawn -- the entry's premise turned out to be wrong. Nobody performed the action, and
//                nobody should: doing it is now known to make things worse.
//
// These tests exercise the mechanism itself via fixture entries, not any specific registry entry
// -- the comfyui-determinism-flags entry that originally motivated `withdrawn` (T-0323) was itself
// removed from the registry outright in T-0346, once "determinism flags broke coherence" turned
// out not to be an established finding (0/6 and 0/8 fresh-seed coherence under flags is
// indistinguishable from this graph's ~1/40 baseline coherence rate). The mechanism this file
// tests remains: it may be needed again by a future entry.
import { describe, it, expect } from "vitest";
import { checkHostStatePreflight } from "../../src/runner/hostStatePreflight.js";

const task = (body) => ({ id: "T-0001", body });

describe("hostStatePreflight: withdrawn entries", () => {
  it("does NOT block on a withdrawn entry, even when agent and bodyPattern both match", () => {
    const registry = [
      {
        id: "withdrawn-thing",
        appliesToAgents: ["assets"],
        host: "somewhere",
        condition: "c",
        action: "a",
        reason: "r",
        verify: "v",
        resolved: false,
        withdrawn: true,
        withdrawnReason: "premise disproven"
      }
    ];
    const res = checkHostStatePreflight(task("this card needs reproducible output"), "assets", { registry });
    expect(res.ok).toBe(true);
    expect(res.hostAction).toBeNull();
  });

  it("still blocks on an entry that is neither resolved nor withdrawn", () => {
    const registry = [
      {
        id: "live-thing",
        appliesToAgents: ["assets"],
        host: "somewhere",
        condition: "c",
        action: "a",
        reason: "r",
        verify: "v",
        resolved: false
      }
    ];
    const res = checkHostStatePreflight(task("anything"), "assets", { registry });
    expect(res.ok).toBe(false);
    expect(res.hostAction).toBeTruthy();
  });
});
