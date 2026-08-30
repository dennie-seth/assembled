# T-0255 — Round-2 decision record (HANDOFF §24, handle §24-f)

**Author:** Claude (Sonnet 5)
**Card:** T-0255 — the deciding run of round 2 of the T-0227 character-pipeline
bake-off (`docs/decision-log.md` DL-21, DL-23, this card's own DL-24).
**Comparison artefact:** `assets/final/character/round2_comparison_T0255.webp`
(Arm C plus all three round-2 arms that ran, each already rendered at 40px,
in motion, inside the T-0192 blockout-room mockup — DL-21's judging
conditions, unchanged for round 2 per DL-23 — composited into one lossless
animated WebP by `char_gen.round2_compare.build_comparison_frames`).
**Frame-delta gate report:** `assets/final/character/round2_frame_delta_report_T0255.json`
(DL-21 criterion 2's mechanical gate, independently re-run against each arm's
own committed sheet for this card, reported against **both** the 0.30 cap and
Arm C's 0.072–0.112 benchmark).
**Cost table:** `BAKEOFF_COST_TABLE_T0231.md` (each round-2 card already
appended its own section there) plus the consolidated table under "Cost"
below, including the attempts-to-first-pass column DL-21's §23-c template
requires.

---

## Status: **PENDING** — parked for Dennie's verdict, not decided here

Per this card's own human-in-the-loop note: criterion 1 (silhouette readable
at 40px in motion) is a **human pass/fail call** under DL-21, unchanged for
round 2 per DL-23, not something an implementer agent is entitled to answer
on the panel's behalf — for the round-2 arms *or* for Arm C. Arm C's own
criterion-1 read was never actually given a human sign-off in round 1 either:
DL-22 recorded it PENDING, and DL-23's authorship-grounds override answered
a different question (whether cost decides) — it did not supply the
criterion-1 read DL-21 still requires before any arm, Arm C included, can be
designated a winner or a fallback. Everything mechanical §24.3's own
pre-registered rule can settle without a human is settled below. What is
still open is recorded as **PENDING**, attributed to **Dennie Seth**, not
invented — the same treatment T-0231/DL-22 gave the identical shape in round
1, even though that card's own mechanical evidence was just as one-sided.

---

## Shared base, stated explicitly (acceptance requirement)

**Every arm compared below runs on §24-a's single-canonical-costume identity
LoRA, `player_identity_v2` (T-0248).** This is the shared base, not a
variable — restated here so the comparison is not confounded by the training
set. Pose authority (T-0249), chained img2img (T-0250) and hybrid (T-0252)
each pin this mechanically in their own gate suite (`test_identity_lora_is_v2`
or equivalent); Arm C (T-0230, the benchmark) predates the identity LoRA
entirely and needs no LoRA at all — it is a deterministic script, restated in
its own report as "no diffusion model anywhere in the generation path."

## What is mechanically settled (no human call needed)

| Handle | Card | Approach | Frame-delta (recomputed) | Clears 0.30 cap | Beats Arm C 0.072–0.112 |
|---|---|---|---|---|---|
| §24-a | T-0248 | `player_identity_v2` retrain, Arm B's exact recipe re-run | 0.083–0.273 (best of 3 seeds; 2 of 3 seeds failed outright) | Best seed only | **No** |
| §24-b | T-0249 | Script is the pose authority — per-frame independent generation, script-emitted skeleton | 0.0522–0.2573 | Yes | **No** |
| §24-c | T-0250 | Chained img2img — frame-0 anchor + background hold + per-frame cutout (both fixes applied per two rounds of human review) | 0.0000–0.1763 | Yes | **No** |
| §24-d | T-0251 | AnimateDiff | **Skipped** — see below | n/a | n/a |
| §24-e | T-0252 | Hybrid — one SDXL source frame + Arm C's own deterministic transform | 0.1576–0.1816 | Yes | **No** |
| — | T-0230 | **Arm C (benchmark, round 1)** | 0.072–0.112 | Yes | — (the bar itself) |

§24-a's own re-run (T-0248) is a diagnostic against the shared base, not a
fourth bake-off arm in its own right — its own report and every downstream
round-2 card's own contingency check treat it that way (each of §24-b/c/e
explicitly checked T-0248's result first and confirmed it alone did not
settle round 2). It is included in this table for completeness of the record
since it is part of what "round 2 produced."

**Every arm that ran clears the round-2-unchanged 0.30 pass/fail floor. None
beats Arm C's 0.072–0.112 benchmark** — the bar §24.3 set out to beat, not
merely the gate to clear. This is confirmed by this card's own independent
re-run of `asset_gate.art.check_frame_consistency` against each arm's
committed sheet (`char_gen.round2_compare.compute_frame_deltas`), which
reproduces every arm's own self-reported numbers exactly — see
`round2_frame_delta_report_T0255.json`'s `arms.*.beats_arm_c_benchmark`,
all `false` except the benchmark's own row.

**If Arm C is confirmed on criterion 1, §24.3's own pre-registered
contingency** ("if no round-2 arm beats 0.072–0.112, that is a valid outcome:
designate Arm C") **resolves to Arm C as the round-2 shipping fallback.**
This is the outcome the mechanical evidence currently points to, but it is
not ratified until the sign-off below lands — the same "mechanically
one-sided, still parked" treatment T-0231/DL-22 gave Arm C's own candidacy in
round 1 (cost resolved to Arm C there too, and that card still stayed
PENDING).

## Skipped arm, recorded with evidence (not a missing input)

**§24-d (T-0251, AnimateDiff) stopped before any generation attempt.** A
capability check (5 read-only HTTP queries against the shared ComfyUI host,
no checkpoint load, no sampling) found: zero AnimateDiff/AnimateDiff-Evolved
node types under any of four search patterns; no `animatediff_models`/
`motion_module` folder type registered; both motion-module model routes
returned HTTP 404. There is no mechanism on this host to load a motion module
even if one were downloaded — the custom node pack that implements
AnimateDiff support isn't installed. Installing one is a standing environment
change on a shared host, outside an implementer agent's remit (the same
category `docs/comfyui-setup.md`'s firewall fix flagged as a deliberate human
action). This is a complete, evidence-backed stop per the card's own
instructions — see `ROUND2_ANIMATEDIFF_CAPABILITY_REPORT_T0251.md` and
`T-0251-animatediff-capability-decision.json`.

---

## What is **not** settled here — recorded PENDING

| Verdict | §24-b (T-0249) | §24-c (T-0250) | §24-e (T-0252) | Arm C (T-0230) |
|---|---|---|---|---|
| Criterion 1 — silhouette readable @ 40px in motion | **PENDING** | **PENDING** | **PENDING** | **PENDING** |
| Attributed to | Dennie Seth | Dennie Seth | Dennie Seth | Dennie Seth |
| Date recorded | 2026-08-30 (requested; not yet given) | 2026-08-30 (requested; not yet given) | 2026-08-30 (requested; not yet given) | 2026-08-30 (requested; not yet given) |

Arm C's own criterion-1 row is included here, not skipped, because — unlike
round 1, where a criterion-1 fail would simply hand the win to whichever
other arm passed — round 2 has **no other candidate**: every round-2 arm
already fails to beat the benchmark regardless of its own criterion-1 read,
so Arm C's own criterion-1 read is the one that is actually load-bearing for
this card's outcome. It is not reopening round 1's comparison (DL-23 does not
revisit Arm B vs. Arm C); it is the sign-off DL-21 always required before Arm
C could be designated anything, in either round.

Review `round2_comparison_T0255.webp` (attached to this card) and confirm or
override, per arm — the same two questions DL-21 asks: is it a person, which
way is it facing, what is it doing? Each arm's own self-assessment (recorded
in its own report) is not a substitute for the independent human read; it is
noted for reference only, not counted as the verdict.

---

## What the decision rule resolves to, contingent on that sign-off

- **If Dennie confirms PASS for Arm C on criterion 1:** §24.3's contingency
  resolves to **Arm C designated the round-2 shipping fallback** — this is
  the outcome the mechanical evidence above already points to. The
  round-2 arms' own criterion-1 reads do not change this outcome either way
  (none of them beat the benchmark regardless), but are still worth
  recording for the round-2 record's own completeness.
- **If Dennie fails Arm C on criterion 1:** DL-21's rule is explicit that "a
  fail eliminates the arm — it is out of the bake-off entirely." Since no
  round-2 arm beats the benchmark either, this would leave **no arm
  currently eligible** to ship as the reference character. DL-21/§24.3 do
  not explicitly cover this case — flagged here rather than resolved, per
  §23-b ("reject unsatisfiable acceptance criteria; stop and report rather
  than weakening a test or fabricating a result"); it would need its own
  follow-up card rather than an invented rule here.

## Consequence for `docs/design/13-asset-pipeline.md` §3.5, stated for each outcome above, applied to neither

This card does **not** edit `docs/design/13-asset-pipeline.md`. Making that
edit now, ahead of the sign-off above, would pre-empt the same human call
this record is deliberately leaving open — the same deferral T-0231's own
decision record gave §3.5 while DL-22 was PENDING.

- **If Arm C is confirmed (the outcome the mechanical evidence points to):**
  §3.5 would be updated to record that round 2 — four independent attempts
  at the generative path (identity retrain, per-frame pose authority, img2img
  chaining, and a hybrid SDXL-plus-script approach), pursued in good faith on
  @DennieSeth's own authorship-grounds override — **confirmed** round 1's
  result rather than overturning it: deterministic character synthesis
  remains what handles the player idle state.
- **If Arm C is not confirmed:** no arm is currently eligible to ship (see
  above); §3.5 stands as written pending a follow-up card.

## Numbering / closure note

DL-22's `PENDING` status was already closed **procedurally** by DL-23 — the
override itself served as the human sign-off DL-21 required for whether cost
decides. What DL-23 explicitly did **not** supply is either round 2's actual
result or the still-outstanding criterion-1 sign-off for Arm C itself. This
card's own DL-24 entry records round 2's substantive result and stays
PENDING for the same reason DL-22 did — a criterion-1 human call this card
does not invent.

## Cost (recorded, not deciding — per the round-2 override, §24.3)

| Card | Handle | Attempts-to-first-pass | GPU-min | Wall-clock | $ |
|---|---|---|---|---|---|
| T-0248 | §24-a | 1/3 (generation re-run; diagnostic, not a bake-off arm — see `BAKEOFF_COST_TABLE_T0231.md` for the full per-stage breakdown) | 117.9 | 02:02 | $0.00 |
| T-0249 | §24-b | 3/8 (measured; 5/8 used, incl. 2 incomplete) | 31.8 | 01:04 | $0.00 |
| T-0250 | §24-c | 8/8 (attempt cap exhausted) | 87.8 | 01:28 | $0.00 |
| T-0251 | §24-d | 0 (no generation attempted) | 0.0 | 00:04 | $0.00 |
| T-0252 | §24-e | 6/8 (3 source-frame + 3 sheet-assembly) | 3.70 | 00:07 (+ CPU-only cutout reprocess) | $0.00 |
| T-0230 | benchmark (round 1) | 1/8 | 0.0 | 00:14 | $0.00 |

Attempts-to-first-pass figures are copied from each card's own attempt log /
`BAKEOFF_COST_TABLE_T0231.md`'s own "Attempts" columns; see that file for the
full per-attempt breakdown and notes. Per the round-2 override, cost is
recorded for the record and does not decide this outcome: even the cheapest
round-2 arm (§24-d, $0 because it never generated) does not change which arm
beat the benchmark, because none did.

---

## Recording, once the verdict lands

When Dennie's criterion-1 verdict for Arm C (and, for the record, the
round-2 arms) is given, a follow-up card should: fill the PENDING cells above
with the actual verdict (attributed, dated); apply the resulting
`13-asset-pipeline.md` §3.5 edit from the matching bullet above; promote Arm
C's committed sheet (`player_idle_sheet_arm_c_T0230.png`) byte-for-byte to a
stable reference path with P-7-compliant provenance carried forward; and
append a closing addendum to `docs/decision-log.md` DL-24 (status `PENDING`,
the same status as this record) marking it decided. Per this repo's own
conduct rule, that transition is not something an implementer or reviewer
agent performs on its own — a PASS verdict on that follow-up card would still
only move it to `review`, never `done`, and closing DL-24 is a documentation
edit a human's own sign-off drives, not an automation step.

## Attachment note

This record, the comparison webp, and the frame-delta report are attached to
this card via the board's attachments API, per `.claude/rules/assets.md` and
`.claude/rules/conduct.md` — committing to the repo makes them reproducible,
attaching makes them visible on the ticket without checking out the branch.
