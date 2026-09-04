// Probes whether Chromium can actually launch in this environment -- not just whether the
// binary file exists. A fresh checkout can be missing the binary entirely (`npx playwright
// install` never run), but a sandboxed/minimal container can also have the binary downloaded
// and still fail to launch it because an OS-level shared library Chromium needs (e.g.
// `libnspr4.so`) isn't installed and there's no root/apt access in the session to add it --
// confirmed empirically while building this harness (T-0295): `playwright install chromium`
// succeeded, but every launch failed with
// "error while loading shared libraries: libnspr4.so: cannot open shared object file", and
// `playwright install-deps` itself needs `sudo`, which this environment does not grant. A
// file-existence check alone would have reported "installed" and then hard-failed both specs.
//
// Runs once, before any worker process starts, and records the result via `process.env` --
// `globalSetup` runs in the same process Playwright then forks workers from, so this env var is
// visible to every spec file without a shared temp file or extra IPC.
import { chromium } from "@playwright/test";

export default async function globalSetup() {
  try {
    const browser = await chromium.launch();
    await browser.close();
    process.env.PLAYWRIGHT_CHROMIUM_LAUNCHABLE = "1";
  } catch (err) {
    process.env.PLAYWRIGHT_CHROMIUM_LAUNCHABLE = "0";
    process.env.PLAYWRIGHT_CHROMIUM_LAUNCH_ERROR = String(err?.message ?? err).split("\n")[0];
  }
}
