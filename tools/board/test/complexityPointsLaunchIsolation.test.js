import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// T-0368 (spec §2, §10 step 2): planning complexity (complexity_points, a human-only signal
// this card adds) and execution cost (T-C's machine cost estimate) are two separate axes.
// complexity_points must never influence what launches, what's admitted, what the auto-launch
// poller picks, or any cost accounting -- this scans the actual launch/admission/poller/cost
// source for the field name rather than trusting a code review to catch a future regression.
//
// `src/runner/**` is scanned wholesale (not an enumerated file list) so a later card in this set
// (T-C's cost estimator, T-D's launch-boundary reservation, etc.) that lands a new file there is
// covered automatically. `dependencyGuard.js`/`roundCap.js` are the two `lib/` modules that gate
// admission to in-progress outside of `runner/` itself, so they're checked explicitly alongside it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_DIR = path.join(ROOT, "src/runner");
const EXTRA_ADMISSION_FILES = ["src/lib/dependencyGuard.js", "src/lib/roundCap.js"];

function listJsFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
}

const FILES_TO_CHECK = [
  ...listJsFiles(RUNNER_DIR).map((abs) => path.relative(ROOT, abs)),
  ...EXTRA_ADMISSION_FILES
];

describe("complexity_points stays out of the launch/admission/auto-launch/cost path", () => {
  it("scanned at least the known launch-path modules -- a shrinking list would silently weaken this test", () => {
    expect(FILES_TO_CHECK).toEqual(expect.arrayContaining(["src/runner/cardLaunch.js", "src/runner/runOrchestrator.js", "src/runner/autoLaunchPoller.js"]));
  });

  it.each(FILES_TO_CHECK)("%s does not reference complexity_points", (relPath) => {
    const source = readFileSync(path.join(ROOT, relPath), "utf8");
    expect(source).not.toMatch(/complexity_points/);
  });
});
