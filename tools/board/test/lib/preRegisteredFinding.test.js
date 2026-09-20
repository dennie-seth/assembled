import { describe, it, expect } from "vitest";
import {
  PRE_REGISTRATION_HEADING,
  FINDING_HEADING,
  hasPreRegisteredExperiment,
  readFindingSection,
  parseFindingEvidencePaths,
  classifyFindingEvidenceCitations,
  isDecisiveFinding,
  checkFindingWithEvidence
} from "../../src/lib/preRegisteredFinding.js";

/**
 * T-0387's actual "Proposed finding" text (docs/assets/evidence/T-0387/README.md, from the merged
 * PR #402), transcribed verbatim -- see T-0395: this exact Finding, an honest pre-registered
 * stop-and-report citing 12 real evidence files plus one path cited as explicitly absent and one
 * backtick-quoted prompt weight, is the regression fixture the two defects below were found from.
 */
const T0387_EVIDENCE_PATHS = [
  "docs/assets/evidence/T-0387/attempt_1_main_1024.png",
  "docs/assets/evidence/T-0387/attempt_1_head_cropped_off_top_crop.png",
  "docs/assets/evidence/T-0387/attempt_1_legs_cropped_not_raised_crop.png",
  "docs/assets/evidence/T-0387/attempt_1_arm_warped_crop.png",
  "docs/assets/evidence/T-0387/attempt_2_main_1024.png",
  "docs/assets/evidence/T-0387/attempt_2_torso_second_hand_crop.png",
  "docs/assets/evidence/T-0387/attempt_2_head_no_lens_crop.png",
  "docs/assets/evidence/T-0387/attempt_2_legs_no_raise_crop.png",
  "docs/assets/evidence/T-0387/attempt_3_main_1024.png",
  "docs/assets/evidence/T-0387/attempt_3_torso_second_hand_like_crop.png",
  "docs/assets/evidence/T-0387/attempt_3_head_no_lens_crop.png",
  "docs/assets/evidence/T-0387/attempt_3_legs_no_raise_crop.png"
];

const T0387_ABSENT_PATH = "assets/src/concept/player_profile_forward_limb_reference_controlnet.png";

const T0387_FINDING_TEXT = [
  "Decisive falsification of this card's pre-registered hypothesis, within the 3-attempt cap: " +
    "holding denoise at 0.87 and moving only the skeleton and/or the prompt did not produce a " +
    "strict-profile forward-limb green reference passing every acceptance check, and the attempt " +
    "sequence itself surfaced a new, decisive constraint the pre-registered hypothesis did not " +
    "anticipate -- the near-leg raise and the eye-separation fix cannot currently be tried " +
    "together at this denoise without reopening the second-hand defect T-0382's own far-arm " +
    "collapse had already fixed.",
  "Attempt 1 (`docs/assets/evidence/T-0387/attempt_1_main_1024.png`, seed 380002, denoise 0.87, " +
    "skeleton with both the near-knee/ankle excursion enlarged and the eye pair separated, prompt " +
    "heavily rewritten with `:1.4`-weighted lens/leg clauses plus an added background-reinforcement " +
    "clause) broke composition outright: the figure rendered zoomed in far past the frame, the " +
    "hood cropped off the top edge entirely " +
    "(`docs/assets/evidence/T-0387/attempt_1_head_cropped_off_top_crop.png`), both boots cut off " +
    "at the bottom edge, still standing together and not raised " +
    "(`docs/assets/evidence/T-0387/attempt_1_legs_cropped_not_raised_crop.png`), and the near hand " +
    "rendered as a warped, fingerless mitt bleeding toward the frame edge " +
    "(`docs/assets/evidence/T-0387/attempt_1_arm_warped_crop.png`). Border max channel measured " +
    "202, far over the 16 ceiling and worse than any of T-0382's own three attempts.",
  "Attempt 2 (`docs/assets/evidence/T-0387/attempt_2_main_1024.png`, same seed and skeleton as " +
    "attempt 1, prompt reverted to near-verbatim T-0382 wording with only the lens/leg clauses " +
    "lightly touched) recovered normal composition -- the whole figure fit in frame again -- but " +
    "reopened exactly the defect T-0380/T-0382's far-arm collapse was built to prevent: a second, " +
    "unrequested gloved hand hanging at the hip, clearly separate from the single extended arm at " +
    "the shoulder (`docs/assets/evidence/T-0387/attempt_2_torso_second_hand_crop.png`). The head " +
    "still showed no goggle lens, just a smooth pointed hood " +
    "(`docs/assets/evidence/T-0387/attempt_2_head_no_lens_crop.png`), and the legs showed no " +
    "raise, only an ambiguous striped texture at the shin with both feet effectively together " +
    "(`docs/assets/evidence/T-0387/attempt_2_legs_no_raise_crop.png`). Border max channel measured " +
    "118, still far over the 16 ceiling.",
  "Attempt 3 (`docs/assets/evidence/T-0387/attempt_3_main_1024.png`, same seed, near-knee/ankle " +
    "and leg prompt clause reverted verbatim to T-0382's own values to isolate the one change " +
    "least implicated in attempt 2's regression -- the wider eye separation -- alongside the " +
    "lightly-touched lens wording) restored a clean single extended arm at the shoulder, but a " +
    "second, glove-textured shape is still visible folded at the near hip, ambiguous but " +
    "suspicious for the same second-hand defect " +
    "(`docs/assets/evidence/T-0387/attempt_3_torso_second_hand_like_crop.png`). The head still " +
    "showed no visible lens, only a fully wrapped, featureless hood " +
    "(`docs/assets/evidence/T-0387/attempt_3_head_no_lens_crop.png`) -- the eye-separation change " +
    "alone did not produce a legible lens. The legs showed both feet planted together on an " +
    "unrequested scenery element (a platform/plinth shape neither prompt nor skeleton asked for), " +
    "no raise at all (`docs/assets/evidence/T-0387/attempt_3_legs_no_raise_crop.png`). Border max " +
    "channel measured 146, again far over the 16 ceiling. Green band (centred 187x200 crop) " +
    "cleared the 6,000 floor in all three attempts (19,064 / 18,205 / 22,989 px) -- green content " +
    "was never the limiting check.",
  "The decisive result across the three attempts: the goggle lens did not become visible in any " +
    "attempt, including the one (attempt 3) that isolated the eye-separation change specifically " +
    "to test it -- a skeleton joint change to two head keypoints was not sufficient on its own to " +
    "make a texture-level feature (a lens set into the hood) legible at this denoise, at least not " +
    "without reopening other defects when combined with other changes. The near-leg raise was not " +
    "achieved in any attempt either; the one attempt that tried a substantially larger knee/ankle " +
    "excursion (attempt 1) also broke composition outright, so the raised-leg fix remains untested " +
    "in isolation within this card's 3-attempt cap. And the single-arm result T-0382 attempt 1 " +
    "already had at this exact seed/denoise/prompt baseline proved fragile: it broke under a " +
    "combined skeleton+prompt change (attempt 1), reappeared as a defect under a partial revert " +
    "(attempt 2), and remained ambiguous even under the most conservative, most isolated change " +
    "tried (attempt 3). Per this card's own pre-registered alternative outcome, this is a valid " +
    "PASS: stop and report, not spend a fourth attempt. No reference is promoted -- " +
    "`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` does not exist on " +
    "this branch."
].join("\n\n");

/**
 * T-0342: "finding with evidence" is a first-class PASS for `deliverable_type: artifact` cards,
 * but only when the finding was pre-registered (DL-21 style) BEFORE the run that produced it.
 * See docs/PLAN.md and the T-0342 card body for the motivating case (T-0259 session 13: a real,
 * pre-registered falsifying result FAILed anyway because only a promoted artifact counted).
 */

describe("hasPreRegisteredExperiment", () => {
  it("is true when the heading is present with non-empty content", () => {
    const body = `## Context\nsome stuff\n\n${PRE_REGISTRATION_HEADING}\nIf X, the arm is falsified.\n\n## Acceptance\n- [ ] ...\n`;
    expect(hasPreRegisteredExperiment(body)).toBe(true);
  });

  it("is false when the heading is absent entirely", () => {
    const body = `## Context\nsome stuff\n\n## Acceptance\n- [ ] ...\n`;
    expect(hasPreRegisteredExperiment(body)).toBe(false);
  });

  it("is false when the heading is present but has no content before the next heading", () => {
    const body = `${PRE_REGISTRATION_HEADING}\n\n## Acceptance\n- [ ] ...\n`;
    expect(hasPreRegisteredExperiment(body)).toBe(false);
  });

  it("is false for an empty or missing body", () => {
    expect(hasPreRegisteredExperiment("")).toBe(false);
    expect(hasPreRegisteredExperiment(undefined)).toBe(false);
  });

  it("captures content up to the next top-level heading only, not a nested subheading", () => {
    const body = `${PRE_REGISTRATION_HEADING}\n### Subheading still part of the section\nprediction text\n\n## Finding\nsomething else\n`;
    // Still true (non-empty content before the next ## heading)
    expect(hasPreRegisteredExperiment(body)).toBe(true);
  });
});

describe("readFindingSection / parseFindingEvidencePaths / isDecisiveFinding", () => {
  it("extracts the Finding section text", () => {
    const body = `## Context\n...\n\n${FINDING_HEADING}\nThe result is decisive: arm falsified. See \`docs/assets/evidence/T-0999/frame.png\`.\n\n## Do not\n...\n`;
    expect(readFindingSection(body)).toContain("decisive");
  });

  it("returns an empty string when there is no Finding section", () => {
    expect(readFindingSection("## Context\nnothing here\n")).toBe("");
  });

  it("extracts backtick-quoted, extensioned file paths, deduped and in order", () => {
    const text =
      "Attempt 8's `docs/assets/evidence/T-0999/attempt_8_main.png` confirms the drift; " +
      "compare against `docs/assets/evidence/T-0999/attempt_1_main.png` again and " +
      "`docs/assets/evidence/T-0999/attempt_8_main.png` once more.";
    expect(parseFindingEvidencePaths(text)).toEqual([
      "docs/assets/evidence/T-0999/attempt_8_main.png",
      "docs/assets/evidence/T-0999/attempt_1_main.png"
    ]);
  });

  it("ignores backtick spans that aren't extensioned file paths (inline commands, bare words)", () => {
    const text = "Run `npm test` and check `main`, not a path.";
    expect(parseFindingEvidencePaths(text)).toEqual([]);
  });

  it("ignores backtick-quoted prompt weights and dotted identifiers -- CITATION_PATTERN false positives (T-0395)", () => {
    const text =
      "Prompt heavily rewritten with `:1.4`-weighted lens/leg clauses, per `(lens:1.4)`, " +
      "pinned to `v1.2.3` of the workflow.";
    expect(parseFindingEvidencePaths(text)).toEqual([]);
  });

  it("still extracts a bare filename with a known evidence extension even with no path separator", () => {
    const text = "Compare against `main_384.png` from the prior attempt.";
    expect(parseFindingEvidencePaths(text)).toEqual(["main_384.png"]);
  });

  it("extracts a path with a separator even when its extension isn't in the known evidence list", () => {
    const text = "See `assets/final/palette/home_palette.xyz` and `docs/branching.cfg`.";
    expect(parseFindingEvidencePaths(text)).toEqual([
      "assets/final/palette/home_palette.xyz",
      "docs/branching.cfg"
    ]);
  });

  it("isDecisiveFinding requires the literal word 'decisive' (case-insensitive)", () => {
    expect(isDecisiveFinding("The result is Decisive: falsified.")).toBe(true);
    expect(isDecisiveFinding("the result is decisive")).toBe(true);
    expect(isDecisiveFinding("inconclusive, more attempts needed")).toBe(false);
    expect(isDecisiveFinding("")).toBe(false);
  });
});

describe("classifyFindingEvidenceCitations", () => {
  it("classifies a plain citation as present by default", () => {
    const text = "The result is decisive: see `docs/assets/evidence/T-0999/attempt_8_main.png`.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/assets/evidence/T-0999/attempt_8_main.png"],
      absent: []
    });
  });

  it('classifies a path cited as absent via "does not exist" separately from present evidence', () => {
    const text =
      "No reference is promoted -- `assets/src/concept/player_profile_forward_limb_reference_controlnet.png` " +
      "does not exist on this branch. See `docs/assets/evidence/T-0999/attempt_8_main.png` for the last attempt.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/assets/evidence/T-0999/attempt_8_main.png"],
      absent: ["assets/src/concept/player_profile_forward_limb_reference_controlnet.png"]
    });
  });

  it('recognizes "was not produced" as an absence clause', () => {
    const text = "The promoted sheet `assets/final/entity/sheet_v3.png` was not produced this round.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: [],
      absent: ["assets/final/entity/sheet_v3.png"]
    });
  });

  it('recognizes "is not promoted" as an absence clause', () => {
    const text = "`assets/final/entity/sheet_v3.png` is not promoted this round -- three attempts all failed.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: [],
      absent: ["assets/final/entity/sheet_v3.png"]
    });
  });

  it("ignores prompt weights and dotted identifiers entirely -- neither present nor absent", () => {
    const text = "Prompt reweighted with `:1.4` on the lens clause; result does not exist yet.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({ present: [], absent: [] });
  });
});

describe("checkFindingWithEvidence", () => {
  const evidencePath = "docs/assets/evidence/T-0999/attempt_8_main.png";

  function task(overrides = {}) {
    return {
      id: "T-0999",
      deliverable_type: "artifact",
      body: "",
      ...overrides
    };
  }

  it("is not applicable when beforeBody has no pre-registered experiment", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\ndecisive result, see \`${evidencePath}\`\n` }),
      beforeBody: "## Context\nnothing pre-registered\n",
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result).toEqual({ ok: false, applicable: false, errors: [], absentEvidence: [] });
  });

  it("is NOT satisfied by a pre-registration that exists only in the CURRENT body, not beforeBody (the anti-retroactive-registration guarantee)", async () => {
    const currentBody =
      `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n\n` +
      `${FINDING_HEADING}\ndecisive result, see \`${evidencePath}\`\n`;
    const result = await checkFindingWithEvidence({
      task: task({ body: currentBody }),
      beforeBody: "## Context\nno pre-registration was here before the run\n",
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("applicable but FAILs when pre-registered but the current body has no Finding section at all", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: "## Context\nno finding written yet\n" }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(FINDING_HEADING);
  });

  it("FAILs when the Finding section does not say the result is decisive", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nInconclusive so far, see \`${evidencePath}\`\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/decisive/i);
  });

  it("FAILs when the Finding section is decisive but cites no evidence file", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nThe result is decisive: arm falsified, trust me.\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cites no evidence file/i);
  });

  it("FAILs when a cited evidence file does not actually exist on disk", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nThe result is decisive: see \`${evidencePath}\`\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => false
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(evidencePath);
    expect(result.errors.join(" ")).toMatch(/does not exist|no file exists/i);
  });

  it("PASSes when pre-registered before the run, and the finding is decisive with existing cited evidence", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nThe result is decisive: arm falsified. See \`${evidencePath}\`.\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [], absentEvidence: [] });
  });

  it("PASSes on a path cited as absent when it genuinely doesn't exist -- it isn't required evidence", async () => {
    const absentPath = "assets/src/concept/player_profile_forward_limb_reference_controlnet.png";
    const body =
      `${FINDING_HEADING}\nThe result is decisive: arm falsified. See \`${evidencePath}\`. ` +
      `No reference is promoted -- \`${absentPath}\` does not exist on this branch.\n`;
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => !target.endsWith(absentPath)
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [], absentEvidence: [absentPath] });
  });

  it("FAILs when a Finding claims a file is absent but it actually exists -- absence claims are checked too", async () => {
    const absentPath = "assets/src/concept/player_profile_forward_limb_reference_controlnet.png";
    const body =
      `${FINDING_HEADING}\nThe result is decisive: arm falsified. See \`${evidencePath}\`. ` +
      `No reference is promoted -- \`${absentPath}\` does not exist on this branch.\n`;
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(absentPath);
    expect(result.errors.join(" ")).toMatch(/exists|absence/i);
  });

  it("FAILs (cites no evidence) when the only backtick spans are prompt weights, not paths", async () => {
    const body =
      `${FINDING_HEADING}\nThe result is decisive: arm falsified. Reweighted with \`:1.4\` and ` +
      "`(lens:1.4)` on the lens clause, no visible change.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cites no evidence file/i);
  });

  it("PASSes on T-0387's actual transcribed Finding -- 12 present evidence files, one path cited as absent, one prompt weight (T-0395 regression)", async () => {
    const body = `${FINDING_HEADING}\n${T0387_FINDING_TEXT}\n`;
    const present = new Set(T0387_EVIDENCE_PATHS);
    const result = await checkFindingWithEvidence({
      task: task({ id: "T-0387", body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf denoise 0.87 + skeleton/prompt-only changes can't pass, falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => {
        const rel = target.replace(/^\/repo\//, "");
        return present.has(rel);
      }
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [], absentEvidence: [T0387_ABSENT_PATH] });
  });
});
