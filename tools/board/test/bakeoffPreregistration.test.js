/**
 * T-0227 (HANDOFF §23-c) — the character-pipeline bake-off decision rule is
 * *pre-registered*: committed to git before any arm (§23-d Arm A, §23-e Arm B,
 * §23-f Arm C) generates a single image.
 *
 * A pre-registration that lives only in prose is one silent edit away from
 * being a post-hoc rationalisation. These tests are the tamper-evidence: they
 * pin every load-bearing clause of the rule — subject, output spec, judging
 * conditions, criteria *and their precedence*, the decision rule, the attempt
 * cap — to committed text, so that a later change to any of them shows up as a
 * failing test in the PR that makes it rather than as a paragraph nobody
 * re-read. `docs/decision-log.md`'s own header already states entries are
 * permanent and must not be amended after their PR merges; this enforces it for
 * the one entry where amendment would invalidate the experiment.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DECISION_LOG = path.join(REPO_ROOT, "docs", "decision-log.md");
const COST_TEMPLATE = path.join(
  REPO_ROOT,
  "docs",
  "decisions",
  "T-0227-bakeoff-cost-record-template.md"
);

/** The DL-21 entry's own text, from its `## DL-21` heading to the next `##` heading. */
function readEntry() {
  if (!fs.existsSync(DECISION_LOG)) return "";
  const text = fs.readFileSync(DECISION_LOG, "utf8");
  const start = text.indexOf("## DL-21");
  if (start === -1) return "";
  const nextHeading = text.indexOf("\n## ", start + 1);
  return nextHeading === -1 ? text.slice(start) : text.slice(start, nextHeading);
}

function readTemplate() {
  return fs.existsSync(COST_TEMPLATE) ? fs.readFileSync(COST_TEMPLATE, "utf8") : "";
}

describe("T-0227 bake-off pre-registration — the entry exists", () => {
  it("docs/decision-log.md carries a DL-21 entry naming T-0227", () => {
    const entry = readEntry();
    expect(entry, "no `## DL-21` section found in docs/decision-log.md").not.toBe("");
    expect(entry).toContain("T-0227");
  });

  it("the entry states it is pre-registered — committed before any arm generates anything", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toContain("pre-registered");
    expect(entry).toMatch(/before .*(arm|§23-d|§23-e|§23-f).*generat/s);
  });
});

describe("T-0227 bake-off pre-registration — subject and state", () => {
  it("fixes the subject to the player character, idle state only", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toContain("player character");
    expect(entry).toMatch(/idle (state )?only/);
  });

  it("conditions all three arms on T-0209's approved concept sheet", () => {
    const entry = readEntry();
    expect(entry).toContain("T-0209");
    expect(entry).toContain("player_character_concept_sheet_v1.png");
  });
});

describe("T-0227 bake-off pre-registration — output spec, identically binding", () => {
  const REQUIRED = [
    "3x3",
    "48x48",
    "144x144",
    "13-asset-pipeline.md",
    "§3.1",
    "16-slot",
    "P-7",
    "model_hash",
    "concept_hash"
  ];

  it.each(REQUIRED)("records %s in the output spec", (needle) => {
    expect(readEntry()).toContain(needle);
  });

  it("states the output spec binds all three arms identically, with no exceptions", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toMatch(/identical(ly)? .*(all three arms|binding)|binding on all three arms/s);
    expect(entry).toContain("no exceptions");
  });
});

describe("T-0227 bake-off pre-registration — judging conditions", () => {
  it("judges at 40px, in motion, inside the T-0192 blockout room", () => {
    const entry = readEntry();
    expect(entry).toContain("40px");
    expect(entry.toLowerCase()).toContain("in motion");
    expect(entry).toContain("T-0192");
    expect(entry.toLowerCase()).toContain("blockout room");
  });

  it("explicitly rules out judging at 1152 and judging as a contact sheet", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toContain("1152");
    expect(entry).toMatch(/not at 1152/);
    expect(entry).toMatch(/not as a contact sheet/);
  });
});

describe("T-0227 bake-off pre-registration — criteria, in strict precedence", () => {
  const C1 = "**Criterion 1 — Silhouette readable at 40px in motion**";
  const C2 = "**Criterion 2 — Identity stable across adjacent frames**";
  const C3 = "**Criterion 3 — Cost**";

  it("names all three criteria and orders them 1 -> 2 -> 3 in the text", () => {
    const entry = readEntry();
    const i1 = entry.indexOf(C1);
    const i2 = entry.indexOf(C2);
    const i3 = entry.indexOf(C3);
    expect(i1, `missing: ${C1}`).toBeGreaterThan(-1);
    expect(i2, `missing: ${C2}`).toBeGreaterThan(-1);
    expect(i3, `missing: ${C3}`).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it("calls the precedence strict, not a weighting", () => {
    expect(readEntry().toLowerCase()).toContain("strict precedence");
  });

  it("criterion 1 eliminates a failing arm rather than penalising it", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toMatch(/eliminat/);
    expect(entry).toMatch(/not .*(penalis|penaliz)/);
  });

  it("criterion 1 is a human pass/fail on person, facing, and action", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toContain("human pass/fail");
    expect(entry).toMatch(/is it a person/);
    expect(entry).toMatch(/which way is it facing/);
    expect(entry).toMatch(/what is it doing/);
  });

  it("criterion 2 names both halves of its mechanism", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toContain("frame-silhouette delta gate");
    expect(entry).toContain("human drift verdict");
  });

  it("criterion 3 names all four cost columns", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toContain("gpu minutes");
    expect(entry).toContain("attempts-to-first-pass");
    expect(entry).toContain("wall-clock");
    expect(entry).toContain("$");
  });
});

describe("T-0227 bake-off pre-registration — the decision rule and the tie-break", () => {
  it("arms failing criterion 1 are out", () => {
    expect(readEntry().toLowerCase()).toMatch(/failing .*criterion 1.* are out|criterion-1 failures are out/s);
  });

  it("among the passers, lowest cost wins", () => {
    expect(readEntry().toLowerCase()).toContain("lowest cost wins");
  });

  it("a tie resolves to the script — Arm C", () => {
    const entry = readEntry();
    expect(entry.toLowerCase()).toMatch(/tie.*the script.*wins/s);
    expect(entry).toContain("Arm C");
  });
});

describe("T-0227 bake-off pre-registration — attempt cap", () => {
  it("caps attempts at 8 per arm", () => {
    expect(readEntry()).toContain("Attempt cap: 8 per arm");
  });

  it("reads exhausting the cap as a criterion-3 failure, not a null result", () => {
    const entry = readEntry().toLowerCase();
    expect(entry).toMatch(/criterion[ -]3 failure/);
    expect(entry).toMatch(/8 attempts/);
  });
});

describe("T-0227 bake-off cost-recording template", () => {
  it("is committed at docs/decisions/T-0227-bakeoff-cost-record-template.md", () => {
    expect(fs.existsSync(COST_TEMPLATE), `missing file: ${COST_TEMPLATE}`).toBe(true);
  });

  it("is referenced from DL-21, so rule and template cannot drift apart", () => {
    expect(readEntry()).toContain("T-0227-bakeoff-cost-record-template.md");
  });

  it("names the same four cost columns criterion 3 names", () => {
    const template = readTemplate().toLowerCase();
    expect(template).toContain("gpu minutes");
    expect(template).toContain("attempts-to-first-pass");
    expect(template).toContain("wall-clock");
    expect(template).toContain("$");
  });

  it("carries a row for each of the three arms so §23-g's table is comparable by construction", () => {
    const template = readTemplate();
    expect(template).toContain("Arm A");
    expect(template).toContain("Arm B");
    expect(template).toContain("Arm C");
    expect(template).toContain("§23-g");
  });

  it("records the criterion-1 and criterion-2 verdicts alongside cost, so a cheap eliminated arm is never mistaken for the winner", () => {
    const template = readTemplate().toLowerCase();
    expect(template).toContain("criterion 1");
    expect(template).toContain("criterion 2");
  });
});
