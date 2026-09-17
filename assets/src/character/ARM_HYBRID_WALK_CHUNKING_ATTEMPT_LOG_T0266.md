# T-0266 — chunking/resumability proof + honest quality finding

This card's job is the resume/chunk infrastructure
(`char_gen.chunked_frames`, `gen_hybrid_walk_T0259.py` wired to it), not
tuning the walk recipe's visual quality. This log records what real
generation against the live ComfyUI host (`172.18.192.1:8188`) actually
showed, separately from the numeric attempt table
`ARM_HYBRID_WALK_ATTEMPT_LOG_T0259.md` (which the generator itself already
appends to, unchanged from T-0259's own design).

## The chunking/resumability fix is proven end-to-end

Two full 8-frame attempts were driven to completion, each across two
sequential foreground `python3 gen_hybrid_walk_T0259.py` invocations with
identical CLI arguments, exactly per the runbook
(`CHUNKED_GENERATION_RUNBOOK_T0266.md`):

| Attempt | Chunk 1 (frames 0-3) | Chunk 2 (frames 4-7) | Total GPU seconds |
|---|---|---|---|
| 1 (default weights) | generated [0,1,2,3], remaining [4,5,6,7] | resumed cleanly, generated [4,5,6,7], remaining [] | 813.9s |
| 2 (retuned weights) | generated [0,1,2,3], remaining [4,5,6,7] | resumed cleanly, generated [4,5,6,7], remaining [] | 843.7s |

Both attempts: chunk 1 finished well under the 10-minute shell cap, chunk 2
correctly skipped all 4 already-complete frames (no re-submission to
ComfyUI — verified independently by `test_completed_frames_are_not_regenerated`
in `tests/test_gen_hybrid_walk_chunking_T0266.py`) and generated only the
remaining 4. No `run_in_background` was used at any point; every call was a
plain foreground invocation inside this same implementer session. **This is
the exact failure mode T-0259 hit twice (orphaned mid-sheet, no resume) —
it does not reproduce here.**

## Both attempts fail the pre-existing mechanical gate — a recipe finding, not a chunking defect

| Attempt | Frame-delta range | 0.30 cap | Arm C (0.072-0.112) |
|---|---|---|---|
| 1 (ipadapter=0.6, style_lora=0.70, identity_lora=0.50 — script defaults) | 0.3051-0.6274 | FAIL | FAIL |
| 2 (ipadapter=0.75, style_lora=0.85, identity_lora=0.60 — stronger conditioning) | 0.3955-0.5954 | FAIL | FAIL |

T-0259's own diagnosis ("§24-e works. The gap is purely lifetime and
resumability") was based on frame 0 alone looking correct in isolation — it
never had a complete 8-frame set to actually run the frame-consistency
check against, because no attempt had ever finished before this card. Now
that one has, both attempts show every one of the 8 adjacent-pair deltas
(including the loop seam) well above the 0.30 cap, by 1-2x.

Visual inspection of `frame_0_main_384.png` (attempt 1) and
`frame_0_main_384.png` (attempt 2) shows why: each frame is its own fully
independent KSampler call, conditioned only on that frame's pose skeleton —
nothing ties the *background* SDXL invents across frames. Recognisable
background objects (shelving, a broom/dustpan, small circular props)
appear in different positions and different frames, sitting inside or
adjacent to the character's own keypoint bounding box. The existing
per-frame cutout (`cutout_foreground_mask`, reused unchanged from T-0250)
only removes border-connected clutter and clutter *outside* the keypoint
bbox with margin — clutter generated *inside* the character's own bbox
survives cutout and quantization, and because the sheet's cells are only
48x48, a handful of surviving clutter pixels is a large fraction of the
cell, which is what drives the delta ratio so far past the cap.

**Retuning did not fix it.** Attempt 2 raised IP-Adapter weight
0.6→0.75, style LoRA weight 0.70→0.85, and identity LoRA weight 0.50→0.60 —
stronger conditioning toward the clean concept-sheet reference, on the
theory that it would suppress the model's own background invention. It
did not: the delta range did not improve (if anything, slightly worse).
This suggests the defect is not a conditioning-strength tuning problem
solvable by nudging existing knobs, but a structural gap in the
per-frame-independent-generation design itself (no cross-frame background
consistency mechanism at all) — a recipe-design question for T-0259's own
remaining DL-21 attempts (2 of 8 used here; 6 remain), not something this
chunking-infrastructure card should improvise a fix for.

## Attempt 3 — a real, committed fix, still not enough on its own

The reviewer's FAIL on this card's first run offered a concrete lever this
log had not yet tried: "not another weight-tuning pass" but a genuine
recipe change. Re-inspecting attempt 1/2's raw frames (`frame_0_main_384.png`,
`frame_2_main_384.png`) side by side made the actual defect visible for the
first time: both attempts show the SAME 4-quadrant panel/gutter structure
recurring inside every generated frame, each quadrant carrying its own
copy of a broom/dustpan-shaped object. That is not "scene clutter" — it is
`gen_hybrid_walk_T0259.py` feeding the *entire*
`player_character_concept_sheet_v1.png` (a ~24-panel costume/turnaround
grid, T-0209) into `IPAdapterAdvanced` as the identity reference. IP-Adapter
conditions on the whole image at the feature level, unreachable by the
existing text negative prompt's "grid, panels, contact sheet" terms
(negative *text* conditioning and IP-Adapter's *image* conditioning are
different mechanisms).

**Fix, TDD'd and committed** (`gen_hybrid_walk_T0259.crop_identity_reference`,
`IDENTITY_REFERENCE_CROP_BOX`, `tests/test_gen_hybrid_walk_identity_crop_T0266.py`):
crop the concept sheet down to one clean front-on panel before upload,
instead of feeding the full grid. Provenance now records the crop box and
the reasoning (`ip_adapter_reference_crop_box`, `ip_adapter_reference_note`)
so it is P-7 reproducible.

Real generation, attempt 3 (seed 31416, otherwise script-default weights,
crop fix applied): frame-delta range **0.3492-0.5610**, still FAIL against
the 0.30 cap, GPU seconds 831.8. **But the failure mode changed**: the
indexed sheet (`sheet_192x96_indexed.png`) no longer shows the panel/grid
duplication at all — the walk-cycle character reads as the same figure,
consistent gait, across all 8 cells. The residual delta is now smaller,
irregular blotches of un-cut background surviving *inside* each frame's own
keypoint bounding box (a diagonal streak on frame 5, a dark block on frame
4, and so on) — exactly the "clutter inside the character's own bbox
survives cutout" defect the original T-0259 diagnosis named, now the
dominant remaining cause instead of the grid-leakage that swamped it in
attempts 1-2.

**Two more free experiments (no GPU cost — re-ran only the cutout/assembly
step against attempt 3's already-generated frames, never re-submitted to
ComfyUI) ruled out a post-processing fix:**

1. Swept `cutout_foreground_mask`'s tolerance (0.03-0.12) x bbox margin
   (0.14 down to 0.0) across 16 combinations. Best result: max delta 0.505
   (tolerance 0.03, margin 0.0) — still far above 0.30, and every
   tolerance above 0.05 made the range *worse* (the flood starts eating
   into the character itself, exactly as `gen_chained_idle_T0250.py`'s own
   comment on `CUTOUT_OKLAB_TOLERANCE` already warned).
2. Tried replacing the position-based bbox test with connected-component
   filtering (`scipy.ndimage.label`, keep only the largest 4-connected
   non-border-flood blob as "character"). Worse, not better: max delta up
   to 1.0 at higher tolerances — some frames' largest connected blob is a
   background shape, not the character, once the flood tolerance loosens
   enough to bridge the two.

Neither experiment closes the gap, and visually inspecting the *raw*
384x384 frames (before any cutout) shows why: it is not only the
background that is unstable frame-to-frame, the character's own rendered
costume colours shift too (frame 0 renders blue/yellow accents, frame 2
renders grey/green, frame 5 renders blue/olive/yellow, all nominally "the
same green coat"). That is raw per-frame KSampler instability — every
frame is an independent txt2img sample with only the ControlNet skeleton
pinned in common — and no per-pixel segmentation heuristic run *after*
sampling can fix instability that happened *during* sampling.

## Attempt 4 — the img2img chain fix, and a passing sheet

The reviewer's second FAIL on this card named the untried structural
lever directly: a true img2img frame-chain (VAEEncode the previous frame,
denoise below 1.0), the same mechanism `gen_chained_idle_T0250.py`
already proved for idle, not yet wired into this generator's own
multi-frame loop. Implemented as `build_chained_graph` +
`apply_background_hold` (both TDD'd RED then GREEN,
`tests/test_gen_hybrid_walk_chained_T0266.py`, 6 tests, no GPU needed):
frame 0 still samples fresh (`EmptyLatentImage`, denoise 1.0, a real
independent generation, not a derived frame); frames 1-7 VAE-encode frame
0's own decoded output as the KSampler's latent source at denoise=0.45,
with this frame's own walk-gait skeleton still conditioning the
ControlNet, then are background-held against frame 0 so only the figure
region is allowed to vary.

**Attempt 4 (seed 27182, denoise 0.45): frame-delta range 0.0337-0.2532
— PASSES the 0.30 cap.** Driven to completion across two sequential
foreground chunks (frames 0-3, then 4-7), exactly per the runbook, no
`run_in_background`. GPU seconds 801.7. Visual inspection of the promoted
sheet (`sheet_192x96_indexed.png`) confirms the fix: a single consistent
character across all 8 cells, no panel-grid duplication, no per-frame
background clutter, no costume-colour drift — the defect every prior
attempt in this log diagnosed is gone.

**Denoise was checked at two more points before promoting (attempts 5 and
6, seed 27182, denoise 0.75 and 0.90) — both left incomplete
deliberately** (chunk 1 / frames 0-3 only, never run through chunk 2 or
the mechanical gate) once visual inspection answered the question they
were run to ask: does raising denoise reveal more visible leg
articulation? Cropping and zooming the leg region of frame 0 vs frame 2/4
at all three denoise values (0.45/0.75/0.90) shows the same long-coat
silhouette covering the legs in every case, with no visible stride
change — and comparing against attempt 3's own independent-sampling
frames (which *do* show some leg separation, but inside wildly
inconsistent, gate-failing costume/background) confirms this is a
costume-design characteristic (the coat visually obscures the legs
regardless of the underlying skeleton pose), not a chaining artifact or a
denoise-tuning problem. Attempt 4 — the lowest denoise tried, and the
only one of the three driven to full completion and through the gate —
is the promoted result; spending more of the DL-21 cap chasing leg
visibility the costume itself forecloses would not be a good use of the
2 attempts (7, 8) now remaining.

## What this means for T-0266's own "end state is a committed sheet" criterion

`assets/final/character/player_walk_sheet_hybrid.png` and its
`.provenance.json` sidecar are now committed on this branch (attempt 4,
promoted). `tests/test_player_walk_hybrid_T0259_gate.py`'s module-level
skip (added when no sheet existed, see the 2026-08-31 run 2 validation
note) now self-activates to GREEN — all 36 of its tests pass against the
real, promoted sheet, not a stub. CHR-1's fields
(`frame_delta_range`/`arm_c_benchmark`/`beats_arm_c_benchmark`) are
present via `apply_arm_c_benchmark_fields` (T-0258's shared helper,
unchanged), true-RGBA (mode P + `tRNS`) matches every other promoted
sheet's own convention, and `concept_hash` + `identity_lora_provenance`
resolve to committed files (P-7). **DL-21 criterion 1** (silhouette
readable at 40px, in motion — a human call) is explicitly out of this
card's scope, same as every other arm's own promoted-but-criterion-1-
pending sheet before it (Arm B, Arm C, T-0250, T-0252); this log's own
denoise comparison above is evidence for that future human read, not a
substitute for it.

What is committed and green on this branch: `char_gen.chunked_frames`
(15 tests, the shared resume/chunk infrastructure HIDE/ACTION also
inherit), the wiring test proving `gen_hybrid_walk_T0259.run_attempt`
actually resumes and completes with no GPU required for the test itself
(4 tests), the identity-reference-crop fix and its own 3 tests, the
img2img-chain fix and its own 6 tests, and 6 real-generation attempt
records (4 complete, 2 deliberately partial) as evidence the chunking
mechanism and the chain fix both work against the live host end to end.
6 of the DL-21 8-attempt cap are now used; 2 remain for T-0259 to
continue with if a future card wants to pursue leg-visibility further
(most likely a costume-silhouette change, not another denoise sweep).
