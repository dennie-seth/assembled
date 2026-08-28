# T-0231 — Bake-off decision record (HANDOFF §23-g)

**Author:** Claude (Sonnet 5)
**Card:** T-0231 — the deciding run of the T-0227 character-pipeline bake-off
(`docs/decision-log.md` DL-21, pre-registered 2026-08-27).
**Comparison artefact:** `assets/final/character/bakeoff_comparison_T0231.webp`
(all three arms' judging previews side by side, each already rendered at 40px,
in motion, inside the T-0192 blockout-room mockup — DL-21's judging
conditions — per `render_judging_preview*.py`, DL-18 dimensions, composited
into one lossless animated WebP by `char_gen.bakeoff_compare.build_comparison_frames`).
**Frame-delta gate report:** `assets/final/character/bakeoff_frame_delta_report_T0231.json`
(DL-21 criterion 2's mechanical gate, independently re-run against each arm's
own committed sheet for this card, not merely copied from each arm's own
provenance sidecar — though it matches those numbers exactly, since the
sheets and the gate function are both unchanged).
**Cost table:** `BAKEOFF_COST_TABLE_T0231.md` (§23-c's shared template,
concatenated unchanged across all three arms).
**Attachment note:** an earlier revision of this card built the comparison
artefact as a hand-authored SVG and, finding the board's attachment endpoint
refuses SVG/HTML content outright as a deliberate XSS safety gate
(`tools/board/src/server/httpApi.js`'s `resolveMimeType`), attached only the
three per-arm GIFs instead of the composite itself. That left the one
artefact this card's acceptance actually calls for — "all three arms side by
side... in one comparison artefact" — uploaded nowhere. This revision
rebuilds the artefact as a real raster (lossless animated WebP, `image/webp`
is on the board's own previewable-image allowlist) that embeds each arm's
preview pixels directly rather than referencing them externally, so it both
passes the attachment gate and renders correctly wherever it's opened. It is
attached to this card alongside the three individual per-arm judging-preview
GIFs it composites (`arm_a_judging_preview_T0228.gif`,
`arm_b_judging_preview_T0229.gif`, `arm_c_judging_preview_T0230.gif`), this
record, the cost table, and the delta-gate report.

---

## Status: **PENDING** — parked for Dennie's verdict, not decided here

Per this card's own human-in-the-loop note: criterion 1 (silhouette readable
at 40px in motion) and criterion 2's human drift verdict are **human
pass/fail calls** under DL-21, not something an implementer agent is entitled
to answer on the panel's behalf. Everything mechanical the bake-off's own
pre-registered rule can settle without a human is settled below. What is
still open is recorded as **PENDING**, attributed to **Dennie Seth**, not
invented.

---

## What is mechanically settled (no human call needed)

**Arm A is closed — criterion-3 failure, independent of any criterion-1
read.** Arm A's own report (`ARM_A_BAKEOFF_REPORT_T0228.md`) already
recorded 8/8 attempts exhausted without a sheet passing the mechanical half
of criterion 2 (4 of 8 adjacent-cell silhouette-delta ratios over the 0.30
cap — reconfirmed by this card's own re-run, see the frame-delta report:
`arms.arm_a.num_failed == 4`). DL-21's attempt-cap clause is explicit that
this "closes the arm" as a criterion-3 failure — an arm that never produced
a sheet passing criteria 1 *and* 2 cannot become one of "the passers" step 2
of the decision rule chooses among, whatever a human would say about its
criterion-1 silhouette on the delivered (already-failing) candidate. Arm A's
own report left its criterion-1 cell `n/a` for exactly this reason; this card
does not need to resolve that cell to close Arm A's candidacy, and records it
below as PENDING only for completeness of the record, not because it is
load-bearing.

**Arm B and Arm C both mechanically pass criterion 2, confirmed twice.**
Arm B: `ARM_B_BAKEOFF_REPORT_T0229.md` self-reports PASS/PASS, mechanical
ratios 0.097–0.295, all ≤ 0.30. Arm C: `ARM_C_BAKEOFF_REPORT_T0230.md`
self-reports PASS/PASS, mechanical ratios 0.072–0.112, all ≤ 0.30, comfortably
inside the cap. This card's own independent re-run of
`asset_gate.art.check_frame_consistency` against both arms' committed sheets
(`assets/src/character/src/char_gen/bakeoff_compare.py`,
`compute_frame_deltas`) reproduces both sets of numbers exactly — see
`bakeoff_frame_delta_report_T0231.json`'s `arms.arm_b.all_passed` and
`arms.arm_c.all_passed`, both `true`.

**Cost is not close.** Among the two arms with a mechanically valid sheet,
Arm C is cheaper on every §23-c column, by roughly two orders of magnitude
on GPU time:

| | GPU minutes | Wall-clock | $ |
|---|---|---|---|
| Arm B (§23-e) | 165.5 | 02:48 | $0.00 |
| Arm C (§23-f) | 0.0 | 00:14 | $0.00 |

If Arm B and Arm C are both confirmed as criterion-1/criterion-2 passers,
DL-21's decision rule step 2 ("among the passers, lowest cost wins")
resolves to **Arm C** without needing step 3's tie-break at all — the cost
gap is not marginal enough to be a tie by any reasonable reading.

---

## What is **not** settled here — recorded PENDING

| Verdict | Arm A | Arm B | Arm C |
|---|---|---|---|
| Criterion 1 — silhouette readable @ 40px in motion | PENDING (not load-bearing — see above) | **PENDING** | **PENDING** |
| Criterion 2 — human drift verdict (the other half of "identity stable") | PENDING (not load-bearing — Arm A already fails the mechanical half) | **PENDING** | **PENDING** |
| Attributed to | Dennie Seth | Dennie Seth | Dennie Seth |
| Date recorded | 2026-08-28 (requested; not yet given) | 2026-08-28 (requested; not yet given) | 2026-08-28 (requested; not yet given) |

Review `bakeoff_comparison_T0231.webp` (attached to this card) — all three
arms side by side, at 40px, in motion, inside the T-0192 blockout-room
mockup — and confirm or override, per arm:

1. Is it a person, which way is it facing, what is it doing? (criterion 1)
2. Does identity/silhouette hold steady frame-to-frame, or does something
   about the figure drift in a way the mechanical delta ratio didn't catch?
   (criterion 2's human half)

Arm B and Arm C's own implementer reports already carry a **self-assessment**
of PASS on both (Arm C's own report is explicit that this is "a
self-assessment, not §23-g's ratification"). That self-assessment is not a
substitute for the independent human read DL-21 asks for — it is recorded
above for reference, not counted as the verdict.

---

## What the decision rule resolves to, contingent on that sign-off

- **If Dennie confirms PASS/PASS for both Arm B and Arm C:** the rule
  resolves to **Arm C wins on criterion 3 (cost)** — see the cost table
  above. This is the outcome the mechanical evidence currently points to,
  but it is not ratified until the criterion-1/2 cells above are filled.
- **If Dennie fails Arm C on criterion 1 or the criterion-2 drift read:**
  Arm C is eliminated (DL-21: "a fail eliminates the arm — it is out of the
  bake-off entirely"), and **Arm B wins** by elimination (Arm A is already
  closed).
- **If Dennie also fails Arm B:** no arm passes. DL-21 does not explicitly
  cover this case — flagged here rather than resolved, since inventing a
  rule for it now would repeat exactly the mistake DL-21 was pre-registered
  to prevent.

## Consequence for `docs/design/13-asset-pipeline.md`, per this card's own
## acceptance — stated for every possible outcome, applied to none of them

This card does **not** edit `docs/design/13-asset-pipeline.md`. Making that
edit now, ahead of the sign-off above, would pre-empt the same human call
this record is deliberately leaving open. The consequence is stated here so
it can be applied the moment a verdict lands:

- **Arm A wins** (not reachable from the current mechanical state — Arm A is
  already closed as a criterion-3 failure — included only for the rule's own
  completeness): `13-asset-pipeline.md` §3.5 stands as written; §6.14 stage 2
  stays optional.
- **Arm B wins:** `13-asset-pipeline.md` §6.14 stage 2 (identity LoRA
  training + stacking) becomes **mandatory for characters**, not optional.
- **Arm C wins:** `13-asset-pipeline.md` §3.5 is **rewritten around
  deterministic character synthesis** — the hard class stops being "the
  class that needs a diffusion model" and becomes "the class this script
  handles," per Arm C's own report: "no diffusion model anywhere in the
  generation path."

---

## Recording, once the verdict lands

When Dennie's criterion-1/criterion-2 verdicts are given, a follow-up card
should: fill the PENDING cells above with the actual verdict (attributed,
dated); apply the resulting `13-asset-pipeline.md` edit from the matching
bullet above; and append a closing addendum to `docs/decision-log.md` DL-22
(see that entry — status `PENDING`, the same status as this record) marking
it **decided**. Per this repo's own conduct rule, that transition is not
something an implementer or reviewer agent performs on its own — a PASS
verdict here would still only move this card to `review`, never `done`, and
closing DL-22 is a documentation edit a human's own sign-off drives, not an
automation step.
