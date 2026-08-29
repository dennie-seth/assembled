/**
 * T-0253 (HANDOFF §24, handle "DL-22") — @DennieSeth's override of DL-21's
 * mechanical outcome. DL-21's decision rule mechanically resolved to Arm C
 * (lowest cost among the passers); DL-22 (T-0231) recorded that mechanical
 * state and stayed PENDING for the human sign-off DL-21's criteria required.
 * This override *is* that sign-off, closing DL-22's PENDING state and
 * sending round 2 (§24-a..§24-e) after Arms A/B, with Arm C retained as the
 * benchmark and shipping fallback.
 *
 * `docs/decision-log.md`'s header says entries are permanent — do not remove
 * or amend. So this override is a *new*, appended entry, not an edit to
 * DL-21 or DL-22. These tests pin:
 *   1. the new entry exists, under the next free DL number (not `DL-22`,
 *      which T-0231 already used) and states it carries the §24 "DL-22"
 *      handle;
 *   2. DL-21 and DL-22's pre-existing text is untouched — the same
 *      substring-pinning technique `bakeoffPreregistration.test.js` already
 *      uses for DL-21, extended here to also cover DL-22;
 *   3. the new entry's required content: the override itself, each arm's
 *      round-1 numbers, that it closes DL-22, that DL-21's criteria/cap/
 *      judging conditions are unchanged for round 2, the round-1 and
 *      round-2 links, and the deferred `13-asset-pipeline.md` §3.5 edit.
 *
 * All phrase checks below run against whitespace-normalized text (line
 * wraps collapsed to single spaces) — prose in this file wraps at ~90
 * columns, so a literal multi-word `toContain` on raw text is one rewrap
 * away from a false failure.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DECISION_LOG = path.join(REPO_ROOT, "docs", "decision-log.md");

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

/** The first `## DL-N` heading in the file with N > 22 — the new entry. Normalized. */
function readNewEntry() {
  const text = readLog();
  const headings = [...text.matchAll(/\n## DL-(\d+)/g)].map((m) => ({
    n: Number(m[1]),
    index: m.index + 1
  }));
  const candidates = headings.filter((h) => h.n > 22).sort((a, b) => a.index - b.index);
  if (candidates.length === 0) return { number: null, text: "" };
  const first = candidates[0];
  const nextIndex = headings.find((h) => h.index > first.index)?.index;
  const raw = nextIndex ? text.slice(first.index, nextIndex) : text.slice(first.index);
  return { number: first.n, text: norm(raw) };
}

describe("DL-21 and DL-22 are untouched by this card", () => {
  it("DL-21 still opens as the pre-registered decision rule", () => {
    const dl21 = readSection("## DL-21");
    expect(dl21).not.toBe("");
    expect(dl21).toContain("Character-pipeline bake-off: pre-registered decision rule (T-0227)");
    expect(dl21.toLowerCase()).toContain("pre-registered");
    expect(dl21).toContain("Tie → the script (Arm C) wins.");
    expect(dl21).toContain("**Touched docs (this card):**");
    expect(dl21).toContain("docs/decisions/T-0227-bakeoff-cost-record-template.md");
  });

  it("DL-22 still opens PENDING and carries its original body untouched", () => {
    const dl22 = readSection("## DL-22");
    expect(dl22).not.toBe("");
    expect(dl22).toContain(
      "Character-pipeline bake-off: comparison assembled, verdict PENDING (T-0231)"
    );
    expect(dl22).toContain("**Status:** **PENDING.**");
    expect(dl22).toContain(
      "do not edit it to declare a winner without that sign-off; append a dated closing addendum instead"
    );
    expect(dl22).toContain("Arm A is closed as a criterion-3 failure");
    expect(dl22).toContain("Arm B and Arm C both mechanically pass criterion 2");
    expect(dl22).toContain("Cost is not close.");
    expect(dl22).toContain("attributed to **Dennie Seth**, requested 2026-08-28, not yet given");
    expect(dl22).toContain("`docs/design/13-asset-pipeline.md` is **not edited by this entry**");
    expect(dl22).toContain(
      "assets/final/character/bakeoff_frame_delta_report_T0231.json` — the re-run mechanical gate"
    );
  });
});

describe("a new DL entry records the override, under the next free number", () => {
  it("is not DL-22 — T-0231 already used that number", () => {
    const { number } = readNewEntry();
    expect(number, "no DL entry numbered above 22 found").not.toBeNull();
    expect(number).not.toBe(22);
  });

  it("states it carries the HANDOFF §24 'DL-22' handle", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("§24");
    expect(entry.toLowerCase()).toMatch(/handle.*["“]dl-22["”]|["“]dl-22["”].*handle/s);
  });

  it("names T-0253 as the resolving card", () => {
    expect(readNewEntry().text).toContain("T-0253");
  });
});

describe("the new entry records the override itself", () => {
  it("states Arm C won mechanically under DL-21's rule", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toMatch(/arm c won/);
    expect(entry).toContain("dl-21");
  });

  it("states the override is on authorship grounds, by @DennieSeth", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("@DennieSeth");
    expect(entry.toLowerCase()).toContain("authorship grounds");
    expect(entry.toLowerCase()).toContain("not a real cost");
  });

  it("demotes cost from a deciding criterion to a recorded one", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toMatch(/cost.*demoted.*deciding.*recorded/s);
  });

  it("sends round 2 after Arms A/B, with Arm C retained as benchmark and shipping fallback", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("§24-a");
    expect(entry).toContain("§24-e");
    expect(entry.toLowerCase()).toContain("benchmark");
    expect(entry.toLowerCase()).toContain("shipping fallback");
    expect(entry).toContain("0.072");
    expect(entry).toContain("0.112");
  });
});

describe("the new entry records each arm's round-1 numbers", () => {
  it("Arm A: 4/8 over the 0.30 cap, cross-row identity drift, green -> tan shift", () => {
    const entry = readNewEntry().text;
    expect(entry).toMatch(/4( of|\/)8/);
    expect(entry).toContain("0.30");
    expect(entry.toLowerCase()).toContain("cross-row identity drift");
    expect(entry.toLowerCase()).toMatch(/green.*tan/s);
    expect(entry.toLowerCase()).toContain("criterion-3 failure");
  });

  it("Arm B: 0.097-0.295, 7 of 8 attempts, 165.5 GPU-min", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("0.097");
    expect(entry).toContain("0.295");
    expect(entry).toMatch(/7( of|\/)8/);
    expect(entry).toContain("165.5");
  });

  it("Arm C: 0.072-0.112, 1 attempt, 0 GPU-min", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("0.072");
    expect(entry).toContain("0.112");
    expect(entry.toLowerCase()).toMatch(/1 attempt/);
    expect(entry.toLowerCase()).toMatch(/0(\.0)? gpu-min/);
  });
});

describe("the new entry closes DL-22 and keeps DL-21's terms unchanged for round 2", () => {
  it("states it closes DL-22's PENDING status", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toMatch(/closes dl-22('s)? pending/);
  });

  it("states DL-21's criteria, the 0.30 cap and judging conditions are unchanged for round 2", () => {
    const entry = readNewEntry().text.toLowerCase();
    expect(entry).toContain("unchanged");
    expect(entry).toContain("0.30");
    expect(entry).toMatch(/judging condition/);
  });

  it("links the round-1 cards and BAKEOFF_DECISION_T0231.md", () => {
    const entry = readNewEntry().text;
    for (const id of ["T-0228", "T-0229", "T-0230", "T-0231", "T-0237"]) {
      expect(entry, `missing link to ${id}`).toContain(id);
    }
    expect(entry).toContain("BAKEOFF_DECISION_T0231.md");
  });

  it("links the round-2 card set", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("T-0248");
    expect(entry).toContain("T-0249");
  });

  it("notes the 13-asset-pipeline.md §3.5 edit remains open, pending round 2", () => {
    const entry = readNewEntry().text;
    expect(entry).toContain("13-asset-pipeline.md");
    expect(entry).toContain("§3.5");
    expect(entry.toLowerCase()).toMatch(/remains open|open,? pending round 2/);
  });
});
