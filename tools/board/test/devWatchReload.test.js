import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * T-0290 edge case: "Whatever is done must keep `node --watch`'s own reload working."
 * package.json's `dev:server` script now reads `exec node --watch src/server/index.js`
 * instead of a bare `node --watch ...` -- the same `exec`-through-`sh -c` pattern this
 * card applies throughout `npm run dev`'s tree. This confirms that prefixing the watched
 * command with `exec` (so the `sh -c` layer replaces itself instead of forking a child)
 * doesn't disturb node's own file-watch/reload cycle: the entry script must still re-run
 * on every change to a watched file, exactly as if `exec` had never been added.
 */

let child;
let tmpDir;

afterEach(async () => {
  if (child) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  child = undefined;
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function waitForLineCount(markerFile, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await fs
      .readFile(markerFile, "utf8")
      .then((raw) => raw.split("\n").filter(Boolean))
      .catch(() => []);
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} line(s) in ${markerFile}, saw ${lines.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(process.platform !== "linux")("node --watch reload through an exec'd sh -c layer", () => {
  it(
    "re-runs the entry script when a watched file changes, same as an un-exec'd invocation",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "t0290-watch-"));
      const markerFile = path.join(tmpDir, "marker.log");
      const watchedFile = path.join(tmpDir, "watched.js");
      await fs.writeFile(markerFile, "");
      await fs.writeFile(
        watchedFile,
        `require("node:fs").appendFileSync(process.env.MARKER_FILE, Date.now() + "\\n");\n`
      );

      // Mirrors package.json's `"dev:server": "exec node --watch src/server/index.js"`,
      // which npm ultimately runs as `sh -c 'exec node --watch src/server/index.js'`.
      child = spawn("sh", ["-c", `exec node --watch ${JSON.stringify(watchedFile)}`], {
        cwd: tmpDir,
        env: { ...process.env, MARKER_FILE: markerFile },
        detached: true,
        stdio: "ignore"
      });

      await waitForLineCount(markerFile, 1, 5000);

      // Touch the watched file to trigger node --watch's reload.
      await fs.appendFile(watchedFile, "// trigger reload\n");

      const lines = await waitForLineCount(markerFile, 2, 5000);
      expect(lines.length).toBeGreaterThanOrEqual(2);
    },
    15000
  );
});
