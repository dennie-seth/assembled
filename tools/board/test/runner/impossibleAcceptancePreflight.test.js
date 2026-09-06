import { describe, it, expect } from "vitest";
import { checkImpossibleAcceptancePreflight } from "../../src/runner/impossibleAcceptancePreflight.js";

const INFRA_MD = `---
name: infra
description: Implements board tooling.
tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(npm:*), Bash(npx vitest:*), Bash(git:*)
model: sonnet
---

# infra
`;

// A hypothetical agent that DOES carry a systemctl/journalctl grant -- proves the check is a real
// per-agent cross-check against .claude/agents/<agent>.md, not a hardcoded "systemctl is always
// unsatisfiable" rule (T-0300's own edge-case: impossible for one agent can be fine for another).
const OPS_MD = `---
name: ops
description: Hypothetical ops agent.
tools: Read, Bash(systemctl --user:*), Bash(journalctl --user:*)
model: sonnet
---

# ops
`;

const ASSETS_MD = `---
name: assets
description: Generates curated 2D art.
tools: Read, Write, Edit, Bash(node tools/board/scripts/agentCurl.js:*), Bash(node tools/board/scripts/referenceFetch.js:*), Grep, Glob, Bash(git:*)
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

function fixtureOpts() {
  return {
    agentsDir: "/agents",
    readFileFn: fixtureReader({
      "/agents/infra.md": INFRA_MD,
      "/agents/ops.md": OPS_MD,
      "/agents/assets.md": ASSETS_MD
    })
  };
}

function task(body, overrides = {}) {
  return { id: "T-0900", body, ...overrides };
}

describe("checkImpossibleAcceptancePreflight -- no Acceptance section", () => {
  it("returns no warnings (that's acceptancePreflight.js's job, not this one's)", () => {
    const result = checkImpossibleAcceptancePreflight(task("## Context\nnothing here\n"), "infra", fixtureOpts());
    expect(result.warnings).toEqual([]);
  });
});

describe("checkImpossibleAcceptancePreflight -- human-observation criteria (T-0288)", () => {
  it("flags a criterion demanding the agent's own observation, not an inference from code", () => {
    const result = checkImpossibleAcceptancePreflight(
      task(
        "## Acceptance\n" +
          "- [ ] Drag a tall card near the column edge in a running board and say what you observed -- do not infer it from the code\n"
      ),
      "infra",
      fixtureOpts()
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("say what you observed");
  });

  it("does not flag an ordinary use of 'confirm'/'verify' against a runnable check", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] Confirm `npx vitest run` reports all green\n"),
      "infra",
      fixtureOpts()
    );
    expect(result.warnings).toEqual([]);
  });

  it("does not flag the harness-backed browser criterion the T-0295 precedent recommends", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] Prove real scroll geometry changes with `npm run test:browser`\n"),
      "infra",
      fixtureOpts()
    );
    expect(result.warnings).toEqual([]);
  });
});

describe("checkImpossibleAcceptancePreflight -- ungranted operational tool (T-0290)", () => {
  it("flags `systemctl`/`journalctl` for an agent with no matching Bash grant", () => {
    const result = checkImpossibleAcceptancePreflight(
      task(
        "## Acceptance\n" +
          "- [ ] Run `systemctl --user restart assembled-board` and record the measured before/after stop " +
          "duration from `journalctl --user -u assembled-board`\n"
      ),
      "infra",
      fixtureOpts()
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("systemctl");
    expect(result.warnings.join(" ")).toContain("/agents/infra.md");
  });

  it("does NOT flag the same criterion for an agent that actually carries the grant (per-agent, not global)", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] Run `systemctl --user restart assembled-board` and confirm via `journalctl`\n"),
      "ops",
      fixtureOpts()
    );
    expect(result.warnings).toEqual([]);
  });
});

describe("checkImpossibleAcceptancePreflight -- PR/CI-green circularity (T-0222, T-0258, T-0288)", () => {
  it("flags the literal T-0222 phrasing (active voice, 'open a PR')", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] Commit + open a PR. Do **NOT** merge.\n"),
      "assets",
      fixtureOpts()
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not flag T-0222's other, legitimately satisfiable criteria from the same card", () => {
    const result = checkImpossibleAcceptancePreflight(
      task(
        "## Acceptance\n" +
          "- [x] Confirmed `assets/src/character/gen_entities_v2.js` exists and is a real, non-trivial committed generator\n" +
          "- [x] All 9 `assets/final/entity/*_v2.provenance.json` sidecars corrected\n" +
          "- [x] Full `tools/asset-gate` pytest suite green, ruff clean\n"
      ),
      "assets",
      fixtureOpts()
    );
    expect(result.warnings).toEqual([]);
  });

  it("flags the T-0258-style passive-voice phrasing ('a PR is opened with CI green')", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] A PR is opened with CI green before this card is considered done\n"),
      "infra",
      fixtureOpts()
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("checkImpossibleAcceptancePreflight -- approval circularity (T-0233)", () => {
  it("flags a named human approving as an agent-facing criterion", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] @DennieSeth approves the sheet\n"),
      "assets",
      fixtureOpts()
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not flag the planner.md-recommended rewording (parks, records no approval)", () => {
    const result = checkImpossibleAcceptancePreflight(
      task(
        "## Acceptance\n" +
          "- [ ] The card parks awaiting a human verdict, with no approval record written by the agent\n"
      ),
      "assets",
      fixtureOpts()
    );
    expect(result.warnings).toEqual([]);
  });
});

describe("checkImpossibleAcceptancePreflight -- external reference-source circularity (T-0273)", () => {
  it("flags a criterion requiring ALL of two-or-more named external sources to succeed", () => {
    const result = checkImpossibleAcceptancePreflight(
      task(
        "## Acceptance\n" +
          "- [ ] Attach reference images sourced from both Wikimedia and Openverse showing a full walking gait\n"
      ),
      "assets",
      fixtureOpts()
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("referenceSourcePolicy.js");
  });

  it("does not flag an 'at least one succeeds' phrasing across the same two sources", () => {
    const result = checkImpossibleAcceptancePreflight(
      task(
        "## Acceptance\n" +
          "- [ ] Attach at least one reference image from Wikimedia, Openverse, or the Met showing a walking gait\n"
      ),
      "assets",
      fixtureOpts()
    );
    expect(result.warnings).toEqual([]);
  });

  it("does not flag a criterion naming only one external source", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] Attach a reference image sourced from Wikimedia showing a walking gait\n"),
      "assets",
      fixtureOpts()
    );
    expect(result.warnings).toEqual([]);
  });
});

describe("checkImpossibleAcceptancePreflight -- never hard-blocks", () => {
  it("always returns a warnings array, never an ok:false/blocking contract", () => {
    const result = checkImpossibleAcceptancePreflight(
      task("## Acceptance\n- [ ] say what you observed\n- [ ] @DennieSeth approves the sheet\n"),
      "infra",
      fixtureOpts()
    );
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.ok).toBeUndefined();
    // Two independently-triggering items each contribute their own warning.
    expect(result.warnings.length).toBe(2);
  });
});
