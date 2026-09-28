# T-0337 evidence — SAM3 cutout integration attempted; Oklab flood stays primary

## Status: honest negative result — SAM3 is wired and was exercised end-to-end against a real
## Tier-1 sheet, but no node on the live ComfyUI host can currently produce a usable SAM3 model.
## Per the card's own escape hatch ("If SAM3 cannot segment the parts cleanly, ... the Oklab path
## stays primary — an honest negative result is a pass for this card"), this is reported as a
## finding, not fixed by re-tuning anything.

## What the card asked for, and what actually happened

The card's premise, verified 2026-09-09: `SAM3_Detect`, `SAM3_VideoTrack`, `SAM3_TrackPreview`,
`SAM3_TrackToMask` are registered on the live ComfyUI host (`172.18.192.1:8188`). **That premise is
correct** — re-verified live on 2026-09-28 (`GET /object_info/SAM3_Detect` and the other three all
resolve). What the card's premise did not anticipate: **no node anywhere in that same host's
`/object_info` registry can produce the `MODEL`-typed object `SAM3_Detect` requires as its own
`model` input.** `python_module: "comfy_extras.nodes_sam3"` accounts for exactly those four node
types and nothing else — no loader. `GET /models/detection` (the model-folder type a SAM3
checkpoint would live in; ComfyUI's `/models` endpoint lists `"detection"` as a registered folder
type, but no `"sam3"`-named folder type exists at all) returns `[]` — empty. SAM3's *processing*
nodes shipped; its *model-loading* path did not.

## Decisive live-host evidence (not a static-analysis guess)

Three real HTTP round-trips against the live host, in order:

1. **`GET /object_info` full dump**, filtered to every key containing `sam` (case-insensitive):
   exactly the four `SAM3_*` node types plus the unrelated `Sampler*`/`ModelSampling*` family — no
   loader. `GET /models` lists `"detection"` as a registered folder type; `GET /models/detection`
   returns `[]`. `GET /models/custom_nodes` shows only `ComfyUI_IPAdapter_plus` installed — the
   SAM3 nodes are core ComfyUI (`comfy_extras`), not a custom-node pack that could ship its own
   loader separately.
2. **`probe_sam3_graph.json`** — a minimal `LoadImage -> SAM3_Detect -> MaskToImage -> SaveImage`
   graph, `SAM3_Detect.model` wired from `CheckpointLoaderSimple` (the SDXL checkpoint already on
   the host — type-compatible (`MODEL`) with `SAM3_Detect`'s required input, since ComfyUI's graph
   validator only checks the string type name, not what produced it). Submitted with **no query**
   (no `positive_coords`/`negative_coords`/`conditioning`): ComfyUI reports `execution_success`
   and produces `probe_sam3_mask_output.png` — an all-black, all-zero mask. `SAM3_Detect`'s own
   no-op-if-nothing-to-detect behaviour, not evidence either way.
3. **`probe_sam3_graph_coords.json`** — the same graph, this time with a real query
   (`positive_coords=[{"x": 512, "y": 500}]`, a point on the uploaded T-0351 sheet's own figure).
   This is the decisive result: `execution_error` at node `3` (`SAM3_Detect`) —
   ```
   AttributeError: 'UNetModel' object has no attribute 'forward_segment'
     File "F:\ComfyUI\comfy_extras\nodes_sam3.py", line 187, in execute
       mask_logit = sam3_model.forward_segment(frame, point_inputs=point_inputs)
   ```
   `SAM3_Detect`'s own code expects its `model` input to be a real SAM3 model wrapper exposing
   `forward_segment` — nothing on this host can currently produce one. This is not a segmentation-
   *quality* problem; it is a total inability to construct a runnable graph.

`char_gen/cutout_sam3.py`'s own module docstring records this same finding as the reference a
future run should check first before re-attempting SAM3.

## The measured comparison (acceptance criterion 2)

`gen_master_sheet_cutout_compare_T0337.py` ran the full comparison against **T-0351's own real,
committed attempt-19 six-panel sheet**
(`docs/assets/evidence/T-0351/attempt_19_first_per_panel_reference_run_front_back_neutral_clean_sides_malformed.png`
— a genuine ComfyUI sample, not a synthetic stand-in; T-0351 itself never promoted a compliant
sheet, but attempt 19 is real pixels either way, which is what this card's own comparison needs).
For **every one of the six panels** (front_tpose, back_tpose, side_left_forward,
side_right_forward, side_neutral, legs):

1. `cut_master_sheet_part(..., method="sam3", sam3_runner=<real ComfyUIClient call>)` tried SAM3
   **first** (primary, as wired) — every one of the six real per-panel submissions
   (`T0337_sam3_<panel>`, confirmed against the live host's own `/history`) hit the identical
   `forward_segment` `AttributeError` above and raised `Sam3SegmentationUnavailable`.
2. Each of those six caught exceptions fell back automatically to the unmodified Oklab flood
   (`char_gen.cutout.cutout_foreground_mask`), reusing that panel's own real committed keypoints
   from `pose_rig_master_sheet_T0351.keypoints_for(panel_key)`.

| Panel | Method used | Oklab foreground px (of 1,048,576) | SAM3 foreground px |
|---|---|---|---|
| front_tpose | oklab | 392,045 (37.4%) | unavailable |
| back_tpose | oklab | 410,555 (39.1%) | unavailable |
| side_left_forward | oklab | 415,174 (39.6%) | unavailable |
| side_right_forward | oklab | 299,515 (28.6%) | unavailable |
| side_neutral | oklab | 130,298 (12.4%) | unavailable |
| legs | oklab | 235,408 (22.4%) | unavailable |

Full machine-readable record, including the SAM3-availability probe: `comparison.json`.

Before/after image pairs per panel (before = raw panel crop; after = Oklab's own foreground call,
background painted magenta): `panel_<key>_before.png` / `panel_<key>_oklab_after.png`. The
side_neutral pair is the clearest single example — a true 90-degree profile against a dark,
vignetted background (the sheet's own border spans up to 33x the classification tolerance, which
is why `border_flood_background_mask` logs a loud `UserWarning` on every panel here rather than
silently mis-cutting per T-0315's own "fail loudly" rule) — and the flood correctly isolates the
coat/hood silhouette from it.

**Chroma-key** (the card's named acceptable alternative) was not separately implemented: the
comparison this card actually needs — does SAM3 measurably beat Oklab — already has a decisive
answer (SAM3 cannot run at all on this host), so there was nothing left for a chroma-key arm to
decide between. Oklab remains primary regardless of how a chroma-key arm would have scored.

## Box-descend (acceptance criterion 4)

`char_gen/part_descend.py`'s `box_descend_part` crops to the cutout mask's own bounding box,
BOX-downscales the RGB crop and mask independently to game scale, quantizes to the locked 16-slot
home palette (`assets/final/palette/home_palette.json`, nearest-Oklab, no dithering — the same rule
the sheet-level pipeline already uses), and saves via `sprite_io.save_sprite_sheet`'s existing P-6
indexed-PNG-plus-tRNS contract (Godot's decoder expands that into real/"true" RGBA on load).
Demonstrated on all six panels' real Oklab cutout at 32x64: `panel_<key>_descended_32x64.png` +
`.provenance.json` (P-7-resolvable: `generator` is this card's own committed script, `run_id`
resolves to this board run).

**Important scope note:** these are whole-figure descents, not per-anatomical-limb ones. SAM3 was
meant to supply per-limb masks (an arm, a leg, isolated from the coat/torso); since it cannot run at
all on this host, the only real mask available to descend is Oklab's own whole-figure
foreground/background split — the same granularity the existing sheet-level pipeline already
produces, not the finer-grained result this card was chasing. `box_descend_part` and
`cut_master_sheet_part` are both written generically against *any* boolean mask, so once a fixed
host supplies working per-limb SAM3 masks, the exact same descent code runs against them
unmodified — nothing here is Oklab-specific.

## Host-side fix needed

```host-action-request
host: Windows ComfyUI host (F:\ComfyUI)
action: Install/update whichever node pack or ComfyUI core version provides a SAM3 model LOADER
  node (something producing a MODEL that exposes .forward_segment -- comfy_extras/nodes_sam3.py:187
  is the call site), and download a SAM3 checkpoint into F:\ComfyUI\models\detection\ (the folder
  type GET /models/detection already lists as registered, currently empty). The four processing
  nodes (SAM3_Detect/SAM3_VideoTrack/SAM3_TrackPreview/SAM3_TrackToMask) are already present and
  need no further action once a loader + weights exist.
reason: No tool grant available in this WSL sandbox can install ComfyUI node packs or place model
  weight files on the Windows host's filesystem -- this is host-only, same class of blocker as
  every prior GPU-side fix in this pipeline.
verify: GET http://172.18.192.1:8188/object_info should show a new loader-shaped node (name will
  vary) whose output includes MODEL and whose category/search_aliases mention sam3/segmentation;
  GET http://172.18.192.1:8188/models/detection should return a non-empty file list. Re-run
  assets/src/character/gen_master_sheet_cutout_compare_T0337.py with that loader's class_type wired
  into char_gen.cutout_sam3.build_sam3_part_workflow's model_loader argument (replacing this run's
  placeholder CheckpointLoaderSimple) and confirm method_used flips to "sam3" for at least one panel.
```

## Files in this directory

- `README.md` — this file
- `comparison.json` — full machine-readable SAM3-availability + per-panel comparison record
- `panel_<key>_before.png` / `panel_<key>_oklab_after.png` — before/after per panel (6 panels)
- `panel_<key>_descended_32x64.png` / `.provenance.json` — box-descended demonstration part per panel
- `probe_sam3_graph.json` / `probe_sam3_graph_coords.json` — the two minimal probe graphs submitted
  directly to `/prompt` to establish the finding above
- `probe_sam3_mask_output.png` — the all-zero mask from the no-query probe (context for why the
  *second* probe, with a real query, is the decisive one)
