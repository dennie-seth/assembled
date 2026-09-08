import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "checkComfyUiRegime.js");

let server;
let tmpDir;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function startFakeComfyUi(argv) {
  server = http.createServer((req, res) => {
    if (req.url === "/system_stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ system: { argv } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function writeRegimeFile(regime) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-comfyui-regime-"));
  const filePath = path.join(tmpDir, "regime.json");
  await fs.writeFile(filePath, JSON.stringify(regime), "utf8");
  return filePath;
}

async function run(env) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [SCRIPT], {
      env: { ...process.env, ...env }
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("checkComfyUiRegime.js CLI -- T-0322 durable, checkable determinism-regime drift detector", () => {
  it("exits 0 when the live server's argv matches the declared regime (baseline)", async () => {
    const baseUrl = await startFakeComfyUi(["main.py", "--listen", "0.0.0.0", "--port", "8188"]);
    const regimeFile = await writeRegimeFile({
      deterministic: false,
      decidedBy: "test",
      decidedDate: "2026-09-08",
      reason: "test fixture"
    });
    const result = await run({ COMFYUI_BASE_URL: baseUrl, COMFYUI_REGIME_FILE: regimeFile });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/PASS/);
  });

  it("exits non-zero and names the drift when the live server carries --deterministic but the declared regime expects baseline", async () => {
    const baseUrl = await startFakeComfyUi([
      "main.py",
      "--listen",
      "0.0.0.0",
      "--port",
      "8188",
      "--deterministic"
    ]);
    const regimeFile = await writeRegimeFile({
      deterministic: false,
      decidedBy: "test",
      decidedDate: "2026-09-08",
      reason: "test fixture"
    });
    const result = await run({ COMFYUI_BASE_URL: baseUrl, COMFYUI_REGIME_FILE: regimeFile });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/FAIL/);
    expect(result.stdout).toMatch(/does NOT match/);
  });

  it("exits non-zero and reports the reachability failure loudly instead of crashing silently when ComfyUI is unreachable", async () => {
    const regimeFile = await writeRegimeFile({
      deterministic: false,
      decidedBy: "test",
      decidedDate: "2026-09-08",
      reason: "test fixture"
    });
    const result = await run({
      COMFYUI_BASE_URL: "http://127.0.0.1:1",
      COMFYUI_REGIME_FILE: regimeFile
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/could not reach ComfyUI/);
  });
});
