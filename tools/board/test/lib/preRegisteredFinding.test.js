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

/**
 * T-0394's actual "Proposed finding" text (docs/assets/evidence/T-0394/README.md), transcribed
 * verbatim -- a second real stop-and-report Finding, distinct from T-0387's, used to pin the same
 * absent-citation/prompt-weight behaviour against a second real fixture (T-0395 acceptance: "T-0387's
 * and T-0394's real Findings still pass").
 */
const T0394_EVIDENCE_PATHS = [
  "assets/src/concept/pose_rig_forward_limb_controlnet_T0394.py",
  "assets/src/character/pose_rig_master_sheet_T0351.py",
  "docs/assets/evidence/T-0394/attempt_1_main_1024.png",
  "docs/assets/evidence/T-0394/attempt_2_main_1024.png",
  "docs/assets/evidence/T-0394/attempt_3_legs_resting_crop.png",
  "docs/assets/evidence/T-0394/attempt_3_torso_no_second_hand_crop.png",
  "assets/src/concept/pose_rig_forward_limb_controlnet_T0380.py",
  "docs/assets/evidence/T-0394/attempt_1_top_border_violation_crop.png",
  "docs/assets/evidence/T-0394/attempt_2_torso_no_arm_extension_crop.png",
  "docs/assets/evidence/T-0394/attempt_1_head_mecha_helmet_crop.png",
  "docs/assets/evidence/T-0394/attempt_3_head_mecha_helmet_crop.png",
  "docs/assets/evidence/T-0394/attempt_2_head_crop.png"
];

const T0394_ABSENT_PATH = "assets/src/concept/player_profile_forward_limb_reference_controlnet.png";

const T0394_FINDING_TEXT = [
  "Decisive falsification of this card's pre-registered hypothesis, within the 3-attempt cap: holding " +
    "the full-frame pose pass at denoise 0.87 on the resting-leg skeleton, and producing the goggle lens " +
    "via a head-masked second pass instead of a skeleton or prompt move, did not produce a strict-profile " +
    "forward-limb green reference passing every acceptance check -- and the attempt sequence surfaced a " +
    "decisive, previously-unmeasured trade-off this card's own hypothesis did not anticipate: the " +
    "full-frame composite's `frame_scale` (the headroom fix for the solid-black-background requirement) " +
    "and the single-arm result trade against each other in a dose-dependent way, at the exact same seed " +
    "that has produced a clean single arm at `frame_scale=1.0` in every prior sighting across this whole " +
    "line (T-0382 attempt 1, T-0387 attempts 2-3, this card's own attempt 1).",
  "Both of this card's two structural changes worked in isolation. The resting leg " +
    "(`assets/src/concept/pose_rig_forward_limb_controlnet_T0394.py`, near knee/ankle sourced verbatim " +
    "from `assets/src/character/pose_rig_master_sheet_T0351.py`'s `SIDE_NEUTRAL_KEYPOINTS_NORM`) produced " +
    "a clean, flat, single resting leg in every one of the 3 attempts " +
    "(`docs/assets/evidence/T-0394/attempt_1_main_1024.png`, " +
    "`docs/assets/evidence/T-0394/attempt_2_main_1024.png`, " +
    "`docs/assets/evidence/T-0394/attempt_3_legs_resting_crop.png`) -- the leg is confirmed solved, " +
    "exactly as this card's own source material predicted. And the single-arm result held at " +
    "`frame_scale=1.0` (attempt 1) and was partially recovered at `frame_scale=0.95` (attempt 3, " +
    "`docs/assets/evidence/T-0394/attempt_3_torso_no_second_hand_crop.png` shows the extended arm with no " +
    "second hand), so the far-arm collapse " +
    "(`assets/src/concept/pose_rig_forward_limb_controlnet_T0380.py`) also continued to hold across every " +
    "attempt -- no attempt in this card ever showed a second hand or glove.",
  "What did not resolve within the 3-attempt cap is the interaction between the two remaining " +
    "acceptance checks this card's own hypothesis bet on being independent levers: the border/background " +
    "fix and the goggle lens. Attempt 1 (`frame_scale=1.0`, the untouched baseline) measured border max " +
    "channel 124, far over the 16 ceiling -- the hood apex rendered only ~14px from the canvas top edge " +
    "(`docs/assets/evidence/T-0394/attempt_1_top_border_violation_crop.png`), confirming the border " +
    "defect is real and structural at denoise 0.87, not attempt-specific noise. Attempt 2 " +
    "(`frame_scale=0.88`) fixed the border decisively (max channel 4) but lost the near-arm extension " +
    "entirely (`docs/assets/evidence/T-0394/attempt_2_torso_no_arm_extension_crop.png` shows both arms " +
    "down at rest, and the pose pass's own pre-detail-pass output already shows this, ruling out the " +
    "detail pass as the cause). Attempt 3 (`frame_scale=0.95`, a deliberately gentler value chosen " +
    "specifically to preserve more of the untouched baseline's geometry) partially recovered the arm but " +
    "only partially recovered the border fix too: max channel 67, worse than attempt 2's 4, better than " +
    "attempt 1's 124 -- consistent with a real, monotonic, dose-dependent trade-off between `frame_scale` " +
    "and the single-arm result at this seed, not two independent defects each fixable on its own lever.",
  "The goggle lens also never became legible across all 3 attempts, regardless of the detail pass's own " +
    "denoise (0.55 in attempt 1, 0.35 in attempts 2-3): attempt 1 and attempt 3 both show the " +
    "head-masked detail pass redesigning the hood into an ornate, multi-faceted armour-plate helmet " +
    "(`docs/assets/evidence/T-0394/attempt_1_head_mecha_helmet_crop.png`, " +
    "`docs/assets/evidence/T-0394/attempt_3_head_mecha_helmet_crop.png`) rather than clarifying a single " +
    "circular lens on the pose pass's own hood silhouette, and attempt 3 in particular shows no " +
    "lens-like highlight at all. Attempt 2's head crop " +
    "(`docs/assets/evidence/T-0394/attempt_2_head_crop.png`) is the closest of the three -- a clean, " +
    "legible pale mask shape is visible -- but it reads as a stylised full mask/face, not \"a single dark " +
    "round goggle lens,\" so it does not clear this card's own specific acceptance wording either. Across " +
    "three attempts at two different detail-pass denoise values, the mechanism did not reliably produce a " +
    "legible single circular lens on demand.",
  "No image produced by any of the three attempts passes every acceptance check simultaneously. Per " +
    "this card's own pre-registered alternative outcome, this is a decisive valid PASS: stop and report, " +
    "not spend a fourth attempt. No reference is promoted -- " +
    "`assets/src/concept/player_profile_forward_limb_reference_controlnet.png` does not exist on this " +
    "branch."
].join("\n\n");

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

  it("[FIX ROUND 1] binds an absence phrase to its own clause, not to a positively-cited path sharing the same sentence", () => {
    // Chat's reproduction (round-2 review of #409): a positive citation and a legitimate absence
    // claim share one sentence, joined by "while". Only the second path is actually claimed absent.
    const text =
      "Decisive: see `docs/good.png`. `docs/missing.png` records the result, while " +
      "`assets/result.png` was not produced.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/good.png", "docs/missing.png"],
      absent: ["assets/result.png"]
    });
  });

  it("[FIX ROUND 1] the converse mixed-clause case: a legitimate absence claim does not drag a present citation in the same sentence into absent", () => {
    const text =
      "`assets/result.png` was not produced, while `docs/good.png` records the actual result.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/good.png"],
      absent: ["assets/result.png"]
    });
  });

  it("[FIX ROUND 1] a pure positive citation (no absence phrase anywhere in the sentence) stays present", () => {
    const text = "Decisive: see `docs/good.png` for the result.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({ present: ["docs/good.png"], absent: [] });
  });

  it("[FIX ROUND 1] a pure absence claim (single citation, single clause) stays absent", () => {
    const text = "No reference is promoted -- `docs/missing.png` does not exist on this branch.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({ present: [], absent: ["docs/missing.png"] });
  });

  it('[FIX ROUND 2] binds absence to the specific "and"-joined citation, not to every citation in the sentence', () => {
    // Chat's round-3 reproduction: FIX ROUND 1's clause-boundary list didn't include "and", so both
    // nonexistent paths were classified absent even though `docs/missing.png` is affirmatively cited.
    const text =
      "Decisive: see `docs/good.png`. `docs/missing.png` records the result and " +
      "`assets/result.png` was not produced.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/good.png", "docs/missing.png"],
      absent: ["assets/result.png"]
    });
  });

  it("[FIX ROUND 2] the newline-separated variant of the same text classifies identically", () => {
    // Same clauses, "and" replaced by a bare newline and no terminating period on the first line --
    // a Markdown line break must not merge two independent citations into one absence claim.
    const text =
      "Decisive: see `docs/good.png`. `docs/missing.png` records the result\n" +
      "`assets/result.png` was not produced.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/good.png", "docs/missing.png"],
      absent: ["assets/result.png"]
    });
  });

  it("[FIX ROUND 2] the converse: an existing citation sharing a line with a legitimate absence claim is not misclassified as absent", () => {
    const text = "Decisive: `docs/good.png` confirms the result and `assets/result.png` was not produced.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/good.png"],
      absent: ["assets/result.png"]
    });
  });

  it("[FIX ROUND 3] does not bind an absence phrase to a citation unless the phrase directly attaches to that citation -- a later, uncited negative phrase must not reach back to the nearest preceding citation", () => {
    // Chat's round-4 reproduction: the claim window still let ANY absence phrase inside it mark the
    // preceding citation absent, even with no backtick path of its own. Here "was not produced"
    // predicates "the final artifact", not `docs/missing.png` -- the sentence says that path
    // *records the result*. Positional proximity is not a binding rule.
    const text =
      "Decisive: see `docs/good.png`. `docs/missing.png` records the result, but the final artifact " +
      "was not produced.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({
      present: ["docs/good.png", "docs/missing.png"],
      absent: []
    });
  });

  it("[FIX ROUND 3] a directly-attached absence predicate (citation is the immediate subject) is still recognized as absent", () => {
    const text = "No reference is promoted -- `docs/missing.png` does not exist on this branch.";
    expect(classifyFindingEvidenceCitations(text)).toEqual({ present: [], absent: ["docs/missing.png"] });
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

  it("PASSes on T-0394's actual transcribed Finding -- 12 present evidence files, one path cited as absent (T-0395 regression)", async () => {
    const body = `${FINDING_HEADING}\n${T0394_FINDING_TEXT}\n`;
    const present = new Set(T0394_EVIDENCE_PATHS);
    const result = await checkFindingWithEvidence({
      task: task({ id: "T-0394", body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf the resting-leg skeleton + head-masked detail pass can't pass, falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => {
        const rel = target.replace(/^\/repo\//, "");
        return present.has(rel);
      }
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [], absentEvidence: [T0394_ABSENT_PATH] });
  });

  it("[FIX ROUND 1] REJECTs a mixed-clause Finding where a positively-cited path is missing, even though the same sentence also makes a legitimate absence claim", async () => {
    // Chat's reproduction: only docs/good.png exists. docs/missing.png is cited affirmatively
    // ("records the result") and must stay FATAL; assets/result.png is a legitimate absence claim.
    const body =
      `${FINDING_HEADING}\nDecisive: see \`docs/good.png\`. \`docs/missing.png\` records the result, ` +
      "while `assets/result.png` was not produced.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => target.endsWith("docs/good.png")
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("docs/missing.png");
    expect(result.errors.join(" ")).not.toContain("assets/result.png");
    expect(result.absentEvidence).toEqual(["assets/result.png"]);
  });

  it("[FIX ROUND 1] the converse mixed-clause case does not false-reject: a present citation sharing a sentence with a legitimate absence claim still PASSes", async () => {
    const body =
      `${FINDING_HEADING}\nDecisive: \`assets/result.png\` was not produced, while ` +
      "`docs/good.png` records the actual result.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => target.endsWith("docs/good.png")
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [], absentEvidence: ["assets/result.png"] });
  });

  it('[FIX ROUND 2] REJECTs an "and"-joined Finding where a positively-cited path is missing, even though the same sentence also makes a legitimate absence claim', async () => {
    // Chat's round-3 reproduction: only docs/good.png exists. docs/missing.png is cited affirmatively
    // ("records the result") and must stay FATAL; assets/result.png is a legitimate absence claim.
    const body =
      `${FINDING_HEADING}\nDecisive: see \`docs/good.png\`. \`docs/missing.png\` records the result and ` +
      "`assets/result.png` was not produced.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => target.endsWith("docs/good.png")
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("docs/missing.png");
    expect(result.errors.join(" ")).not.toContain("assets/result.png");
    expect(result.absentEvidence).toEqual(["assets/result.png"]);
  });

  it("[FIX ROUND 2] the newline-separated variant reproduces the same rejection -- Markdown line breaks must not merge citations", async () => {
    const body =
      `${FINDING_HEADING}\nDecisive: see \`docs/good.png\`. \`docs/missing.png\` records the result\n` +
      "`assets/result.png` was not produced.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => target.endsWith("docs/good.png")
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("docs/missing.png");
    expect(result.errors.join(" ")).not.toContain("assets/result.png");
    expect(result.absentEvidence).toEqual(["assets/result.png"]);
  });

  it('[FIX ROUND 2] the converse "and"-joined case does not false-reject: a present citation sharing a line with a legitimate absence claim still PASSes', async () => {
    const body =
      `${FINDING_HEADING}\nDecisive: \`docs/good.png\` confirms the result and ` +
      "`assets/result.png` was not produced.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => target.endsWith("docs/good.png")
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [], absentEvidence: ["assets/result.png"] });
  });

  it("[FIX ROUND 3] REJECTs when an uncited negative phrase sits near a citation that is not actually its subject -- the citation is affirmatively cited and must exist", async () => {
    // Chat's reproduction: only docs/good.png exists. docs/missing.png "records the result" (an
    // affirmative citation) -- the absence concerns "the final artifact", which has no citation of
    // its own, so it must not waive docs/missing.png's existence requirement.
    const body =
      `${FINDING_HEADING}\nDecisive: see \`docs/good.png\`. \`docs/missing.png\` records the result, ` +
      "but the final artifact was not produced.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async (target) => target.endsWith("docs/good.png")
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("docs/missing.png");
    expect(result.absentEvidence).toEqual([]);
  });

  it("[FIX ROUND 3] the existing-file counterpart of that same sentence PASSes and reports the path as present evidence, never as a false absence", async () => {
    const body =
      `${FINDING_HEADING}\nDecisive: see \`docs/good.png\`. \`docs/missing.png\` records the result, ` +
      "but the final artifact was not produced.\n";
    const result = await checkFindingWithEvidence({
      task: task({ body }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [], absentEvidence: [] });
  });
});
