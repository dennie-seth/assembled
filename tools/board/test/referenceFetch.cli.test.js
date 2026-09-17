import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "referenceFetch.js");

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("referenceFetch.js CLI -- restricted to reference/image sourcing, not a general browsing tool", () => {
  it("exposes only search and fetch -- an unknown subcommand is refused with usage, not treated as a raw request", async () => {
    const result = await run(["get", "https://example.com/anything"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/unknown command/);
  });

  it("refuses with usage when required arguments are missing", async () => {
    const result = await run(["search"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("refuses a search against a source id that is not on the in-code allowlist, before any network call", async () => {
    const result = await run(["search", "google-images", "lighthouse"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown reference source/);
  });

  it("refuses a fetch against a source id that is not on the in-code allowlist", async () => {
    const result = await run(["fetch", "google-images", "some-id"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown reference source/);
  });

  it("does not accept a raw URL as a fetch target -- only a sourceId + source-native assetId (no 'outbound link' shape is ever a valid argv)", async () => {
    // "fetch" takes (sourceId, assetId); handing it a URL as the sourceId is just an unknown
    // source id to this CLI, which is the point -- there is no argv shape that means "fetch this
    // arbitrary URL".
    const result = await run(["fetch", "https://attacker.example.com/payload.jpg", "some-id"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown reference source/);
  });
});
