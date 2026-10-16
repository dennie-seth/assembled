/**
 * T-0443 — the board QoL audit (2026-10-09) tracking epic. This card ships a plan document only
 * (docs/design/board-qol-2026-10.md), no behaviour change: it maps every one of the audit's nine
 * numbered items to the child card implementing it, records the three-slice delivery order and
 * why it's ordered that way, and carries over the audit's own non-goals so they aren't lost once
 * the items become tickets. This pins that doc's required content.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC_PATH = path.join(REPO_ROOT, "docs", "design", "board-qol-2026-10.md");

function readDoc() {
  return fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, "utf8") : "";
}

describe("docs/design/board-qol-2026-10.md exists and links back to the report", () => {
  it("exists", () => {
    expect(fs.existsSync(DOC_PATH), `expected ${DOC_PATH} to exist`).toBe(true);
  });

  it("states the report's own path instead of copying it", () => {
    const doc = readDoc();
    expect(doc).toContain("F:\\PetProjects\\assembled\\board_audit_2026-10-09\\REPORT.md");
  });

  it("states the source revision the audit ran against", () => {
    const doc = readDoc();
    expect(doc).toContain("692edb992f375d8db351ae9763472605762a8b45");
  });

  it("names the epic card and says it carries no behaviour change", () => {
    const doc = readDoc();
    expect(doc).toContain("T-0443");
    expect(doc.toLowerCase()).toContain("no behaviour change");
  });
});

describe("the three-slice sequence and its rationale are recorded", () => {
  it("names what each slice is for, in order", () => {
    const doc = readDoc().toLowerCase();
    const trustIdx = doc.indexOf("trustworthy");
    const repeatIdx = doc.indexOf("avoid repeated work");
    const waitIdx = doc.indexOf("reduce waiting");
    expect(trustIdx, "slice 1 (trustworthy review state) not found").toBeGreaterThan(-1);
    expect(repeatIdx, "slice 2 (avoid repeated work) not found").toBeGreaterThan(-1);
    expect(waitIdx, "slice 3 (reduce waiting) not found").toBeGreaterThan(-1);
    expect(trustIdx).toBeLessThan(repeatIdx);
    expect(repeatIdx).toBeLessThan(waitIdx);
  });

  it("states the sequence exists because later items depend on earlier ones being trustworthy", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toMatch(/later .*depend on earlier .*trustworth/s);
  });
});

describe("every one of the nine numbered audit items maps to a child card", () => {
  const items = ["§1", "§2", "§3", "§4", "§5", "§6", "§7", "§8", "§9"];
  it.each(items)("item %s appears in the doc", (marker) => {
    expect(readDoc()).toContain(marker);
  });

  const childCards = [
    "T-0444", "T-0445", "T-0446", "T-0447", "T-0448", "T-0449", "T-0450",
    "T-0451", "T-0452", "T-0453", "T-0454", "T-0455", "T-0456"
  ];
  it.each(childCards)("child card %s is named", (id) => {
    expect(readDoc()).toContain(id);
  });

  it("calls out each split item (§2, §3, §4, §7) and says why it was split", () => {
    const doc = readDoc().toLowerCase();
    const splitCount = (doc.match(/\*\*split\.\*\*/g) || []).length;
    expect(splitCount).toBe(4);
  });
});

describe("the audit's non-goals are carried over in substance", () => {
  it("states the verdict sample is recent and non-random, not a general failure rate", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toContain("13 fail");
    expect(doc).toContain("9 pass");
    expect(doc).toMatch(/non-random/);
    expect(doc).toMatch(/not a (defensible )?general failure rate|not a lifetime quality metric/);
  });

  it("states concurrency is deferred until measurement shows serial execution is the bottleneck", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toContain("concurrency");
    expect(doc).toMatch(/deferred|out of scope|not this card/);
    expect(doc).toContain("dominant bottleneck");
  });

  it("states the response to the FAIL concentration is to inspect the workflow, not tune the board", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toContain("t-0436");
    expect(doc).toMatch(/inspect/);
    expect(doc).not.toMatch(/tune the board to (a|the) (lifetime )?percentage/);
  });
});

describe("edge cases the card calls out", () => {
  it("states child cards are the source of truth for their own scope, not this index", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toMatch(/source of truth/);
    expect(doc).toContain("index");
  });

  it("states no child depends on this epic and it must never gate one", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toMatch(/no child .*depends on this|depends_on.*\[\]/);
    expect(doc).toMatch(/never gate/);
  });

  it("links to the report rather than copying it wholesale", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toMatch(/not copied into the repo|don't restate its contents wholesale/);
  });
});
