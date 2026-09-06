// Reads the result `globalSetup.js` recorded (a real launch probe, not just a file-existence
// check -- see that file's comment for why the distinction matters). Import this from a spec's
// top-level `test.skip(...)` call so an unlaunchable browser skips the whole describe block
// instead of every test failing individually.
export function chromiumLaunchable() {
  return process.env.PLAYWRIGHT_CHROMIUM_LAUNCHABLE === "1";
}

export function chromiumLaunchSkipReason() {
  const detail = process.env.PLAYWRIGHT_CHROMIUM_LAUNCH_ERROR;
  return (
    "Chromium could not be launched in this environment" +
    (detail ? ` (${detail})` : " (binary missing or not launchable)") +
    ". Run `npx playwright install chromium` (and, on Linux, `npx playwright install-deps " +
    "chromium` if that fails with a missing shared library) -- see docs/browser-tests.md. " +
    "Skipping real-layout drag auto-scroll checks rather than failing the whole suite."
  );
}
