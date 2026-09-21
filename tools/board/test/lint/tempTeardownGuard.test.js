import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
import { noBareTempTeardownRule } from "../../eslint.config.js";

/**
 * Proves the reintroduction guard for T-0404 (the ENOTEMPTY teardown race, #409) actually
 * catches the pattern it exists to catch, and doesn't false-positive on the swept form or on
 * single-file removals that were never part of the race. Lints inline fixture snippets with the
 * exact rule config from eslint.config.js -- the same object the real `test/**` override uses --
 * so this test and `npx eslint .` can never drift apart into two different definitions of "bare".
 */
const linter = new Linter();

function lint(code) {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: { "no-restricted-syntax": ["error", noBareTempTeardownRule] }
  });
}

describe("no-bare-temp-teardown reintroduction guard", () => {
  it("flags a bare fs.rm(dir, { recursive: true, force: true }) teardown", () => {
    const messages = lint(`
      import fs from "node:fs/promises";
      afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      });
    `);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/rmTemp/);
  });

  it("flags fs.rmSync with the same options", () => {
    const messages = lint(`
      import fs from "node:fs";
      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
    `);
    expect(messages).toHaveLength(1);
  });

  it("flags the bare call regardless of property order", () => {
    const messages = lint(`
      import fs from "node:fs/promises";
      afterEach(async () => {
        await fs.rm(tmpDir, { force: true, recursive: true });
      });
    `);
    expect(messages).toHaveLength(1);
  });

  it("does not flag rmTemp(dir)", () => {
    const messages = lint(`
      import { rmTemp } from "./helpers/rmTemp.js";
      afterEach(async () => {
        await rmTemp(tmpDir);
      });
    `);
    expect(messages).toHaveLength(0);
  });

  it("does not flag a single-file removal that never had the recursive+force shape", () => {
    const messages = lint(`
      import fs from "node:fs/promises";
      afterEach(async () => {
        await fs.rm(path.join(tmpDir, "file.md"));
      });
    `);
    expect(messages).toHaveLength(0);
  });

  it("does not flag an unrelated rm-shaped call with different options", () => {
    const messages = lint(`
      import fs from "node:fs/promises";
      afterEach(async () => {
        await fs.rm(tmpDir, { force: true });
      });
    `);
    expect(messages).toHaveLength(0);
  });

  it("flags a bare rm(dir, { recursive: true, force: true }) from a destructured import", () => {
    const messages = lint(`
      import { rm } from "node:fs/promises";
      afterAll(async () => {
        await rm(repoRoot, { recursive: true, force: true });
      });
    `);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/rmTemp/);
  });

  it("flags a bare rmSync(dir, { recursive: true, force: true }) from a destructured import", () => {
    const messages = lint(`
      import { rmSync } from "node:fs";
      afterAll(() => {
        rmSync(repoRoot, { recursive: true, force: true });
      });
    `);
    expect(messages).toHaveLength(1);
  });

  it("does not flag an unrelated bare rm(...) call with different options", () => {
    const messages = lint(`
      import { rm } from "node:fs/promises";
      afterAll(async () => {
        await rm(path.join(tmpDir, "file.md"));
      });
    `);
    expect(messages).toHaveLength(0);
  });
});
