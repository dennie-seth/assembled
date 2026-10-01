import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkAcceptanceAuthoringPreflight } from "../../src/runner/acceptanceVetPreflight.js";
import { checkImpossibleAcceptancePreflight } from "../../src/runner/impossibleAcceptancePreflight.js";

const execFileAsync = promisify(execFile);

/**
 * T-0425: the gap T-0424's own retro named -- every structural-unsatisfiability / over-constraint
 * check this repo has (T-0409's registry, the diff-empty-on-a-touched-tree shape, hardcoded
 * stateful counts) only ever ran at run-time (impossibleAcceptancePreflight.js, inside a launched
 * attempt) or reviewer-time. `vetAndReady.js`'s nightly author-time pass saw none of it. This
 * module gives the nightly pass the same read, reusing T-0409's registry rather than re-deriving
 * it (see the "no duplication" describe block below).
 */

function task(body, overrides = {}) {
  return { id: "T-0900", agent: "infra", body, ...overrides };
}

const INFRA_MD = `---
name: infra
description: Implements board tooling.
tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(npm:*), Bash(npx vitest:*), Bash(git:*)
model: sonnet
---

# infra
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

function runtimeOpts() {
  return { agentsDir: "/agents", readFileFn: fixtureReader({ "/agents/infra.md": INFRA_MD }), taskStoreKind: "db" };
}

describe("checkAcceptanceAuthoringPreflight -- no parseable Acceptance section", () => {
  it("reports its own finding rather than throwing, for a card with no ## Acceptance heading", () => {
    const result = checkAcceptanceAuthoringPreflight(task("## Context\nnothing here\n"));
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].text).toBeNull();
    expect(result.flags[0].reasons[0]).toMatch(/no parseable/i);
  });

  it("reports the same finding for a missing body entirely", () => {
    expect(() => checkAcceptanceAuthoringPreflight({ id: "T-0900" })).not.toThrow();
    const result = checkAcceptanceAuthoringPreflight({ id: "T-0900" });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].text).toBeNull();
  });
});

describe("checkAcceptanceAuthoringPreflight -- Class A, reused from structuralUnsatisfiability.js", () => {
  it("flags a .claude/** edit criterion the same way the run-time preflight does", () => {
    const body = "## Acceptance\n\n- [ ] `.claude/agents/infra.md` is edited with the new grant.\n";
    const vetTime = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const runTime = checkImpossibleAcceptancePreflight(task(body), "infra", runtimeOpts());

    expect(vetTime.flags).toHaveLength(1);
    expect(runTime.warnings.length).toBeGreaterThan(0);
    // Both read structuralUnsatisfiability.js's single registry -- same classId/reason/owner, so
    // the two call sites can never classify the same criterion differently (the whole point of
    // T-0409's shared registry).
    expect(vetTime.flags[0].reasons.join(" ")).toMatch(/sensitive-file protection/i);
    expect(runTime.warnings[0]).toMatch(/sensitive-file protection/i);
    expect(vetTime.flags[0].reasons.join(" ")).toMatch(/owner: human/i);
  });

  it("does not flag an ordinary criterion with no structural-unsatisfiability shape", () => {
    const body = "## Acceptance\n\n- [ ] The new endpoint returns a 404 for an unknown id.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });
});

describe("checkAcceptanceAuthoringPreflight -- Class B, diff-empty on a tree this card also edits", () => {
  it("flags T-0424 criterion 4's own shape: a diff-empty assertion on a directory another criterion requires editing inside", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff develop...HEAD -- tools/asset-gate/src/` is empty.\n" +
      "- [ ] The fix edits `tools/asset-gate/src/asset_gate/character_motion_class_baseline.txt` to re-key the archived v1 sidecars' existing exemption lines to their new path.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /diff/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
    expect(flagged.reasons.join(" ")).toMatch(/Class B/);
    expect(flagged.reasons.join(" ")).toMatch(/tools\/asset-gate\/src/);
    expect(flagged.reasons.join(" ")).toMatch(/T-0424/);
  });

  it("does NOT flag a diff-empty assertion on a tree the card truly does not touch", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff -- tools/completely-unrelated/src/` is empty, since this card never touches that directory.\n" +
      "- [ ] Edit `tools/asset-gate/src/foo.py` to fix the unrelated bug.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  it("normalises a relative (./) path against a bare one before comparing", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `./tools/asset-gate/src` is unchanged.\n" +
      "- [ ] Update `tools/asset-gate/src/foo.py` to add the new check.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /unchanged/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
  });

  it("does not flag the diff-empty criterion against itself -- only a DIFFERENT criterion's edit requirement counts", () => {
    // This is T-0425's own acceptance bullet describing the Class B fixture in prose -- it mentions
    // both "unchanged" and "editing a file there" inside ONE bullet, which must not be mistaken for
    // an actual conflicting pair of criteria for THIS card.
    const body =
      "## Acceptance\n\n" +
      "- [ ] Class B: the \"diff empty on a tree this card also edits\" shape is detected, with a regression using T-0424's own criterion 4 text as the fixture (asserting `tools/asset-gate/src/` unchanged while the card's scope requires editing a file there).\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });
});

describe("checkAcceptanceAuthoringPreflight -- Class C, hardcoded count/before-state claims", () => {
  it("flags T-0424's own '14 before, 2 after' shape", () => {
    const body =
      "## Acceptance\n\n- [ ] Before/after `[FAIL]` counts are recorded: 14 before, 2 after. If the before-count is not 14, stop and report.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].reasons.join(" ")).toMatch(/Class C/);
    expect(result.flags[0].reasons.join(" ")).toMatch(/base branch/i);
  });

  it("flags a hardcoded failure count", () => {
    const body = "## Acceptance\n\n- [ ] The gate reports 14 failures before this card's change.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toHaveLength(1);
  });

  it("does NOT flag a count that is genuinely the right criterion (a fixed config value, not a before/after measurement)", () => {
    const body = "## Acceptance\n\n- [ ] The per-run cap stays at 4, unchanged by this card.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });
});

describe("checkAcceptanceAuthoringPreflight -- negated/quoted mentions must not flag", () => {
  it("does not flag this very card's own Edge-cases bullet quoting a 'Do not' line as an example", () => {
    // Pinned from T-0425's own body: the edge-case bullet quotes "nothing depends on a PR body"
    // purely as an example of a negated mention, and the real "Do not" line lives under a
    // different heading entirely (out of parseAcceptanceCriteria's scope).
    const body =
      "## Acceptance\n\n" +
      "- [ ] **Edge cases:**\n" +
      "- [ ] A criterion that quotes a forbidden pattern to forbid it -- e.g. this very card's text, or a \"Do not\" line saying \"nothing depends on a PR body\". Negated and quoted mentions must not flag.\n\n" +
      "## Do not\n\n" +
      "- Nothing in acceptance depends on the pushed remote, a PR body, or CI.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });
});

describe("checkAcceptanceAuthoringPreflight -- several flags on one criterion", () => {
  it("reports one entry per criterion carrying all its reasons, never duplicated per pattern", () => {
    const body =
      "## Acceptance\n\n- [ ] `.claude/agents/infra.md` is edited, and after that the suite reports 14 passing.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].reasons.length).toBe(2);
    expect(result.flags[0].reasons.join(" ")).toMatch(/Class A/);
    expect(result.flags[0].reasons.join(" ")).toMatch(/Class C/);
  });
});

describe("checkAcceptanceAuthoringPreflight -- never a gate", () => {
  it("returns only warn-shaped data (flags), never an ok/pass-fail field", () => {
    const body = "## Acceptance\n\n- [ ] `.claude/agents/infra.md` is edited.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result).not.toHaveProperty("ok");
    expect(result).not.toHaveProperty("blocked");
  });
});

// Acceptance: "No pattern is duplicated. git grep for any Class-A regex or marker string finds it
// in exactly one module." Each identifier below is a Class-A pattern's own DEFINITION -- grepping
// for the `const NAME =` definition line (not mere reuse via import) proves no second,
// independently-drifting copy exists anywhere else under tools/board/src.
describe("Class A patterns are defined exactly once -- no duplication", () => {
  const DEFINING_FILE = "tools/board/src/runner/structuralUnsatisfiability.js";
  const DEFINITION_NAMES = [
    "CLAUDE_PATH_RE",
    "EDIT_CUE_RE",
    "CARD_BODY_RE",
    "ORCHESTRATOR_ONLY_ACTION_PATTERNS",
    "STRUCTURAL_UNSATISFIABILITY_CLASSES"
  ];

  it.each(DEFINITION_NAMES)("%s is only ever DEFINED in structuralUnsatisfiability.js", async (name) => {
    const { stdout: repoRoot } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    const root = repoRoot.trim();
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("git", ["grep", "-l", `const ${name} =`, "--", "tools/board/src"], {
        cwd: root
      }));
    } catch (err) {
      // git grep exits 1 when nothing matches -- that would itself be a failure here (the pattern
      // must be defined SOMEWHERE), so only swallow the "no matches" shape and let the assertion
      // below catch an empty result.
      if (err.code !== 1) throw err;
    }
    const files = stdout.split("\n").filter(Boolean);
    expect(files).toEqual([DEFINING_FILE]);
  });
});

// Acceptance: "No change to run-time behaviour. runOrchestrator.js's existing preflight sequence
// is untouched ... Assert the orchestrator diff is empty." This card adds a NEW author-time reader
// of the existing registry; it must not touch the run-time orchestrator at all.
describe("runOrchestrator.js is untouched by this card", () => {
  it("has an empty diff against the branch this card was cut from", async () => {
    const { stdout: mergeBase } = await execFileAsync("git", ["merge-base", "HEAD", "origin/develop"]);
    const { stdout: diff } = await execFileAsync("git", [
      "diff",
      mergeBase.trim(),
      "HEAD",
      "--",
      "tools/board/src/runner/runOrchestrator.js"
    ]);
    expect(diff.trim()).toBe("");
  });
});
