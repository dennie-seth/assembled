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

## What this means for T-0266's own "end state is a committed sheet" criterion

Neither attempt can be honestly promoted: `promote_attempt` (and this
card's own instruction to leave "the existing gate applies unchanged")
correctly refuses a `mechanical_gate_passed: false` attempt, and this log
is not going to route around that by hand-editing a provenance file or
weakening the gate. `assets/final/character/player_walk_sheet_hybrid.png`
does not exist on this branch, and
`tests/test_player_walk_hybrid_T0259_gate.py` (ported onto this branch RED,
per its own documented RED/GREEN states) stays RED — exactly as its own
docstring says it will until a real passing sheet exists.

What **is** committed and green on this branch: `char_gen.chunked_frames`
(15 tests), the wiring test proving `gen_hybrid_walk_T0259.run_attempt`
actually resumes and completes with no GPU required for the test itself (4
tests), and the two real-generation attempt records above as evidence the
mechanism works against the live host. The remaining gap — getting a walk
sheet that actually passes the frame-consistency gate — is real generation
R&D work for T-0259 to pick up with attempts 3-8, informed by this
diagnosis (most promising next lever: stronger/more specific negative
prompting against named background objects, or a pipeline change that
gives frames a shared background reference instead of independently
inventing one per frame).
