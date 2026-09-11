import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { CHARACTER_GATE_CLI_ARGS } from "../src/lib/characterGateCommand.js";
import { resolveVerifyRoutes } from "../src/runner/verifyRouter.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci-asset-gate.yml");

/**
 * T-0357 acceptance: "One authoritative character validator is invoked by both
 * the CI asset-gate workflow and the board's reviewer route, and it is
 * demonstrably the same command in both." This is the mechanical proof --
 * both sides are built from the exact same CHARACTER_GATE_CLI_ARGS string
 * (asset_gate/src/lib/characterGateCommand.js), so they cannot silently drift
 * apart the way the pre-T-0357 character-motion-fidelity-sweep did (T-0340's
 * sweep existed, was unit-tested, and no CI job or reviewer route ever called
 * it -- Codex review 2026-09-11 finding 1).
 */
describe("ci-asset-gate.yml runs the same character-gate command the reviewer route does", () => {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, "utf8"));

  it("has a character-gate job", () => {
    expect(workflow.jobs["character-gate"]).toBeDefined();
  });

  it("the character-gate job invokes exactly CHARACTER_GATE_CLI_ARGS via python -m", () => {
    const job = workflow.jobs["character-gate"];
    const runSteps = job.steps.filter((s) => typeof s.run === "string").map((s) => s.run);
    expect(runSteps.some((s) => s.includes(`python -m ${CHARACTER_GATE_CLI_ARGS}`))).toBe(true);
  });

  it("no longer runs the narrower character-arm-c-sweep job -- character-gate supersedes it", () => {
    expect(workflow.jobs["character-arm-c-sweep"]).toBeUndefined();
  });

  it("the reviewer's character-gate-verify route invokes the identical subcommand+args, just through a venv python", () => {
    const routes = resolveVerifyRoutes(["tools/asset-gate/src/asset_gate/character.py"]);
    const route = routes.find((r) => r.id === "character-gate-verify");
    expect(route).toBeDefined();
    expect(route.command).toContain(`.venv/bin/python -m ${CHARACTER_GATE_CLI_ARGS}`);

    const job = workflow.jobs["character-gate"];
    const runSteps = job.steps.filter((s) => typeof s.run === "string").map((s) => s.run);
    expect(runSteps.some((s) => s.includes(`python -m ${CHARACTER_GATE_CLI_ARGS}`))).toBe(true);
  });

  it("runs inside tools/asset-gate via the shared defaults block, like every other job in this workflow", () => {
    expect(workflow.defaults.run["working-directory"]).toBe("tools/asset-gate");
  });
});
