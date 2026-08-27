import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCapabilityPreflight } from "../../src/runner/capabilityPreflight.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");
const REAL_TASKS_DIR = path.join(REPO_ROOT, "tasks");

const INFRA_MD = `---
name: infra
description: Implements board tooling.
tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(npm:*), Bash(npx vitest:*), Bash(git:*)
model: sonnet
---

# infra
`;

const ASSETS_MD = `---
name: assets
description: Generates curated 2D art via ComfyUI.
tools: Read, Write, Edit, Bash(node tools/board/scripts/agentCurl.js:*), Grep, Glob, Bash(git:*)
model: sonnet
---

# assets
`;

function fixtureReader(files) {
  return (p) => {
    if (!(p in files)) {
      const err = new Error(`ENOENT: no such file, open '${p}'`);
      err.code = "ENOENT";
      throw err;
    }
    return files[p];
  };
}

function fixtureOpts(overrides = {}) {
  return {
    agentsDir: "/agents",
    readFileFn: fixtureReader({ "/agents/infra.md": INFRA_MD, "/agents/assets.md": ASSETS_MD }),
    listAgentNamesFn: () => ["infra", "assets"],
    ...overrides
  };
}

function task(body, overrides = {}) {
  return { id: "T-0900", body, ...overrides };
}

describe("checkCapabilityPreflight", () => {
  it("returns ok:true (nothing to check) when the card has no parseable Acceptance section -- that's acceptancePreflight.js's job", () => {
    const result = checkCapabilityPreflight(task("## Context\nno acceptance here\n"), "infra", fixtureOpts());
    expect(result.ok).toBe(true);
    expect(result.message).toBe("");
  });

  it("passes a fully satisfiable AC: a granted command and an installed checkpoint", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] Run `npx vitest run` and confirm all green",
      "- [ ] Generation uses checkpoint `sd_xl_base_1.0.safetensors`"
    ].join("\n");
    const result = checkCapabilityPreflight(task(body), "infra", fixtureOpts());
    expect(result.ok).toBe(true);
    expect(result.message).toBe("");
  });

  it("fails when the AC names a checkpoint/LoRA not in the installed capability inventory, naming the model in the message", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] Generation uses checkpoint `nonexistent_model_v3.safetensors` per the new workflow"
    ].join("\n");
    const result = checkCapabilityPreflight(task(body, { id: "T-0901" }), "assets", fixtureOpts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0901");
    expect(result.message).toContain("nonexistent_model_v3.safetensors");
    expect(result.message).toContain("capabilityInventory.js");
  });

  it("fails when a 'Run `cmd`' item requires a command the assigned agent has no Bash grant for, naming the missing grant and the agent's .claude/agents file", () => {
    const body = ["## Acceptance", "", "- [ ] Run `pytest tools/board/test` to verify parity"].join("\n");
    const result = checkCapabilityPreflight(task(body, { id: "T-0902" }), "infra", fixtureOpts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0902");
    expect(result.message).toContain("pytest tools/board/test");
    expect(result.message).toContain("infra");
    expect(result.message).toContain(".claude/agents/infra.md");
  });

  it("does not flag a bare mention of a CLI tool with no leading Run/Test cue -- describes what CI/config runs, not what the agent itself must invoke (T-0031/T-0138 precedent)", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] `.github/workflows/ci-board.yml` runs `npm ci`, `npm run lint`, and `npx eslint .`"
    ].join("\n");
    const result = checkCapabilityPreflight(task(body), "infra", fixtureOpts());
    expect(result.ok).toBe(true);
  });

  it("fails when the AC names a ComfyUI custom node not in the installed inventory, naming the node", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] The ComfyUI workflow's custom node `SolidMask` composes the cutout alpha"
    ].join("\n");
    const result = checkCapabilityPreflight(task(body, { id: "T-0903" }), "assets", fixtureOpts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0903");
    expect(result.message).toContain("SolidMask");
  });

  it("does not treat a bare capitalized backtick token as a ComfyUI node claim without ComfyUI/custom-node context (Godot Node false-positive guard, T-0063 precedent)", () => {
    const body = ["## Acceptance", "", "- [ ] `NoteClient` node exposes post/fetch/rate against a mock server"].join(
      "\n"
    );
    const result = checkCapabilityPreflight(task(body), "infra", fixtureOpts());
    expect(result.ok).toBe(true);
  });

  it("passes when the AC names a ComfyUI node that is in the installed inventory", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] The ComfyUI workflow's `CheckpointLoaderSimple` custom node loads the base checkpoint"
    ].join("\n");
    const result = checkCapabilityPreflight(task(body), "assets", fixtureOpts());
    expect(result.ok).toBe(true);
  });

  it("fails an AC item that requires opening a PR -- no implementer agent may ever do this (T-0222 precedent)", () => {
    const body = ["## Acceptance", "", "- [ ] Commit + open a PR. Do NOT merge."].join("\n");
    const result = checkCapabilityPreflight(task(body, { id: "T-0904" }), "assets", fixtureOpts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0904");
    expect(result.message).toContain("conduct.md");
  });

  it("fails an AC item that requires pushing the branch", () => {
    const body = ["## Acceptance", "", "- [ ] Push the branch once tests are green"].join("\n");
    const result = checkCapabilityPreflight(task(body), "infra", fixtureOpts());
    expect(result.ok).toBe(false);
  });

  it("fails when the AC names an unreachable service endpoint", () => {
    const body = ["## Acceptance", "", "- [ ] The AssetAgent reaches `http://10.0.0.9:9999/system_stats`"].join(
      "\n"
    );
    const result = checkCapabilityPreflight(task(body, { id: "T-0905" }), "assets", fixtureOpts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("T-0905");
    expect(result.message).toContain("10.0.0.9:9999");
  });

  it("passes when the AC names a reachable service endpoint", () => {
    const body = ["## Acceptance", "", "- [ ] The AssetAgent reaches `http://127.0.0.1:8188/system_stats`"].join(
      "\n"
    );
    const result = checkCapabilityPreflight(task(body), "assets", fixtureOpts());
    expect(result.ok).toBe(true);
  });

  it("deduplicates the identical failure when the same missing model is named twice in one AC item", () => {
    const body = [
      "## Acceptance",
      "",
      "- [ ] Both `nonexistent_model.safetensors` and `nonexistent_model.safetensors` must be present"
    ].join("\n");
    const result = checkCapabilityPreflight(task(body), "assets", fixtureOpts());
    expect(result.ok).toBe(false);
    // Two identical matches (same item text, same model name) collapse to one failure entry --
    // if dedup weren't working, the " | " failure-join separator would appear at least once.
    expect(result.message).not.toContain(" | ");
  });

  describe("no-false-positives: a sample of real, already-done cards must pass unchanged", () => {
    function realTask(id) {
      const raw = fs.readFileSync(path.join(REAL_TASKS_DIR, `${id}.md`), "utf8");
      const agentMatch = /^agent:\s*"?([\w-]+)"?/m.exec(raw);
      return { id, body: raw, agent: agentMatch ? agentMatch[1] : null };
    }

    const REAL_OPTS = { agentsDir: REAL_AGENTS_DIR };

    // Deliberately spans every implementer agent this feature has to coexist with.
    const DONE_SAMPLE = ["T-0020", "T-0031", "T-0040", "T-0043", "T-0060", "T-0061", "T-0070", "T-0105"];

    for (const id of DONE_SAMPLE) {
      it(`passes ${id} unchanged`, () => {
        const t = realTask(id);
        const result = checkCapabilityPreflight(t, t.agent, REAL_OPTS);
        expect(result.ok).toBe(true);
        expect(result.message).toBe("");
      });
    }
  });
});


// ---------------------------------------------------------------------------
// A model named as the card's OUTPUT is not a prerequisite (T-0237).
//
// The model check used to fire on every `*.safetensors` in every AC item, with no
// notion of direction. That hard-blocked T-0237 -- the card whose entire job is to
// TRAIN `player_identity_v1.safetensors` -- because the file it exists to produce
// was, correctly, not yet in INSTALLED_MODELS. The gate was demanding the output
// exist before allowing the work that creates it, which makes every model-producing
// card unrunnable (T-0072, the style LoRA, would have been blocked the same way).
//
// The command check next to it already had this guard (RUN_CUE_RE, added because
// "a bare mention ... produced false positives during this file's development").
// The model check simply never got the equivalent.
//
// The cue is proximity-scoped to the filename, not the whole item, and a
// prerequisite cue beside the same filename WINS -- see the fail-closed tests
// below. This narrows a false positive; it does not open a hole.
// ---------------------------------------------------------------------------

describe("checkCapabilityPreflight -- model named as an output, not a prerequisite", () => {
  it("passes T-0237's exact AC item: the deliverable LoRA declared COMMITTED", () => {
    const result = checkCapabilityPreflight(
      task(
        "## Acceptance\n" +
          "- [ ] **`assets/final/lora/player_identity_v1.safetensors` is COMMITTED** -- this is " +
          "the deliverable; a training run whose weights are not committed has not delivered\n"
      ),
      "assets",
      fixtureOpts()
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    ["is COMMITTED", "- [ ] `player_identity_v1.safetensors` is COMMITTED to the repo"],
    ["trained", "- [ ] A player-identity LoRA is trained to `player_identity_v1.safetensors`"],
    ["produced", "- [ ] `player_identity_v1.safetensors` is produced by the committed stack"],
    ["written to", "- [ ] Weights are written to `player_identity_v1.safetensors`"],
    ["generated", "- [ ] `player_identity_v1.safetensors` is generated by the training run"],
    ["output", "- [ ] Training output `player_identity_v1.safetensors` lands under assets/final"],
    ["saved", "- [ ] The LoRA is saved as `player_identity_v1.safetensors`"],
    ["deliverable", "- [ ] The deliverable is `player_identity_v1.safetensors`"]
  ])("treats %s as an output cue, so an uninstalled model does not block", (_cue, item) => {
    const result = checkCapabilityPreflight(task(`## Acceptance\n${item}\n`), "assets", fixtureOpts());
    expect(result.ok).toBe(true);
  });

  // --- fail-closed: a genuine prerequisite still hard-blocks ---

  it("still blocks a genuinely missing model named as a prerequisite", () => {
    const result = checkCapabilityPreflight(
      task("## Acceptance\n- [ ] Generation uses checkpoint `nonexistent_model_v3.safetensors`\n"),
      "assets",
      fixtureOpts()
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("nonexistent_model_v3.safetensors");
  });

  it.each([
    ["using", "- [ ] The sheet is generated using `missing_lora_v1.safetensors`"],
    ["with", "- [ ] Output is produced with `missing_lora_v1.safetensors` applied"],
    ["requires", "- [ ] Training requires `missing_lora_v1.safetensors` to be present"],
    ["loads", "- [ ] The workflow loads `missing_lora_v1.safetensors` before generating"],
    ["against", "- [ ] The sheet is generated against `missing_lora_v1.safetensors`"]
  ])(
    "a prerequisite cue (%s) beside the filename wins over any output cue in the same item",
    (_cue, item) => {
      const result = checkCapabilityPreflight(task(`## Acceptance\n${item}\n`), "assets", fixtureOpts());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("missing_lora_v1.safetensors");
    }
  );

  it("blocks a bare uninstalled model mention with no cue either way", () => {
    const result = checkCapabilityPreflight(
      task("## Acceptance\n- [ ] `mystery_model_v9.safetensors` at 1024x1024\n"),
      "assets",
      fixtureOpts()
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("mystery_model_v9.safetensors");
  });

  it("does not let an output cue in one AC item excuse a missing prerequisite in another", () => {
    const result = checkCapabilityPreflight(
      task(
        "## Acceptance\n" +
          "- [ ] `player_identity_v1.safetensors` is COMMITTED\n" +
          "- [ ] Generation uses `nonexistent_model_v3.safetensors`\n"
      ),
      "assets",
      fixtureOpts()
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("nonexistent_model_v3.safetensors");
    expect(result.message).not.toContain("player_identity_v1.safetensors");
  });

  it("still passes an installed model named as a prerequisite", () => {
    const result = checkCapabilityPreflight(
      task("## Acceptance\n- [ ] Generation uses checkpoint `sd_xl_base_1.0.safetensors`\n"),
      "assets",
      fixtureOpts()
    );

    expect(result.ok).toBe(true);
  });

  it("scopes the cue to the filename, not the whole item -- a far-away output word does not excuse it", () => {
    const result = checkCapabilityPreflight(
      task(
        "## Acceptance\n" +
          "- [ ] The pose sheet is generated, descended per 13 3.1, indexed to the locked 16-slot " +
          "palette, provenance written, cost recorded, and the run loads " +
          "`nonexistent_model_v3.safetensors` from the ComfyUI models directory\n"
      ),
      "assets",
      fixtureOpts()
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("nonexistent_model_v3.safetensors");
  });
});
