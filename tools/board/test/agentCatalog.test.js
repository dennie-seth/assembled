import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAssignableAgents } from "../src/lib/agentCatalog.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-agentcatalog-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeAgentFiles(names) {
  for (const name of names) {
    await fs.writeFile(path.join(tmpDir, `${name}.md`), "---\nname: x\n---\nbody", "utf8");
  }
}

describe("listAssignableAgents", () => {
  it("lists agent names from .md files sorted alphabetically", async () => {
    await writeAgentFiles(["server", "infra", "assets"]);
    expect(await listAssignableAgents(tmpDir)).toEqual(["assets", "infra", "server"]);
  });

  it("excludes the reviewer agent, which is not a valid task-assignable agent", async () => {
    await writeAgentFiles(["infra", "reviewer"]);
    expect(await listAssignableAgents(tmpDir)).toEqual(["infra"]);
  });

  it("includes planner as an assignable agent (runnable implementer-style, unlike reviewer)", async () => {
    await writeAgentFiles(["infra", "reviewer", "planner"]);
    expect(await listAssignableAgents(tmpDir)).toEqual(["infra", "planner"]);
  });

  it("excludes any file whose name is not a recognized assignable agent", async () => {
    await writeAgentFiles(["infra", "designer"]);
    expect(await listAssignableAgents(tmpDir)).toEqual(["infra"]);
  });

  it("ignores non-.md files", async () => {
    await writeAgentFiles(["infra"]);
    await fs.writeFile(path.join(tmpDir, "README.txt"), "not an agent", "utf8");
    expect(await listAssignableAgents(tmpDir)).toEqual(["infra"]);
  });

  it("returns an empty array when the agents directory does not exist", async () => {
    expect(await listAssignableAgents(path.join(tmpDir, "missing"))).toEqual([]);
  });
});
