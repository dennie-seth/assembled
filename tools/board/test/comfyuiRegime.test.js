import { describe, it, expect, vi } from "vitest";
import { resolveComfyUiBaseUrl, evaluateRegime } from "../src/lib/comfyuiRegime.js";

describe("resolveComfyUiBaseUrl", () => {
  it("uses COMFYUI_BASE_URL verbatim (trailing slash stripped) when set", () => {
    const url = resolveComfyUiBaseUrl({ COMFYUI_BASE_URL: "http://127.0.0.1:8188/" });
    expect(url).toBe("http://127.0.0.1:8188");
  });

  it("falls back to the current default-route gateway IP + COMFYUI_PORT when unset -- mirrors comfy_client/base_url.py's resolution order, since the WSL NAT gateway IP is not stable across restarts", () => {
    const execFileSyncFn = vi.fn(() => "default via 172.18.192.1 dev eth0 proto kernel\n");
    const url = resolveComfyUiBaseUrl({}, execFileSyncFn);
    expect(url).toBe("http://172.18.192.1:8188");
    expect(execFileSyncFn).toHaveBeenCalledWith("ip", ["route", "show", "default"], expect.any(Object));
  });

  it("honors COMFYUI_PORT alongside the derived gateway IP", () => {
    const execFileSyncFn = vi.fn(() => "default via 172.18.192.1 dev eth0 proto kernel\n");
    const url = resolveComfyUiBaseUrl({ COMFYUI_PORT: "9999" }, execFileSyncFn);
    expect(url).toBe("http://172.18.192.1:9999");
  });

  it("throws a clear error when no default route line is present", () => {
    const execFileSyncFn = vi.fn(() => "");
    expect(() => resolveComfyUiBaseUrl({}, execFileSyncFn)).toThrow(/no default route/);
  });
});

describe("evaluateRegime -- T-0322: checks the LIVE server's argv against the DECLARED expected regime, in either direction, rather than hardcoding --deterministic as always-required (T-0272/T-0317 rounds 10-12 found forcing it destroys coherence on at least one real graph)", () => {
  const baselineExpected = {
    deterministic: false,
    decidedBy: "@DennieSeth",
    decidedDate: "2026-09-07",
    reason: "T-0317 rounds 10-12"
  };
  const deterministicExpected = {
    deterministic: true,
    decidedBy: "@DennieSeth",
    decidedDate: "2026-09-07",
    reason: "some future card that needs cross-restart reproducibility more than this graph's coherence"
  };

  it("passes when live argv has no --deterministic and the declared regime expects baseline", () => {
    const stats = { system: { argv: ["main.py", "--listen", "0.0.0.0", "--port", "8188"] } };
    const result = evaluateRegime(stats, baselineExpected);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/matches/);
  });

  it("passes when live argv has --deterministic and the declared regime expects it on", () => {
    const stats = { system: { argv: ["main.py", "--listen", "0.0.0.0", "--port", "8188", "--deterministic"] } };
    const result = evaluateRegime(stats, deterministicExpected);
    expect(result.ok).toBe(true);
  });

  it("fails loudly when --deterministic is live but the declared regime expects baseline (a silent revert TOWARD determinism)", () => {
    const stats = { system: { argv: ["main.py", "--listen", "0.0.0.0", "--port", "8188", "--deterministic"] } };
    const result = evaluateRegime(stats, baselineExpected);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/does NOT match/);
    expect(result.summary).toMatch(/expected deterministic=false/);
  });

  it("fails loudly when --deterministic is absent but the declared regime expects it on (a silent revert AWAY from determinism)", () => {
    const stats = { system: { argv: ["main.py", "--listen", "0.0.0.0", "--port", "8188"] } };
    const result = evaluateRegime(stats, deterministicExpected);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/expected deterministic=true/);
  });

  it("includes the declared decision's reason in the failure details, so a FAIL points straight at why the regime was chosen", () => {
    const stats = { system: { argv: ["main.py", "--listen", "0.0.0.0", "--port", "8188", "--deterministic"] } };
    const result = evaluateRegime(stats, baselineExpected);
    expect(result.details.join("\n")).toMatch(/T-0317 rounds 10-12/);
  });

  it("fails with a clear message when system_stats has no system.argv array at all, instead of throwing", () => {
    const result = evaluateRegime({}, baselineExpected);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/argv/);
  });
});
