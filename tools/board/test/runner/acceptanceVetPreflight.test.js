import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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

describe("checkAcceptanceAuthoringPreflight -- only ## Acceptance itself is graded", () => {
  it("ignores a hardcoded count living in a Context/background section, not ## Acceptance", () => {
    const body =
      "## Context\n\nThe gate currently reports 14 failures before this card's change.\n\n" +
      "## Acceptance\n\n- [ ] Fix the underlying bug.\n";
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
//
// This was originally written as `git merge-base HEAD origin/develop` + `git diff <base> HEAD`, and
// that form CANNOT work in CI: `.github/workflows/ci-board.yml` uses `actions/checkout@v4` with no
// `fetch-depth`, which defaults to a shallow depth-1 checkout. A depth-1 checkout has no
// `origin/develop`, no local `develop`, and no reachable parent commit -- so EVERY base-relative
// diff form fails there with `fatal: Not a valid object name origin/develop`, not just this one.
// That is the same class as the rule this very card enforces (a criterion that depends on a ref the
// running environment does not have; see .claude/rules/planner.md's fourth authoring rule).
//
// So the assertion is expressed as the invariant it was always standing in for, checkable from the
// working tree alone with no git and no refs: the run-time orchestrator does not reference the
// author-time module. A base-diff could only ever say "this one commit range touched nothing"; this
// says "the run-time path does not reach the author-time reader", which stays true and meaningful
// after merge, when the original form would have become vacuous.
describe("runOrchestrator.js is untouched by this card", () => {
  const ORCHESTRATOR = new URL("../../src/runner/runOrchestrator.js", import.meta.url);
  const AUTHOR_TIME_SYMBOLS = ["acceptanceVetPreflight", "checkAcceptanceAuthoringPreflight"];

  it("does not reference the author-time preflight module at all", async () => {
    const source = await readFile(ORCHESTRATOR, "utf8");
    const found = AUTHOR_TIME_SYMBOLS.filter((symbol) => source.includes(symbol));
    expect(found).toEqual([]);
  });

  it("still wires the RUN-TIME preflights it owned before this card", async () => {
    // The guard above would also pass if someone deleted the orchestrator's preflight sequence
    // wholesale, so pin that the run-time readers are still there -- that is the half of "run-time
    // behaviour is unchanged" a reference-absence check cannot see on its own.
    const source = await readFile(ORCHESTRATOR, "utf8");
    expect(source).toContain("impossibleAcceptancePreflight");
    expect(source).toContain("capabilityPreflight");
  });
});

// T-0425 FIX ROUND -- Chat's review of PR #429 (2026-10-02), probe429.mjs's own cases, pinned as
// regressions. All four must fail on d9c36eb2 (Round 1's head) and pass after this round's fix.
describe("FIX ROUND -- probe429.mjs cases", () => {
  it("negated_edit: a diff-empty criterion and a 'Do not edit' criterion on the same path are COMPATIBLE, not conflicting", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] Keep `tools/asset-gate/src/` unchanged.\n" +
      "- [ ] Do not edit `tools/asset-gate/src/character.py`.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  it("negated_count: 'Do not assume 14 failures; compare with the card base branch' is the corrective guidance itself, not a hardcoded claim", () => {
    const body = "## Acceptance\n\n- [ ] Do not assume 14 failures; compare with the card base branch.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  it("wrapped_conflict: the T-0424 criterion-4 shape still flags when the SAME two criteria are written with line-wrapped continuations", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff develop...HEAD --\n" +
      "      tools/asset-gate/src/` is empty.\n" +
      "- [ ] The fix edits\n" +
      "      `tools/asset-gate/src/foo.py`\n" +
      "      to add the new check.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /diff/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
    expect(flagged.reasons.join(" ")).toMatch(/Class B/);
  });

  it("unwrapped_conflict (control): the identical conflict written on single lines still flags -- the false-positive fix must not cost this", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff develop...HEAD -- tools/asset-gate/src/` is empty.\n" +
      "- [ ] The fix edits `tools/asset-gate/src/foo.py` to add the new check.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /diff/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
    expect(flagged.reasons.join(" ")).toMatch(/Class B/);
  });

  it("wrapped/unwrapped equivalence: both bodies above produce the SAME flags", () => {
    const wrapped =
      "## Acceptance\n\n" +
      "- [ ] `git diff develop...HEAD --\n" +
      "      tools/asset-gate/src/` is empty.\n" +
      "- [ ] The fix edits\n" +
      "      `tools/asset-gate/src/foo.py`\n" +
      "      to add the new check.\n";
    const unwrapped =
      "## Acceptance\n\n" +
      "- [ ] `git diff develop...HEAD -- tools/asset-gate/src/` is empty.\n" +
      "- [ ] The fix edits `tools/asset-gate/src/foo.py` to add the new check.\n";
    const ctx = { agentName: "infra", taskStoreKind: "db" };
    const wrappedResult = checkAcceptanceAuthoringPreflight(task(wrapped), ctx);
    const unwrappedResult = checkAcceptanceAuthoringPreflight(task(unwrapped), ctx);
    expect(wrappedResult.flags).toEqual(unwrappedResult.flags);
  });

  it("wrapped/unwrapped equivalence for Class C: a hardcoded count written on a continuation line is caught the same as on one line", () => {
    const wrapped = "## Acceptance\n\n- [ ] The gate reports 14\n      failures before this card's change.\n";
    const unwrapped = "## Acceptance\n\n- [ ] The gate reports 14 failures before this card's change.\n";
    const ctx = { agentName: "infra", taskStoreKind: "db" };
    const wrappedResult = checkAcceptanceAuthoringPreflight(task(wrapped), ctx);
    const unwrappedResult = checkAcceptanceAuthoringPreflight(task(unwrapped), ctx);
    expect(wrappedResult.flags).toHaveLength(1);
    expect(unwrappedResult.flags).toHaveLength(1);
    expect(wrappedResult.flags[0].reasons).toEqual(unwrappedResult.flags[0].reasons);
  });
});

describe("FIX ROUND -- negated/prohibited edit mentions never produce a Class B conflict", () => {
  it("'Keep X unchanged' + 'never edit X' are compatible", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `tools/asset-gate/src/` stays untouched.\n" +
      "- [ ] Never edit `tools/asset-gate/src/character.py` again.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  // Edge case: negation scoped to a DIFFERENT clause is still a genuine edit requirement -- a
  // blanket "criterion contains a negation word, skip it" rule would wrongly silence this.
  it("edge case: a negation in one clause does not shield a genuine edit requirement in a different clause of the SAME criterion", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff -- tools/asset-gate/src/` is empty.\n" +
      "- [ ] Do not weaken the gate; edit `tools/asset-gate/src/foo.py` to re-key the exemption.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /diff/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
    expect(flagged.reasons.join(" ")).toMatch(/Class B/);
  });

  // Edge case: a SINGLE criterion that is BOTH a prohibition and a permission (T-0424's own
  // rescoped criterion 4) -- chosen verdict: NOT flagged. It is one self-describing criterion
  // naming its own carve-out ("diff empty except for this one named edit"), not two independent
  // criteria whose literal conjunction is unsatisfiable -- the existing i!==j self-comparison skip
  // (detectDiffEmptyOverConstraint never compares a criterion to itself) already gives this answer
  // without any negation-specific carve-out, so no blanket "contains a negation, skip it" rule was
  // needed (and adding one would risk silencing a genuine two-criterion conflict phrased with
  // "only"/"permitted" elsewhere).
  it("edge case: a single criterion that is both prohibition and permission is not flagged", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff develop...HEAD -- tools/asset-gate/src/` is empty -- the ONLY permitted edit is re-keying `tools/asset-gate/src/asset_gate/character_motion_class_baseline.txt`'s existing exemption line to its new path.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });
});

describe("FIX ROUND -- negated count mentions never produce a Class C flag", () => {
  it("'Do not assume N failures' passes clean", () => {
    const body = "## Acceptance\n\n- [ ] Do not assume 14 failures; verify against the card's own base branch instead.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  it("control: an unnegated hardcoded count in the same shape still flags (false-positive fix must not cost this)", () => {
    const body = "## Acceptance\n\n- [ ] The suite reports 14 failures.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].reasons.join(" ")).toMatch(/Class C/);
  });

  // Edge case: a count written in words or with separators -- stated explicitly rather than left
  // accidental: Class C's patterns are digit-only (\d+) by design, matching the "deliberately
  // narrow per detector" philosophy this module already documents for Class A. Word-form
  // ("fourteen failures") and separator-formatted ("1,400 tests") counts are NOT covered by this
  // fix round -- pinned here as documented, known gaps rather than a silent accident.
  it("edge case: a word-form count ('fourteen failures') is NOT covered by Class C (documented gap)", () => {
    const body = "## Acceptance\n\n- [ ] The suite reports fourteen failures.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  it("edge case: a separator-formatted count ('1,400 tests') is NOT covered by Class C (documented gap)", () => {
    const body = "## Acceptance\n\n- [ ] The suite now runs 1,400 tests.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });
});

describe("FIX ROUND -- quoted-example mentions do not flag", () => {
  it("a criterion that quotes an illustrative 'edit <path>' phrase purely as an example does not produce a Class B conflict", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff -- tools/asset-gate/src/` is empty.\n" +
      '- [ ] This check\'s own regression test quotes "edit `tools/asset-gate/src/foo.py`" purely as an example of a conflicting criterion; this bullet does not itself require that edit.\n';
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  it("a criterion that quotes an illustrative hardcoded-count phrase purely as an example does not produce a Class C flag", () => {
    const body =
      "## Acceptance\n\n" +
      '- [ ] This check\'s own regression test quotes "the suite reports 14 failures" purely as an example of what Class C should flag; this bullet does not itself assert that count.\n';
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toEqual([]);
  });

  it("control: the same quoted phrase, pulled outside the quotes as a live assertion, still flags Class C", () => {
    const body = "## Acceptance\n\n- [ ] The suite reports 14 failures, not inside any quote marks.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    expect(result.flags).toHaveLength(1);
  });
});

describe("FIX ROUND -- continuation-line edge cases beyond the probe's own fixtures", () => {
  it("a continuation line that is itself a nested, non-checkbox bullet is not mistaken for the next criterion", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff -- tools/asset-gate/src/` is empty.\n" +
      "- [ ] The fix edits\n" +
      "      - note: this nested line is not a checkbox\n" +
      "      `tools/asset-gate/src/foo.py` to add the new check.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /diff/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
    expect(flagged.reasons.join(" ")).toMatch(/Class B/);
  });

  it("a path named only inside a fenced code block spanning continuation lines is still detected", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] Run:\n" +
      "      ```\n" +
      "      git diff -- tools/asset-gate/src/\n" +
      "      ```\n" +
      "      and confirm it is empty.\n" +
      "- [ ] Edit `tools/asset-gate/src/foo.py` to add the new check.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /diff/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
    expect(flagged.reasons.join(" ")).toMatch(/Class B/);
  });

  it("a blank continuation line mid-criterion does not terminate reconstruction early", () => {
    const body =
      "## Acceptance\n\n" +
      "- [ ] `git diff -- tools/asset-gate/src/` is empty.\n" +
      "- [ ] The fix edits\n" +
      "\n" +
      "      `tools/asset-gate/src/foo.py` to add the new check.\n";
    const result = checkAcceptanceAuthoringPreflight(task(body), { agentName: "infra", taskStoreKind: "db" });
    const flagged = result.flags.find((f) => /diff/.test(f.text ?? ""));
    expect(flagged).toBeTruthy();
  });
});
