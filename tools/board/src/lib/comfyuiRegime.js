import { execFileSync } from "node:child_process";

/**
 * Resolves the ComfyUI base URL the same way `tools/comfy-client/src/comfy_client/base_url.py`
 * does, so the JS side (board ops checks) and the Python side (comfy-client) can never silently
 * diverge on where "ComfyUI" is:
 *
 * 1. `COMFYUI_BASE_URL` env var, verbatim (trailing slash stripped).
 * 2. The Windows host IP, read fresh from the current default route (`ip route show default`),
 *    combined with `COMFYUI_PORT` (default 8188) -- the WSL NAT gateway IP is not stable across
 *    WSL restarts (docs/comfyui-setup.md), so it is never hardcoded.
 *
 * `execFileSyncFn` is injectable so tests never actually shell out to `ip`.
 */
export function resolveComfyUiBaseUrl(env = process.env, execFileSyncFn = execFileSync) {
  const override = env.COMFYUI_BASE_URL;
  if (override) {
    return override.replace(/\/+$/, "");
  }

  const port = env.COMFYUI_PORT || "8188";
  const output = execFileSyncFn("ip", ["route", "show", "default"], { encoding: "utf8" });
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== "default") {
      continue;
    }
    const viaIndex = parts.indexOf("via");
    if (viaIndex !== -1 && parts[viaIndex + 1]) {
      return `http://${parts[viaIndex + 1]}:${port}`;
    }
  }
  throw new Error(`no default route in "ip route show default" output: ${JSON.stringify(output)}`);
}

/**
 * T-0322: compares a live ComfyUI `/system_stats` response against the regime a human deliberately
 * declared (`tools/board/ops/comfyui-regime.json`), and fails on ANY mismatch -- not only when
 * `--deterministic` is absent.
 *
 * The original card acceptance criterion ("fail if argv lacks --deterministic") assumed forcing
 * that flag was a straightforward win. T-0272/T-0317 rounds 10-12 tried it against at least one
 * real graph (dual-IPAdapter + ControlNet profile render) and found no coherence benefit:
 * `--deterministic` and/or `CUBLAS_WORKSPACE_CONFIG` scored 0/6 and 0/8 fresh seeds, but baseline
 * scored 0/8 on its own fresh reroll too -- against this graph's roughly 1-in-40 baseline
 * coherence rate, samples that small landing on zero are indistinguishable from chance.
 * "Determinism flags broke coherence" is therefore not an established finding (T-0346): the flags
 * were not shown to help, and were not shown to hurt. Baseline is kept because it costs nothing and
 * is the only regime that has ever produced a coherent frame at all, not because the flags were
 * proven harmful. Hardcoding "--deterministic must be present" would therefore make this check
 * actively wrong whenever baseline is the deliberately-chosen live regime -- so the check instead
 * treats the *declared* regime (whichever one a human most recently decided on, recorded with its
 * own reasoning) as the source of truth, and only fails when the live server has silently drifted
 * away from it, in either direction.
 *
 * `CUBLAS_WORKSPACE_CONFIG` cannot be checked here at all -- it is a launch-time environment
 * variable, not a CLI arg, and does not appear anywhere in `/system_stats`'s `argv`. See
 * docs/comfyui-setup.md#determinism for how that gap is handled operationally.
 */
export function evaluateRegime(systemStats, expectedRegime) {
  const argv = systemStats?.system?.argv;
  if (!Array.isArray(argv)) {
    return {
      ok: false,
      summary: "system_stats response has no system.argv array -- cannot determine the live regime",
      details: [`received: ${JSON.stringify(systemStats)}`]
    };
  }

  const actualDeterministic = argv.includes("--deterministic");
  const expectedDeterministic = Boolean(expectedRegime.deterministic);

  const decisionLine = `expected regime decided by ${expectedRegime.decidedBy ?? "unknown"} on ${
    expectedRegime.decidedDate ?? "unknown"
  }: ${expectedRegime.reason ?? "no reason recorded"}`;

  if (actualDeterministic === expectedDeterministic) {
    return {
      ok: true,
      summary: `live regime matches the declared expectation (deterministic=${expectedDeterministic})`,
      details: [`argv: ${JSON.stringify(argv)}`, decisionLine]
    };
  }

  return {
    ok: false,
    summary: `live regime does NOT match the declared expectation -- expected deterministic=${expectedDeterministic}, actual=${actualDeterministic}`,
    details: [`argv: ${JSON.stringify(argv)}`, decisionLine]
  };
}
