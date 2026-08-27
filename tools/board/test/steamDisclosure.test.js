/**
 * T-0208 (HANDOFF §20-e1, `docs/PLAN.md` Phase 8) — "Steam Tier 1
 * pre-generated AI disclosure text drafted". `docs/design/01-vision.md` §9
 * already pre-clears the *decision* (Tier 1 applies to generated sprites +
 * audio, dev tooling is exempt, Tier 2 doesn't apply because there's no live
 * generation anywhere in this design). What was still missing was the
 * actual store-page-ready *text* implementing that decision. These tests
 * pin the drafted disclosure doc's load-bearing content so a later edit
 * that silently drops a required disclosure element (a covered content
 * type, the dev-tooling exemption, the "no live generation" clause) fails
 * here instead of only being caught by a human re-reading Valve's rules
 * from scratch.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DISCLOSURE_DOC = path.join(
  REPO_ROOT,
  "docs",
  "decisions",
  "T-0208-steam-tier1-ai-disclosure.md"
);
const VISION_DOC = path.join(REPO_ROOT, "docs", "design", "01-vision.md");

describe("T-0208 Steam disclosure — the drafted doc exists and is linked to its source decision", () => {
  let text;
  beforeAll(() => {
    text = fs.existsSync(DISCLOSURE_DOC) ? fs.readFileSync(DISCLOSURE_DOC, "utf8") : "";
  });

  it(`is committed at ${path.relative(REPO_ROOT, DISCLOSURE_DOC)}`, () => {
    expect(fs.existsSync(DISCLOSURE_DOC), `missing file: ${DISCLOSURE_DOC}`).toBe(true);
  });

  it("cites 01-vision.md §9 as the pre-cleared decision it implements", () => {
    expect(text).toContain("01-vision.md");
    expect(text).toMatch(/§9/);
  });

  it("references the vision doc's own verification date so the two can't silently drift apart", () => {
    const visionText = fs.readFileSync(VISION_DOC, "utf8");
    expect(visionText).toContain("verified 2026-08-01");
    expect(text).toContain("2026-08-01");
  });
});

describe("T-0208 Steam disclosure — the store-page text block", () => {
  let text;
  beforeAll(() => {
    text = fs.existsSync(DISCLOSURE_DOC) ? fs.readFileSync(DISCLOSURE_DOC, "utf8") : "";
  });

  it("is delimited as a distinct block a developer can paste verbatim into Steamworks", () => {
    // A fenced block (```text ... ```) or an explicit "Store page text" heading.
    expect(text.toLowerCase()).toMatch(/store page( ai disclosure)? text/);
  });

  it("names both covered content categories: generated sprite art and generated audio", () => {
    const lower = text.toLowerCase();
    expect(lower).toMatch(/sprite|pixel art|character art|art assets/);
    expect(lower).toMatch(/audio|music|sound/);
  });

  it("states the content is pre-generated during development, not produced live at runtime", () => {
    const lower = text.toLowerCase();
    expect(lower).toContain("pre-generated");
    expect(lower).toMatch(/during development|before release|not (generated|produced) (live|at runtime|in real ?time)/);
  });

  it("names the generation tooling actually used (SDXL base model + the project's trained style LoRA)", () => {
    expect(text).toMatch(/SDXL|Stable Diffusion XL/);
    expect(text.toLowerCase()).toContain("lora");
  });
});

describe("T-0208 Steam disclosure — scope boundaries (what Tier 1 does and doesn't cover here)", () => {
  let text;
  beforeAll(() => {
    text = fs.existsSync(DISCLOSURE_DOC) ? fs.readFileSync(DISCLOSURE_DOC, "utf8") : "";
  });

  it("states dev tooling (Claude Code) is exempt and out of scope for the disclosure", () => {
    const lower = text.toLowerCase();
    expect(lower).toContain("claude code");
    expect(lower).toMatch(/exempt/);
  });

  it("states Tier 2 (live/runtime AI generation) does not apply to this game", () => {
    const lower = text.toLowerCase();
    expect(lower).toContain("tier 2");
    expect(lower).toMatch(/does not apply|not applicable|no live generation/);
  });

  it("explains why Tier 2 doesn't apply: notes are template + slot lookups, never free text", () => {
    const lower = text.toLowerCase();
    expect(lower).toMatch(/template/);
    expect(lower).toMatch(/slot/);
    expect(lower).not.toMatch(/free[- ]text (notes|content) (are|is) (allowed|generated|permitted)/);
  });
});

describe("T-0208 Steam disclosure — review-risk framing carried over from the design doc", () => {
  let text;
  beforeAll(() => {
    text = fs.existsSync(DISCLOSURE_DOC) ? fs.readFileSync(DISCLOSURE_DOC, "utf8") : "";
  });

  it("notes disclosure accuracy, not disclosure itself, is what Valve enforces on", () => {
    const lower = text.toLowerCase();
    expect(lower).toMatch(/accura/);
    expect(lower).toMatch(/omission/);
  });

  it("flags this draft needs re-verification against the final shipped asset mix before submission", () => {
    const lower = text.toLowerCase();
    expect(lower).toMatch(/before (store page )?submission|before shipping|re-?verif/);
  });
});
