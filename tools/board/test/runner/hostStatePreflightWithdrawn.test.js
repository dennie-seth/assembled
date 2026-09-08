// A known-host-issue entry can be WITHDRAWN as well as resolved, and a withdrawn entry must not
// block anything.
//
// The two closure states are not the same thing and must not be conflated:
//
//   resolved  -- a human performed the entry's `action` and confirmed it per `verify`.
//   withdrawn -- the entry's premise turned out to be wrong. Nobody performed the action, and
//                nobody should: doing it is now known to make things worse.
//
// The ComfyUI determinism entry is the live case. It asks for `--deterministic` +
// `CUBLAS_WORKSPACE_CONFIG`, and T-0317 rounds 10-12 measured that regime making the §24-e graph
// reliably INCOHERENT -- 6/6 fresh seeds under full determinism, 6/6 again under CUBLAS-only,
// against 8/8 under baseline. The host was deliberately restored to baseline on that evidence, and
// T-0322's own card records the requirement as "wrong as written and must not be implemented as
// stated". Marking it `resolved` would assert the action was taken and verified, which is false;
// deleting it would lose the history the registry deliberately keeps.
import { describe, it, expect } from "vitest";
import { checkHostStatePreflight } from "../../src/runner/hostStatePreflight.js";
import { KNOWN_HOST_ISSUES } from "../../src/runner/knownHostIssues.js";

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

describe("the ComfyUI determinism entry is withdrawn on measured evidence", () => {
  const entry = () => KNOWN_HOST_ISSUES.find((i) => i.id === "comfyui-determinism-flags");

  it("is marked withdrawn, NOT resolved -- nobody performed the action", () => {
    expect(entry().withdrawn).toBe(true);
    expect(entry().resolved).toBe(false);
  });

  it("records why, citing the coherence finding", () => {
    expect(entry().withdrawnReason).toMatch(/coheren|T-0317|baseline/i);
  });

  it("no longer preflight-blocks an assets card that mentions reproducibility", () => {
    const body = "## Round plan\nthe figure that lands in the log has to be reproducible from the committed sheet";
    expect(checkHostStatePreflight(task(body), "assets").ok).toBe(true);
  });

  it("is kept in the registry rather than deleted, so the history stays auditable", () => {
    expect(entry()).toBeTruthy();
    expect(entry().condition.length).toBeGreaterThan(0);
    expect(entry().action.length).toBeGreaterThan(0);
  });
});
