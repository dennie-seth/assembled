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
appended its own section there — see "Cost" below for the consolidated
figures).
**Committed reference character:** `assets/final/character/player_idle_sheet_reference.png`
(+ `.provenance.json`) — Arm C's sheet, promoted byte-for-byte, at a stable
path for [T-0235](T-0235) to consume.

---

## Status: **Decided** — Arm C ships as the round-2 shipping fallback

Per-arm criterion-1 (silhouette readable @ 40px in motion) verdicts for the
three round-2 arms that ran are recorded **PENDING** below — requested from
Dennie Seth, not yet given — but they are **not load-bearing** for this
outcome. See "Why criterion 1 does not gate this decision."

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

## What round 2 produced

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

## Why criterion 1 does not gate this decision

DL-21's decision rule requires an arm to pass criterion 1 (human silhouette
read) before anything downstream can decide in its favor. **That ordering
does not matter here**, because criterion 1 is only ever load-bearing for an
arm that could otherwise win, and none of the round-2 arms clear criterion
2's *benchmark* half regardless of their own criterion-1 read: an arm that
cannot beat 0.072–0.112 cannot win under §24.3's rule even with a criterion-1
PASS. This is the same non-load-bearing treatment DL-22 gave Arm A's own
criterion-1 cell in round 1 (Arm A was already closed on criterion 3, so its
criterion-1 read was recorded PENDING for completeness, not because it was
decisive) — applied here to all three round-2 arms for the identical reason.

| Verdict | §24-b (T-0249) | §24-c (T-0250) | §24-e (T-0252) |
|---|---|---|---|
| Criterion 1 — silhouette readable @ 40px in motion | **PENDING** (not load-bearing — see above) | **PENDING** (not load-bearing) | **PENDING** (not load-bearing) |
| Attributed to | Dennie Seth | Dennie Seth | Dennie Seth |
| Date recorded | 2026-08-30 (requested; not yet given) | 2026-08-30 (requested; not yet given) | 2026-08-30 (requested; not yet given) |

Review `round2_comparison_T0255.webp` (attached to this card) and confirm or
override, per arm — the same two questions DL-21 asks: is it a person, which
way is it facing, what is it doing? Each arm's own self-assessment (recorded
in its own report) is not a substitute for the independent human read; it is
noted for reference only, not counted as the verdict, and does not change
this card's outcome either way.

**Arm C's own criterion-1 read is not reopened here.** DL-23 already recorded
@DennieSeth's authorship-grounds override as the human sign-off DL-21
required, closing that question for Arm C specifically — this card does not
re-litigate it.

## Decision

**Arm C is designated the round-2 shipping fallback**, per §24.3's own
pre-registered contingency: "if no round-2 arm beats 0.072–0.112, that is a
valid outcome: designate Arm C and say so plainly. Do not manufacture a
round-2 winner." This is exactly that outcome, reached honestly — the
generative path was pursued in good faith across three independently-run
mechanisms (per-frame pose authority, img2img chaining with two rounds of
human-directed fixes, and a hybrid SDXL-plus-script approach) plus a
diagnostic re-run of the identity LoRA alone, and none closed the gap to Arm
C's own hand-authored frame-delta result. §24's generative path did not clear
the benchmark; that closes round 2 honestly and is not a failure of this
card.

Arm C's committed sheet (`player_idle_sheet_arm_c_T0230.png`) is promoted,
byte-for-byte unchanged, to a stable reference path —
`assets/final/character/player_idle_sheet_reference.png` — so [T-0235](T-0235)'s
in-engine proof can consume one fixed name rather than tracking which arm
won. Provenance carries forward unchanged and stays P-7-compliant:
`generator` resolves to `assets/src/character/gen_arm_c_idle_T0230.py` (a
committed repo path), `model_hash` is non-null (the sha256 of the committed
generator source, since this arm has no checkpoint), and `concept_hash`
resolves to T-0209's approved concept sheet.

## Numbering / closure note

DL-22's `PENDING` status was already closed **procedurally** by DL-23 — the
override itself served as the human sign-off DL-21 required. What DL-23
explicitly did **not** supply is round 2's actual result: its own "Consequence
for round 2" language (carried from `ROUND2_ANIMATEDIFF_CAPABILITY_REPORT_T0251.md`)
states the open question is "whether any of [the round-2 arms] together beat
Arm C's 0.072–0.112 bar — none has, individually, as of [that] card." **This
entry (DL-24) is that substantive result** — the record DL-22's `PENDING`
status was originally about, not a second closure of the same procedural
question DL-23 already answered.

## Cost (recorded, not deciding — per the round-2 override, §24.3)

| Card | Handle | GPU-min | Wall-clock | $ |
|---|---|---|---|---|
| T-0248 | §24-a | 117.9 | 02:02 | $0.00 |
| T-0249 | §24-b | 31.8 | 01:04 | $0.00 |
| T-0250 | §24-c | 87.8 | 01:28 | $0.00 |
| T-0251 | §24-d | 0.0 | 00:04 | $0.00 |
| T-0252 | §24-e | 3.70 | 00:07 (+ CPU-only cutout reprocess) | $0.00 |
| T-0230 | benchmark (round 1) | 0.0 | 00:14 | $0.00 |

Copied verbatim from each card's own "Cost" section / `BAKEOFF_COST_TABLE_T0231.md`'s
round-2 rows — see that file for the full per-attempt breakdown and notes.
Per the round-2 override, cost is recorded for the record and does not decide
this outcome: even the cheapest round-2 arm (§24-d, $0 because it never
generated) does not change which arm beat the benchmark, because none did.

## `docs/design/13-asset-pipeline.md` §3.5, applied

Per DL-22/DL-23's deferred edit: §3.5 is updated (this card) to record that
round 2 — four independent attempts at the generative path (identity retrain,
per-frame pose authority, img2img chaining, and a hybrid SDXL-plus-script
approach), pursued in good faith on @DennieSeth's own authorship-grounds
override — **confirmed** round 1's result rather than overturning it:
deterministic character synthesis remains what handles the hard class. See
the doc edit itself for the exact wording.

## Attachment note

This record, the comparison webp, and the frame-delta report are attached to
this card via the board's attachments API, per `.claude/rules/assets.md` and
`.claude/rules/conduct.md` — committing to the repo makes them reproducible,
attaching makes them visible on the ticket without checking out the branch.
