#!/usr/bin/env node
/**
 * T-0322: fails loudly if the LIVE ComfyUI server's determinism regime has drifted away from
 * `tools/board/ops/comfyui-regime.json` -- the record of what a human most recently, deliberately
 * decided (and why). Deliberately does NOT hardcode "--deterministic must be present": T-0272/
 * T-0317 rounds 10-12 found no coherence benefit from forcing that flag (and/or
 * CUBLAS_WORKSPACE_CONFIG) on at least one real graph, but baseline scored zero on its own fresh
 * reroll too, against a roughly 1-in-40 baseline coherence rate for that graph -- "determinism
 * flags broke coherence" was never established (T-0346), the flags were merely never shown to
 * help either. Baseline is sometimes the correct, deliberate live state regardless -- this check
 * exists to catch an ACCIDENTAL drift in either direction (a bare relaunch reverting to baseline
 * when determinism was wanted, or someone leaving --deterministic on for a graph that needs
 * baseline), not to enforce one fixed opinion.
 *
 * Reads the regime file and diffs it against `GET {base}/system_stats`. See
 * docs/comfyui-setup.md#determinism for the operational writeup, including the
 * CUBLAS_WORKSPACE_CONFIG gap this check cannot cover (it's an env var, invisible to
 * /system_stats' argv).
 *
 * Usage: node tools/board/scripts/checkComfyUiRegime.js
 * Env:
 *   COMFYUI_BASE_URL     -- overrides base URL resolution entirely (also how tests point this at
 *                           a fake server)
 *   COMFYUI_PORT         -- port to use when deriving the base URL from the default route
 *   COMFYUI_REGIME_FILE  -- overrides the regime JSON path (default: ops/comfyui-regime.json)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { resolveComfyUiBaseUrl, evaluateRegime } from "../src/lib/comfyuiRegime.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_REGIME_FILE = path.join(REPO_ROOT, "tools/board/ops/comfyui-regime.json");
const FETCH_TIMEOUT_MS = 10000;

async function main() {
  const regimeFile = process.env.COMFYUI_REGIME_FILE || DEFAULT_REGIME_FILE;
  const expectedRegime = JSON.parse(await fs.readFile(regimeFile, "utf8"));

  const baseUrl = resolveComfyUiBaseUrl();

  let systemStats;
  try {
    const response = await fetch(`${baseUrl}/system_stats`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    systemStats = await response.json();
  } catch (err) {
    console.error(`FAIL: could not reach ComfyUI at ${baseUrl}/system_stats: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluateRegime(systemStats, expectedRegime);
  console.log(`${result.ok ? "PASS" : "FAIL"}: ${result.summary}`);
  for (const detail of result.details) {
    console.log(`  ${detail}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
