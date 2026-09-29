# T-0337 evidence — SAM3 wired and running; panel/part-aware prompts, six clean real masks

## Status: [FIX ROUND 2] The FIX ROUND 1 comparison below queried every panel — including the

## legs-only panel — with one fixed point on that panel's NECK keypoint. The review correctly
## found that invalid for `legs` (whose NECK is a collapsed placeholder, not real anatomy) and
## insufficient for the five whole-figure panels (a T-pose spreads both arms/legs well clear of
## the torso; one torso point does not reliably grow to the whole figure). This round replaces
## that single-point query with `panel_prompt_points` — a bounded, one-configuration-per-panel
## set of positive points derived from each panel's own real joints (thigh/lower_leg/boot for
## `legs`; neck+both-wrist+both-ankle for the other five) plus four corner negatives — and
## re-ran the live six-panel comparison. **All six panels now produce a non-degenerate SAM3
## mask** (`is_degenerate_mask_fraction` false on every one), including `legs`, which is the
## case the card has named explicitly from the start: it now cleanly isolates both thighs and
## lower legs with no coat/torso bleed. The withdrawn single-neck-point run's own results are
## archived, not deleted, under `initial_single_point_experiment/` — see that finding was a
## query-strategy defect, not a SAM3 segmentation-capability limitation.

## What changed since the prior (withdrawn) verdict

An earlier version of this evidence concluded SAM3 could not run on this host at all —
`GET /models/detection` was empty and no loader could satisfy `SAM3_Detect`'s `model` input. That
diagnosis was **wrong**: `models/detection` was never the right place to look. ComfyUI's generic
`UNETLoader` (`F:\ComfyUI\nodes.py:966-989`) loads from the `diffusion_models` folder via
`comfy.sd.load_diffusion_model`, and `comfy/model_detection.py:1060-1066` /
`comfy/supported_models.py:2255-2302` already recognise SAM3/SAM3.1 checkpoints there. The real
prerequisite was never a missing loader — it was **weights in `diffusion_models`**, and as of this
round they are installed:

- **File:** `sam3.1_multiplex_fp16.safetensors` (`F:\ComfyUI\models\diffusion_models\`)
- **Source:** `Comfy-Org/sam3.1` (official Comfy-Org repackage, commit `7bb83747`, not gated),
  1,745,546,848 bytes
- **sha256:** `9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03`
- **Classifies as SAM31:** all three `model_detection.py` gates present in the state dict —
  `detector.backbone.vision_backbone.trunk.blocks.0.attn.qkv.weight` `[3072, 1024]`,
  `detector.transformer.decoder.query_embed.weight` `[200, 256]`, and the SAM3.1 upgrade key
  `detector.backbone.vision_backbone.propagation_convs.0.conv_1x1.weight` `[256, 256, 1, 1]`. 1590
  tensors total: `detector.*` 1133, `tracker.*` 457, with 294 under
  `detector.backbone.language_backbone.*`.
- **Registered live:** `GET /object_info/UNETLoader` now lists
  `['sam3.1_multiplex_fp16.safetensors']` in its `unet_name` option list (was empty before).

`char_gen/cutout_sam3.py`'s `evaluate_sam3_availability` now probes exactly that option list —
the location `UNETLoader` actually reads — instead of the never-consulted `models/detection`
folder, and requires a SAM3-*compatible* entry (substring-matched on `"sam3"`), not merely "some
file exists somewhere": an unrelated checkpoint dropped into `diffusion_models` does not flip this
to available.

`gen_master_sheet_cutout_compare_T0337.py`'s `_sam3_model_loader` now builds a real `UNETLoader`
node naming `sam3.1_multiplex_fp16.safetensors` and drives `SAM3_Detect` via the point-prompt
(`positive_coords`) path, which needs only the `MODEL` input (`conditioning`/`bboxes` stay unused).
The old `_PLACEHOLDER_CHECKPOINT` / `CheckpointLoaderSimple` substitution is deleted outright — if
SAM3 had still been unavailable this round, `main()` would report that and perform no comparison at
all, never wire another model in its place.

## [FIX ROUND 2] The measured comparison (acceptance criteria 2, 12, 13, 14) — panel/part-aware prompts, real run, real host, 2026-09-28

`gen_master_sheet_cutout_compare_T0337.py` ran against the same **T-0351 attempt-19 six-panel
sheet** as FIX ROUND 1
(`docs/assets/evidence/T-0351/attempt_19_first_per_panel_reference_run_front_back_neutral_clean_sides_malformed.png`).
This round replaces the single-fixed-neck-point query with `panel_prompt_points` (see
`gen_master_sheet_cutout_compare_T0337.py`) — one deterministic, bounded set of point prompts per
panel, derived from that panel's own real keypoints:

- **`legs`** (the case the ticket names explicitly): the panel's only real anatomy is hip/knee/ankle,
  both sides. Six positive points — one each for **thigh** (`midpoint(HIP, KNEE)`), **lower leg**
  (`midpoint(KNEE, ANKLE)`), and **boot** (`ANKLE` itself), per side — plus four corner negatives and
  a fifth negative on the panel's own collapsed upper-body placeholder point (real pixel coordinates
  on this panel, but never real anatomy, so explicitly suppressed rather than queried).
- **The five whole-figure panels** (`front_tpose`, `back_tpose`, `side_left_forward`,
  `side_right_forward`, `side_neutral`): five positive points — NECK plus both WRIST and both ANKLE
  extremities — spread the query across the whole spread figure instead of relying on one torso
  point, plus four corner negatives.

Every point used is recorded per panel in `panel_{key}_prompts.json` (`{"x", "y", "polarity",
"derivation"}`, one entry per point) and echoed into `comparison.json`'s own `panels[].prompts`
field. This is **one fixed configuration per panel, decided up front** — not a sweep — and no
threshold in `SAM3_Detect` itself (`threshold=0.5`, `refine_iterations=2`, both `build_sam3_part_workflow`'s
own defaults) was tuned to get here.

| Panel | Method used | Oklab px (of 1,048,576) | SAM3 px (round 2) | SAM3 px (round 1, withdrawn) | Degenerate? |
|---|---|---|---|---|---|
| front_tpose | sam3 | 392,045 (37.4%) | 300,221 (28.6%) | 16,777 (1.6%) | No |
| back_tpose | sam3 | 410,555 (39.1%) | 389,238 (37.1%) | 7,467 (0.7%) | No |
| side_left_forward | sam3 | 415,174 (39.6%) | 319,667 (30.5%) | 369,605 (35.3%) | No |
| side_right_forward | sam3 | 299,515 (28.6%) | 381,032 (36.3%) | 418,705 (39.9%) | No |
| side_neutral | sam3 | 130,298 (12.4%) | 157,031 (15.0%) | 214,653 (20.5%) | No |
| legs | sam3 | 235,408 (22.4%) | **173,562 (16.6%)** | 547 (0.05%) | No |

Full machine-readable record, including the SAM3-availability probe and every panel's own
`prompts` list: `comparison.json`. The round-1 column above is reproduced from the archived
`initial_single_point_experiment/comparison.json`, not re-derived.

**`method_used` reads `sam3` for all six panels** because `cut_master_sheet_part`'s fallback only
triggers on `Sam3SegmentationUnavailable` (a submit/execution/fetch failure) — none of the six
submissions raised one this round either. Unlike round 1, this is now also a statement about *mask
quality*: `is_degenerate_mask_fraction` (thresholds `0.03`-`0.55` of the 1024x1024 panel, justified
against round 1's own 0.016/0.007/0.0005 failures and Oklab's own observed 0.124-0.396 range) reads
`False` on all six — no panel's SAM3 mask is near-empty or near-full this round.

### Before/after image pairs — what the numbers above actually look like

`panel_{key}_before.png` (raw crop) / `panel_{key}_oklab_after.png` (Oklab's background call painted
magenta) / `panel_{key}_sam3_after.png` (SAM3's, same convention, **this round's panel/part-aware
prompts**), one triple per panel:

- **`front_tpose`** / **`back_tpose`**: no longer a neck/collar sliver — the neck+wrist+ankle
  extremity points give SAM3 enough spread to capture the whole T-pose figure (coat, hood, both
  outstretched arms, both legs), competitive with Oklab's flood on both panels now (300,221 vs
  392,045; 389,238 vs 410,555).
- **`side_left_forward`** and **`side_right_forward`**: still clean, tight full-figure silhouettes
  with no background bleed, same as round 1 — the five-point prompt doesn't regress the panels that
  already worked.
- **`side_neutral`**: still a clean, tight standing silhouette, comparable to round 1 (157,031 vs the
  prior 214,653 — a smaller but still clearly correct figure mask under the richer point set).
- **`legs`** — **the case the ticket named explicitly**: `panel_legs_sam3_after.png` now shows both
  legs cleanly separated from background — trousers, wraps, and boots — with no torso/coat bleed
  (there is no torso in this panel to bleed from) and no stray fragment at the top edge. This is the
  anatomical-part result (thigh/lower_leg/boot, both sides) this card has required from the start;
  the round-1 547px top-edge fragment is now understood as exactly what an invalid collapsed-neck
  query produces, not a SAM3 segmentation-capability limit.

### Reading the result honestly

Every one of the six panels now produces a **non-degenerate, visually correct** SAM3 mask under
panel/part-aware prompting — a materially different picture than round 1's mixed result, which was
itself an artifact of querying every panel (including the anatomically invalid `legs` panel) with the
same single neck point. This round does not claim SAM3 strictly beats Oklab pixel-for-pixel on every
panel (see the table: Oklab is still somewhat larger on `front_tpose`, `side_left_forward`, `legs`,
and somewhat smaller on `back_tpose`, `side_right_forward`, `side_neutral`) — only that, with valid
part-aware prompts, SAM3 is a genuinely usable segmenter on every one of these six panels, including
the legs-only one that the invalid single-point query could never fairly test.

**Chroma-key** (the card's named acceptable alternative) was not separately implemented, unchanged
from round 1's reasoning: with SAM3 now genuinely running and producing clean masks on every panel,
there is nothing a chroma-key arm would additionally decide.

## What happens next — Oklab stays primary in code, unchanged; SAM3 is now backed by clean per-panel evidence

`cut_master_sheet_part`'s default (`method="sam3"`) is unchanged by this round — SAM3 stays wired as
the attempted-first primary path (AC 1), exactly as before FIX ROUND 1 and FIX ROUND 2 both. `char_gen/cutout.py`'s
Oklab flood is untouched by this round too (see "[FIX ROUND 2] Do NOT re-tune the Oklab flood" note
below), its own tests
(`test_cutout_absolute_background_distance_T0315.py`, `test_force_border_background_T0319.py`) still
pass unmodified, and it remains the documented, selectable fallback (`method="oklab"`). No code
change to `cut_master_sheet_part`'s own method-selection logic is made in this round — the
improvement is entirely in the *prompts* handed to SAM3, per the reviewer's own distinction between
"prompt tuning" (permitted) and "re-tuning the Oklab flood" (prohibited).

## [FIX ROUND 2] Do NOT re-tune the Oklab flood

Per the card's standing instruction and the round-2 review's own explicit permission ("choosing
valid SAM3 point prompts is permitted and is not the prohibited tuning"), `char_gen/cutout.py` and
its own tests are untouched by this round — `git diff` against the pre-round-2 head confirms neither
file appears in the diffstat. Only the SAM3 query strategy (`gen_master_sheet_cutout_compare_T0337.py`'s
`panel_prompt_points`) changed.

## Box-descend (acceptance criterion 4)

`char_gen/part_descend.py`'s `box_descend_part` crops to the cutout mask's own bounding box,
BOX-downscales the RGB crop and mask independently to game scale, quantizes to the locked 16-slot
home palette (`assets/final/palette/home_palette.json`, nearest-Oklab, no dithering, **excluding
`BACKGROUND_INDEX` from the foreground candidate slots as of [FIX ROUND 1]** — see the palette-bug
fix below), and saves via `sprite_io.save_sprite_sheet`'s existing P-6 indexed-PNG-plus-tRNS
contract (Godot's decoder expands that into real/"true" RGBA on load). Demonstrated on all six
panels' real cutout at 32x64 — `panel_{key}_descended_32x64.png` + `.provenance.json`
(P-7-resolvable: `generator` is this card's own committed script, `run_id` resolves to this board
run). Each panel now descends **whichever mask `cut_master_sheet_part` actually used** (recorded as
`cutout_method` in that panel's own provenance sidecar) rather than a hard-coded Oklab mask, so the
`front_tpose`/`back_tpose`/`legs` descended parts are honestly small/sliver-shaped in this evidence
set — a faithful record of the SAM3 mask that produced them, not a curated final.

**Important scope note:** each panel still descends to **one** part image — for the five
whole-figure panels that is the whole figure; for `legs` it is both legs together (thigh + lower_leg
+ boot on each side, one combined mask). [FIX ROUND 2] made the *prompt* panel/part-aware (multiple
points targeting the actual anatomy of that panel, instead of one fixed neck point), which is what
let `legs` isolate cleanly from the coat/torso — but it did not split a panel's own mask into
separate per-limb output files (e.g. a `legs` panel producing a standalone thigh-only sprite and a
separate boot-only sprite). `box_descend_part` and `cut_master_sheet_part` are both written
generically against *any* boolean mask, so a future finer-grained split (per-limb *output files*, not
just per-limb *prompts*) runs through the exact same descent code unmodified — that is the
per-pose selection/extraction mechanism T-0416 scopes separately, not this card.

## [FIX ROUND 1] The palette bug — dark foreground erased as transparent

`part_descend.py`'s `_quantize_to_palette` used to choose the nearest palette slot from *every*
slot, including `BACKGROUND_INDEX == 0`, and `box_descend_part` only repaired mask-selected
*background* pixels to index 0 afterward — so any foreground pixel whose colour happened to quantize
nearest to slot 0's own RGB (`#12110e`, the locked palette's darkest slot) was silently
misclassified as background. Because `sprite_io.save_sprite_sheet`'s `tRNS` transparency is
per-INDEX, not per-pixel, every pixel landing on index 0 — foreground included — went fully
transparent on load, which is exactly the coat/boots/mask-erasure failure mode the reviewer's repro
targets. Fixed by excluding `BACKGROUND_INDEX` from the foreground quantization's own candidate
slots (`_quantize_to_palette(..., exclude_indices=(BACKGROUND_INDEX,))`); background pixels are
still forced to `BACKGROUND_INDEX` afterward by the mask, so slot 0 stays reserved for real
background only. Regression tests
(`tests/test_part_descend_T0337.py::TestBoxDescendPartDoesNotEraseDarkForeground`) assert decoded
RGBA alpha end-to-end through `save_sprite_sheet`, not tRNS metadata alone.

## [FIX ROUND 1] Open finding — SAM3 checkpoint license (RESOLVED 2026-09-29)

**RESOLVED 2026-09-29 — the licence was read in full and the checkpoint is now registered.** `sam3.1_multiplex_fp16.safetensors` is an entry in `tools/gen-client-base/config/checkpoint_allowlist.json` with `license_family` `SAM`, and `SAM` is an approved-with-caveat family in `APPROVED_LICENSE_FAMILIES`. The SAM License (Last Updated 2025-11-19) is byte-identical to Meta's own `facebookresearch/sam3/LICENSE`: commercial use is permitted, there is no non-commercial clause, and section 5(a) gives the user ownership of their derivative works, so no claim is made over generated pixels. The caveats are Trade Controls / ITAR-style prohibited end uses, no reverse engineering, research-publication acknowledgement, and redistribution of the weights only under the same Agreement — so the checkpoint stays on the ComfyUI host and is never vendored into this repo. The structural gap the finding also describes — that the hand-built-graph path reaches ComfyUI without ever calling `assert_checkpoint_allowed` — is NOT closed by this and is carded separately. 

The original finding is kept verbatim below as the record of the position at the time.


`sam3.1_multiplex_fp16.safetensors` is **not** in
`tools/gen-client-base/config/checkpoint_allowlist.json`, the file
`gen_client_base.license_allowlist.assert_checkpoint_allowed` reads. This
generation ran via `gen_master_sheet_cutout_compare_T0337.py` calling
`ComfyUIClient.submit()`/`wait_for_completion()` directly against a
hand-built `SAM3_Detect` graph — never through `comfy_client.pipeline.generate()`,
the only call site that actually invokes that hook — so this checkpoint's
license was **never checked** by the enforced gate `.claude/rules/assets.md`
describes. This implementer session has no internet access at all
(`WebSearch`/`WebFetch` both denied session-wide, confirmed via a separate
subagent attempt) and could not confirm `Comfy-Org/sam3.1`'s actual upstream
license (Meta AI's own SAM3/SAM 3.1 terms) to determine whether it is
Apache-2.0/OpenRAIL/CC0/Stability-Community or something more restrictive.
See the `ASSET_PROVENANCE.md` entry for this evidence, which records the
same gap rather than asserting a license this session could not verify. A
human or a future card needs to confirm the real license and either
register it in `checkpoint_allowlist.json` (if approved) or revisit whether
SAM3 can stay wired as primary at all (if not) — this is reported, not
resolved, here.

## [FIX ROUND 1, retry] AC 18 gitleaks scan — historical, superseded by FIX ROUND 2's own AC 18

FIX ROUND 1's own AC 18 required running `~/.local/bin/gitleaks` on that round's head and pasting a
`leaks found:` line; that command was denied session-wide for both the implementer and reviewer
personas across three prior rounds (kept below for the historical record). **FIX ROUND 2's own AC 18
text supersedes this**: it states plainly that *"No agent persona currently holds a grant to execute
`~/.local/bin/gitleaks`. ... satisfy this by keeping new content free of secret-shaped strings and
reporting that honestly — do not claim a scan you could not run."* This session hit the identical
denial (`~/.local/bin/gitleaks detect --source . --redact --no-banner` → "This command requires
approval"), confirming the grant gap is still unchanged, and is reporting that honestly rather than
fabricating a scan result.

What this round adds beyond round 1's own content: the six new `panel_{key}_prompts.json` files
(small integer pixel coordinates plus short derivation strings — no hex/base64/entropy-shaped
tokens), regenerated `panel_{key}_sam3_after.png`/`descended_32x64.png` binaries, this `README.md`'s
prose, and the `initial_single_point_experiment/` archive (a straight copy of already-committed
round-1 content, git-mv'd, introducing no new byte sequences). No new checkpoint hash, API key,
token, or other secret-shaped string is introduced by this round's own commits — the one 64-hex-char
sha256 in this evidence set (`9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03`) was
already committed in round 1 and is unchanged here.

**Original FIX ROUND 1 denial record, for history:** `~/.local/bin/gitleaks detect ...`,
`~/.local/bin/gitleaks version`, and bare `gitleaks version` were all denied with "This command
requires approval"; `.gitleaksignore` carries fingerprints for all three `c41138ad`-anchored
`panel_<key>` findings (the withdrawn placeholder, fixed at source to `panel_{key}`), plus the
orchestrator's own out-of-band `POSE_KEY`/T-0394 entry (`59e302a0`). Adding a Bash grant such as
`Bash(~/.local/bin/gitleaks:*)` to `.claude/agents/assets.md` and `.claude/agents/reviewer.md` would
let a future round actually run the scan instead of reasoning about content by inspection.

## Files in this directory

- `README.md` — this file
- `comparison.json` — full machine-readable SAM3-availability + per-panel comparison record,
  **[FIX ROUND 2]'s panel/part-aware-prompt run** (current)
- `panel_{key}_before.png` — raw panel crop, one per panel (6 panels), unchanged since round 1
- `panel_{key}_oklab_after.png` — Oklab's own background call, unchanged since round 1 (the flood is
  untouched by this card)
- `panel_{key}_sam3_after.png` — SAM3's background call, **[FIX ROUND 2]'s panel/part-aware-prompt
  result** (current; overwrites round 1's own file of the same name — round 1's is archived, see
  below)
- `panel_{key}_prompts.json` — **[FIX ROUND 2], new.** Every point prompt used for that panel:
  `{"x", "y", "polarity", "derivation"}`, one entry per point — positive points derived from the
  panel's own real joints, negative points at the four corners (plus, for `legs`, the panel's own
  collapsed upper-body placeholder point)
- `panel_{key}_descended_32x64.png` / `.provenance.json` — box-descended demonstration part per
  panel, descended from whichever mask `cut_master_sheet_part` actually used — **[FIX ROUND 2]'s
  panel/part-aware-prompt result** (current; round 1's is archived, see below)
- `initial_single_point_experiment/` — **[FIX ROUND 2], new.** The withdrawn round-1
  single-neck-point run's own `panel_{key}_sam3_after.png`, `panel_{key}_descended_32x64.png` +
  `.provenance.json`, and a copy of that run's own `comparison.json` — archived, not deleted, and
  not presented as the anatomical-part result. See that directory's own `README.md`.
- `probe_sam3_graph.json` / `probe_sam3_graph_coords.json` / `probe_sam3_mask_output.png` —
  **historical, superseded.** These are the two minimal probe graphs from the *original, withdrawn*
  round that established the (wrong) "no SAM3 loader exists" diagnosis, submitted directly to
  `/prompt` against a deliberately-wrong `CheckpointLoaderSimple`-loaded SDXL model. Kept for the
  historical record of that diagnosis process; they are not part of any real comparison and must not
  be read as current evidence of anything about SAM3's segmentation quality.
