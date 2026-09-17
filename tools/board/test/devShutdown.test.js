import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";

/**
 * T-0290: a routine `systemctl --user restart assembled-board` was hanging ~90s (systemd's
 * `final-sigterm` timeout) and then SIGKILLing survivors, because the real `npm run dev` process
 * tree is a chain of `sh -c '<cmd>'` wrapper shells that fork-and-wait rather than replacing
 * themselves with the command they run. A `sh -c` layer that doesn't `exec` stays alive as a
 * distinct, separate process alongside its child -- and it's exactly that class of process the
 * production journal caught still sitting in the cgroup when the SIGKILL sweep hit ("three bare
 * bash processes ignored it entirely").
 *
 * This is verified structurally rather than by timing a SIGTERM round-trip: a plain
 * process-group-wide (or single-PID) SIGTERM in this sandbox already tears the whole tree down
 * in a few hundred ms regardless of the wrapper shells, because dash/bash both die promptly on
 * SIGTERM by default here -- so a timing assertion could pass even with the bug still present
 * and wouldn't reproduce the real host's hang (different `/bin/sh`, real systemd cgroup/KillMode
 * semantics). What's reliably true everywhere is the *shape* of the tree: an un-exec'd `sh -c`
 * wrapper is a permanent extra PID sitting between npm/concurrently and the real work process.
 * `exec`-ing every shell layer collapses each wrapper into the program it runs (same PID, new
 * command), so after boot there is no `sh`/`bash`/`dash` PID left anywhere in the tree -- which
 * is exactly what this test asserts.
 *
 * This has to spawn the real `npm run dev` (the process-tree shape is a property of the actual
 * shell/npm/concurrently chain, nothing fakeable in-process) from the real `boardDir`, but the
 * board server it boots must never see this repo's own `tasks/` (T-0302): `BOARD_TASKS_DIR`
 * points it at a throwaway, empty temp directory instead. With zero cards to find,
 * `orphanReaper.reapOnStartup()` -- which the server runs synchronously before it starts
 * listening -- has nothing to reap and never calls git at all. Before this fix it ran against
 * this repo's real `tasks/*.md` (its `repoRoot`/`tasksDir` default straight to the checkout when
 * unset), so if any real card happened to be stuck at in-progress/validation with no live process
 * behind it, this 4-second spawn window silently committed a "Recovered" note and staged the file
 * -- the actual source of the stray `tasks/*.md` pollution T-0302 was filed to fix.
 */

const boardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL_COMMS = new Set(["sh", "bash", "dash"]);

async function readComm(pid) {
  try {
    return (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readChildren(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return raw
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

async function collectDescendants(pid, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return [];
  const nodes = [];
  for (const kid of await readChildren(pid)) {
    const comm = await readComm(kid);
    if (comm === null) continue; // already reaped between listing and reading
    nodes.push({ pid: kid, comm });
    nodes.push(...(await collectDescendants(kid, depth + 1, maxDepth)));
  }
  return nodes;
}

let child;
let tasksDir;

afterEach(async () => {
  if (child) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  child = undefined;
  await rmTemp(tasksDir);
  tasksDir = undefined;
});

describe.skipIf(process.platform !== "linux")("npm run dev process tree", () => {
  it(
    "leaves no un-exec'd sh/bash/dash wrapper between npm and the server/client processes",
    async () => {
      const port = 20000 + Math.floor(Math.random() * 20000);
      tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-devshutdown-tasks-"));
      child = spawn("npm", ["run", "dev"], {
        cwd: boardDir,
        env: { ...process.env, BOARD_PORT: String(port), BOARD_TASKS_DIR: tasksDir },
        detached: true,
        stdio: "ignore"
      });

      // Give the tree time to fully fork/exec through concurrently -> node --watch / vite.
      await new Promise((resolve) => setTimeout(resolve, 4000));

      const descendants = await collectDescendants(child.pid);
      const shellWrappers = descendants.filter((d) => SHELL_COMMS.has(d.comm));

      expect(shellWrappers).toEqual([]);
    },
    15000
  );
});
