/**
 * T-0335 — clarify the authorship rule the two-tier asset pipeline depends on.
 *
 * There is no literal "NO SYNTHETIC ASSETS" heading anywhere in the repo (verified by
 * grep). The rule that actually binds is DL-23 (`docs/decision-log.md`), which overrode
 * Arm C's mechanical bake-off win "on authorship grounds" and sent round 2 after Arms
 * A/B "rather than shipping the script." Read literally, DL-23 forbids exactly the
 * Tier-2 compositor the new two-tier pipeline is built on. But DL-25 already shipped a
 * hybrid arm that uses band-translate internally, and the T-0239 incident
 * (`docs/board-invariants.md`) forbids something narrower still: a sheet whose pixels
 * were drawn by script with no diffusion sample behind them. Those three are not
 * consistent as written.
 *
 * DL-30 settles it: every shipped pixel must originate from a diffusion sample;
 * arrangement, transformation, cutout, descent and compositing of already-sampled
 * pixels by script are allowed. Only *inventing* pixels procedurally is forbidden.
 *
 * These tests pin:
 *   1. DL-30 exists as the next free DL number (after DL-29) and is dated/attributed
 *      correctly.
 *   2. It states the rule (near-)verbatim.
 *   3. It explicitly clarifies, not overturns, DL-23, citing DL-23 by number.
 *   4. It reconciles DL-25 and the T-0239 incident, one line each.
 *   5. DL-23, DL-25 and DL-29's pre-existing text are untouched.
 *   6. `docs/design/13-asset-pipeline.md` references DL-30.
 *
 * Same whitespace-normalized substring-pinning technique `decisionLogDL23Override.test.js`
 * already uses — prose in this file wraps at ~90 columns, so a literal multi-word
 * `toContain` on raw text is one rewrap away from a false failure.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DECISION_LOG = path.join(REPO_ROOT, "docs", "decision-log.md");
const PIPELINE_DOC = path.join(REPO_ROOT, "docs", "design", "13-asset-pipeline.md");

const norm = (s) => s.replace(/\s+/g, " ");

function readLog() {
  return fs.existsSync(DECISION_LOG) ? fs.readFileSync(DECISION_LOG, "utf8") : "";
}

/** Text between a `## DL-N` heading and the next `## ` heading (or EOF), normalized. */
function readSection(heading) {
  const text = readLog();
  const start = text.indexOf(heading);
  if (start === -1) return "";
  const nextHeading = text.indexOf("\n## ", start + 1);
  const raw = nextHeading === -1 ? text.slice(start) : text.slice(start, nextHeading);
  return norm(raw);
}

/** The first `## DL-N` heading in the file with N > 29 — the new entry. Normalized. */
function readNewEntry() {
  const text = readLog();
  const headings = [...text.matchAll(/\n## DL-(\d+)/g)].map((m) => ({
    n: Number(m[1]),
    index: m.index + 1
  }));
  const candidates = headings.filter((h) => h.n > 29).sort((a, b) => a.index - b.index);
  if (candidates.length === 0) return { number: null, text: "" };
  const first = candidates[0];
  const nextIndex = headings.find((h) => h.index > first.index)?.index;
  const raw = nextIndex ? text.slice(first.index, nextIndex) : text.slice(first.index);
  return { number: first.n, text: norm(raw) };
}

describe("DL-23, DL-25 and DL-29 are untouched by this card", () => {
  it("DL-23 still opens as the authorship-grounds override", () => {
    const dl23 = readSection("## DL-23");
    expect(dl23).not.toBe("");
    expect(dl23).toContain(
      "DL-21 override: Arm C's mechanical win is overridden on authorship grounds"
    );
    expect(dl23.toLowerCase()).toContain("rather than shipping the script");
  });

  it("DL-25 still opens as the round-2 character decision", () => {
    const dl25 = readSection("## DL-25");
    expect(dl25).not.toBe("");
    expect(dl25).toContain(
      "Round-2 character decision: §24-e (hybrid) chosen on direction; Arm C becomes the permanent quality reference, not a gate"
    );
    expect(dl25.toLowerCase()).toContain("standing rule");
  });

  it("DL-29 still opens as the host-action escalation entry", () => {
    const dl29 = readSection("## DL-29");
    expect(dl29).not.toBe("");
    expect(dl29).toContain(
      "Host-action escalation: structured category + preflight, no new execution surface (T-0323)"
    );
  });
});

describe("a new DL-30 entry exists under the next free number", () => {
  it("is numbered exactly 30", () => {
    const { number } = readNewEntry();
    expect(number, "no DL entry numbered above 29 found").not.toBeNull();
    expect(number).toBe(30);
  });

  it("is dated 2026-09-09 and attributed to @DennieSeth", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("2026-09-09");
    expect(entry).toContain("@DennieSeth");
  });

  it("names T-0335 as the raising card", () => {
    expect(readNewEntry().text).toContain("T-0335");
  });
});

describe("the new entry states the rule (near-)verbatim", () => {
  it("every shipped pixel originates from a diffusion sample", () => {
    const entry = readNewEntry().text;
    expect(entry.toLowerCase()).toContain(
      "every shipped pixel originates from a diffusion sample"
    );
  });

  it("arrangement, transformation, cutout, descent and compositing by script are allowed", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toContain("arrangement");
    expect(entry).toContain("transformation");
    expect(entry).toContain("cutout");
    expect(entry).toContain("descent");
    expect(entry).toContain("compositing");
    expect(entry).toMatch(/by script are allowed/);
  });

  it("forbids inventing pixels procedurally that no sampler produced", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toMatch(/inventing.*pixels.*procedurally/s);
    expect(entry).toContain("no sampler produced");
  });
});

describe("the new entry clarifies, not overturns, DL-23", () => {
  it("says clarifies rather than overturns, citing DL-23 by number", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toMatch(/clarif(y|ies).*(not|does not|rather than).*overturn/s);
    expect(entry).toContain("dl-23");
  });

  it("states DL-23's concern was shipping a figure no sampler drew, not forbidding scripted arrangement", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toMatch(/no sampler drew|shipping a figure no sampler/);
  });
});

describe("the new entry reconciles DL-25 and the T-0239 incident", () => {
  it("reconciles DL-25's shipped band-translate hybrid as consistent with DL-30", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("DL-25");
    expect(entry.toLowerCase()).toContain("band-translate");
    expect(entry).toContain("T-0252");
  });

  it("reconciles the T-0239 incident as correctly rejected under DL-30", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("T-0239");
    expect(entry.toLowerCase()).toMatch(/no diffusion sample|invented, not sampled|drawn by script.*no sample/s);
  });
});

describe("docs/design/13-asset-pipeline.md references DL-30", () => {
  it("mentions DL-30", () => {
    const text = fs.existsSync(PIPELINE_DOC) ? fs.readFileSync(PIPELINE_DOC, "utf8") : "";
    expect(text).toContain("DL-30");
  });
});
