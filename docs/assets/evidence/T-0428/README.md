# T-0428: head ear-midpoint anchor, arm merged to one shoulder-to-wrist part

Live ComfyUI run (`172.18.192.1:8188`, SAM3 `sam3.1_multiplex_fp16.safetensors`,
registered `SAM`-family checkpoint) against the two side panels
[T-0338](../../../tasks/T-0338.md) needs: `side_right_forward`,
`side_left_forward`. Scope matches the card's own acceptance -- the other
three figure panels (`front_tpose`, `back_tpose`, `side_neutral`) and the
`legs` panel are not re-run here; see `docs/assets/evidence/T-0417/` (legs,
untouched) and `docs/assets/evidence/T-0423/` (all five figure panels,
untouched) for those.

**Headline, stated plainly up front:** the head's own re-anchor (NOSE alone
-> ear-to-ear midpoint) does exactly what it was supposed to do -- the
`head` x `arm` phantom overlap that was the sole blocker on both panels is
genuinely cleared, confirmed below with before/after numbers from the
isolation code's own output. But clearing that overlap does not, on its
own, hand T-0338 a usable head or arm: visual inspection of the resulting
masks (not just their isolation/overlap verdicts) finds **neither forward
head is anatomically a head**, and **neither `arm` mask is anatomically an
arm** -- both are costume details (a chest clasp, a hood streamer) that sat
near the shoulder/wrist anchor points and share the arm's own shoulder-
wrist bounding box by coincidence of geometry, not because the pixels are a
limb. This is reported in full below, per the card's own instruction that
an evidenced limitation is acceptable and a relabel is not.

## 1. The phantom-overlap hypothesis: tested, confirmed on both panels

| panel | pair | overlap BEFORE (T-0427, NOSE anchor) | overlap AFTER (this card, ear-midpoint anchor) | hypothesis |
|---|---|---|---|---|
| `side_right_forward` | `head` x `right_arm` | 0.051949 (tolerance 0.00, **rejected**) | **0.0** (tolerance 0.00, passes) | **confirmed** |
| `side_left_forward` | `head` x `left_arm` | 0.007971 (tolerance 0.00, **rejected**) | **0.0** (tolerance 0.00, passes) | **confirmed** |

Both measured directly from `part_comparison.json`'s own `overlaps` list in
each run (T-0427's committed `docs/assets/evidence/T-0417/part_comparison.json`
for "before"; this card's own `part_comparison.json` in this directory for
"after"). The ear-to-ear midpoint anchor (`_R_EAR`=16, `_L_EAR`=17 on
`pose_rig_master_sheet_T0351`'s COCO-18 layout) sits far enough inside the
skull, away from the forward-extended-arm anchor, that SAM3's own point-
prompt segmentation no longer bleeds across the two regions on either
panel. The fix this card made to `_build_figure_part_specs` works exactly
as diagnosed.

## 2. Per-panel, per-part results

| panel | part | present | isolated (mechanical) | suitability | reason |
|---|---|---|---|---|---|
| `side_right_forward` | `head` | yes | **yes** | **not usable** | mechanically isolated hood/scarf cloth, 10,891px -- no facial features anywhere in the mask (`panel_side_right_forward_part_head_sam3_after.png`) |
| `side_right_forward` | `torso` | yes | yes | partial | an elongated coat-fold strip, not the complete torso/coat silhouette, 110,781px (`panel_side_right_forward_part_torso_sam3_after.png`) |
| `side_right_forward` | `right_arm` | yes | yes | **not usable** | geometric check reports "0.0% beyond its own wrist," but visually this 6,768px mask is the costume's chest clasp/buckle, not a limb (`panel_side_right_forward_part_right_arm_sam3_after.png`) |
| `side_left_forward` | `head` | yes | **no** (degenerate) | **not usable** | 1,811px -- below the 0.002 fraction floor (`PART_DEGENERATE_FRACTION_LOW`), a small bright fabric-fold highlight, not skin or a face (`panel_side_left_forward_part_head_sam3_after.png`) |
| `side_left_forward` | `torso` | yes | yes | adequate | a coherent coat/robe silhouette matching the visible garment, 49,595px |
| `side_left_forward` | `left_arm` | yes | yes | **not usable** | geometric check reports "0.0% beyond its own wrist," but visually this 16,328px mask is a vertical hood/cloak streamer, not the figure's own visibly-extended, gloved arm (`panel_side_left_forward_part_left_arm_sam3_after.png`) |

**`assess_figure_part_suitability_T0428.py`'s own committed report: 6
requested, 5 mechanically isolated, 1 anatomically usable by name
(`side_left_forward/torso` only).** This is a single source of truth, not a
prose correction layered on top of a script that says something different:
`_VISUAL_FINDINGS` (the same override mechanism T-0423 built for `head`/
`torso`, where `beyond_distal_joint_fraction` has no second joint to check
against) now also applies to `arm` parts, so a mask that passes the
geometric "0.0% beyond its own wrist" check but is visually a costume detail
rather than a limb is still reported `usable: False` by the script itself --
see §3 for why that geometric check alone cannot catch this case, and
`tests/test_assess_figure_part_suitability_T0428.py`'s
`TestArmPartsAreAlsoVisuallyJudged` for the regression.

## 3. Why the geometric check alone cannot catch either `arm` mask

`char_gen.part_suitability.beyond_distal_joint_fraction` only answers "how
much of this mask's own pixels lie past the distal joint" -- it has no
notion of whether the mask is shaped like a limb at all. Both side-panel
`arm` masks pass that check (0.0% beyond the wrist) while visually
containing no arm:

- **`side_right_forward/right_arm`**: the source panel shows the figure
  fully enclosed in a cloak with both arms concealed -- there is no visible
  limb silhouette anywhere in the panel, let alone at the rig's own
  shoulder (517, 230) -> wrist (768, 230) span (confirmed by direct
  inspection: the pixels at and around the wrist anchor are plain
  background, past the cloak's own right edge). The region SAM3 actually
  segmented at the shoulder anchor is the costume's chest clasp/buckle, a
  small isolated detail that happens to sit within the shoulder-wrist
  bounding box. **This is not new** -- the committed, pre-this-card
  `docs/assets/evidence/T-0417/panel_side_right_forward_part_right_upper_arm_sam3_after.png`
  shows the identical clasp artifact under the OLD NOSE-anchored,
  upper_arm/lower_arm-split code, so this is a pre-existing characteristic
  of this master sheet panel's artwork, not a regression this card
  introduced.
- **`side_left_forward/left_arm`**: unlike the right panel, this panel's
  artwork DOES show a clearly visible, forward-extended, gloved arm
  holding a strap -- but it is drawn well to the left of where the rig's
  own `L_SHOULDER`/`L_WRIST` keypoints (506, 230) / (256, 230) land (the
  real shoulder in the art sits closer to x=380, and the hand closer to
  x=150-200). Because the part's positive point is placed at the rig's
  keypoint rather than the art's actual joint position, and the negative
  points are placed on sibling parts' own anchors rather than on the real
  arm, SAM3 instead segmented a vertical cloak/hood-streamer fold that
  happened to be nearest the keypoint-derived anchor. This is a
  **keypoint-rig/artwork mismatch**, not a SAM3 or point-selection defect
  this card is scoped to fix -- `pose_rig_master_sheet_T0351.py` is reused
  unmodified per the card's own "What to change" list, and recalibrating
  its keypoints for this panel is a separate, later card's work, not an
  isolation/suitability tolerance this card is permitted to retune.

Both findings are visible directly in the cited `*_sam3_after.png` files --
not inferred from pixel counts.

## 4. What this leaves for T-0338

- **`side_right_forward/torso` and `side_left_forward/torso`** are the only
  parts from this run T-0338 can lean on with any confidence, and even
  `side_right_forward/torso` is flagged partial (coat-fold strip, not the
  full coat) -- carried forward as this run's own fresh visual read, not an
  assumption copied from T-0423.
- **Neither `head` nor either `arm` is consumable by name from this run.**
  The head x arm phantom overlap this card set out to fix is genuinely
  fixed (§1) -- that half of the card's own premise holds -- but the head
  and arm requests themselves do not yet produce parts T-0338 can use on
  these two panels. This is an evidenced limitation of the source artwork
  (fully cloaked forward-right figure, keypoint/art mismatch on the
  forward-left figure), not a defect introduced by this card's structural
  changes, which are otherwise verified correct (see §5).
- The torso's own request, prompts and point derivation are untouched by
  this card, per the card's own "Do not" list -- any further torso work is
  a separate, later card's job, same as stated in the task body.

## 5. Structural changes verified correct, independent of the artwork finding

The artwork-level finding above (§3) does not mean this card's own
structural changes are wrong -- they are independently verified, offline,
no ComfyUI/GPU:

- **`arm` is genuinely one part, not a renamed half.** `PARTS_BY_PANEL`
  carries no `upper_arm`/`lower_arm` entry for any figure panel
  (`tests/test_gen_master_sheet_part_cutouts_T0428.py`).
- **The suitability metric is kept and re-pointed to the WRIST**, not
  dropped (`tests/test_assess_figure_part_suitability_T0428.py`,
  `TestArmSuitabilityJudgedAgainstWrist`).
- **Separate `SAM3_Detect` call per part, part-labelled outputs, all-pairs
  overlap rejection** are reused unmodified, with `arm`/`torso` adjacent
  and `head`/`arm` non-adjacent
  (`tests/test_gen_master_sheet_part_cutouts_T0423.py`).
- **A side effect worth recording honestly, and a correction to this
  card's own stated premise:** `side_left_forward/torso`'s own mechanical
  verdict flipped from `isolated: false` to `isolated: true` under this
  card's merged `left_arm`. The committed
  `docs/assets/evidence/T-0417/part_comparison.json` records WHY it was
  `false`: `left_upper_arm` x `torso` overlap of **0.392** (far past the
  0.25 adjacent tolerance) -- not the 0.013228 "fine" figure this card's
  own task body quotes in its "Why the arm re-scope belongs in the same
  card" table. That 0.013228 number traces to T-0427 ROUND 1's torso
  request, which round 1's own follow-up commit (`74c637ee`, "retract
  round 1's false torso wins") explicitly retracted as a reviewer-caught
  false win and replaced with the lateral-point retune that produced the
  0.392 figure actually committed on disk today. So the pre-this-card
  state was NOT "arm is anatomically clean, already separated from torso"
  as the task text's table implies -- it was a genuine, currently-rejected
  39.2% torso overlap. This card's merged `left_arm` measures 0.047
  against torso in this run's own live data (§2), comfortably under
  tolerance -- the arm re-scope fixed a real, measured rejection, not a
  merely anticipated future one. Torso's own visual quality is still
  assessed independently in §2/§4, not inferred from this flip.

## 6. Edge case: `front_tpose/right_upper_arm`, answered by reconstruction, not a live run

The task's own edge-case list names `front_tpose/right_upper_arm` specifically: "the
strongest existing candidate in the set," mechanically isolated at 29,077px with stray
0.0, rejected under T-0423's OLD elbow-bounded check purely for being combined with the
forearm at 46.9% beyond the **elbow**. The edge case requires an answer to whether it
becomes a straightforwardly usable `right_arm` under this card's shoulder->wrist merge --
not a restatement of scope as if the question didn't apply, since `front_tpose` is outside
this card's live-run scope (§ above).

Answering needs no new SAM3 call: T-0417's own committed, untouched
`panel_front_tpose_part_right_upper_arm_mask.png` and
`panel_front_tpose_part_right_lower_arm_mask.png` already exist on disk, and a
shoulder->wrist `right_arm` is exactly their union.
`assess_figure_part_suitability_T0428.front_tpose_right_arm_reconstruction()` reads both
files directly (never writing into T-0417's own directory -- read-only), unions them, and
reruns this card's own WRIST-based suitability check against them, fully offline, no
ComfyUI, no GPU:

| source | mask px | beyond wrist (WRIST-bounded, this card) | beyond elbow (ELBOW-bounded, T-0423) | overlap with torso | verdict |
|---|---|---|---|---|---|
| `right_upper_arm` ∪ `right_lower_arm` (T-0417, committed) | 29,077 (lower_arm was `present: false`, 0px -- the union is upper_arm alone) | **11.9%** (tolerance 20%, passes) | 46.9% (tolerance 20%, **rejected**) | 0.0% (tolerance 25%, passes) | **usable** |

**The task's own premise holds for this panel too:** the same mask T-0423 rejected under
the old elbow-bounded check for being "the upper arm AND the forearm" is, under this
card's new wrist-bounded check, exactly what T-0338 needs -- a clean shoulder->wrist arm,
separated from the torso, with no overlap. This is a reconstruction from historical data,
not fresh evidence from this run, and is reported as such (`front_tpose_right_arm_reconstruction`'s
own `source` field says so) -- it is not folded into §2's totals, since no live SAM3
request produced it this round. See
`tests/test_assess_figure_part_suitability_T0428.py::TestFrontTposeRightArmReconstruction`
for the offline regression, and the script's own trailing print for a live run of the
same numbers.

## 7. Prerequisites and gates

- SAM3 availability probed and confirmed before both panel runs; no
  `Sam3SegmentationUnavailable` mid-run failure this round.
- The T-0422 thermal gate (`comfy_client.thermal_gate.assert_thermal_gate_open`,
  wired into `ComfyUIClient.submit()`) did not refuse any request this
  round -- no `ThermalGateRefused` to record.
- `sam3.1_multiplex_fp16.safetensors` remains registered in
  `tools/gen-client-base/config/checkpoint_allowlist.json` under the `SAM`
  license family (same resolution as T-0417/T-0423/T-0427's own rows in
  `ASSET_PROVENANCE.md`) -- this card neither re-litigates nor needs to.

## 8. Evidence directory separation (T-0417 untouched)

`gen_master_sheet_part_cutouts_T0417.EVIDENCE_DIR` now points at this
directory (`docs/assets/evidence/T-0428/`), not T-0417's
(`docs/assets/evidence/T-0417/`) -- see that module's own docstring. This
card's live run only ever wrote files here; `git status` over
`docs/assets/evidence/T-0417/` shows no changes from this card's run.

**Revision note (this round):** an earlier pass of this card made
`assess_figure_part_suitability_T0423.py` depend on
`gen_master_sheet_part_cutouts_T0417.py`'s live `PARTS_BY_PANEL`/
`_FIGURE_PART_SPECS_BY_KEY` globals, which this card's own arm re-scope
mutates in place -- running that script for real then raised `KeyError`
(`right_arm` isn't a key in T-0417's committed `part_comparison.json`,
which is still keyed by `right_upper_arm`/`right_lower_arm`). A reviewer
VALIDATION pass caught that the test covering this only passed because it
monkeypatched `assess_figure_part_suitability_T0423`'s own `gen` reference
back to the historical shape mid-test -- proving the test fixture was
correct, not that the actual script still worked. The real fix:
`assess_figure_part_suitability_T0423.py` now carries its own frozen,
locally-defined copy of the historical figure-panel shape
(`_HISTORICAL_FIGURE_PART_SPECS_BY_KEY`/`_HISTORICAL_PARTS_BY_PANEL`/
`_HISTORICAL_FIGURE_PANEL_KEYS`) instead of reading `gen`'s mutable
globals at all. `.venv/bin/python assess_figure_part_suitability_T0423.py`
now runs for real, unmocked, straight from a shell, and reports 24
requested / 8 mechanically isolated / 5 anatomically usable against
T-0417's own untouched `part_comparison.json` -- no monkeypatching
anywhere. `tests/test_part_suitability_T0423.py`'s
`TestFigurePartSuitabilityReport` and
`tests/test_gen_master_sheet_part_cutouts_T0428.py`'s
`TestT0417DirectoryUnregressed` both now call `compute_report()` directly
with no fixture freezing it. `TestLiveEvidenceReproducesThisCardsOwnResult`
in `tests/test_assess_figure_part_suitability_T0428.py` is this card's own
analogous pin against its own `part_comparison.json` in this directory.

## 9. Demonstration descend geometry

Every `*_descended.png` in this directory is **32x32** -- the evidence
pipeline's own demonstration size
(`box_descend_part(..., target_size=(32, 32), ...)`), unchanged by this
card. This is explicitly not the production 48x48 curated cell
(`docs/design/13-asset-pipeline.md:139`); promoting anything into
`assets/final/` is out of scope here, same as the card's own "Do not" list
states. Each descended PNG's own `.provenance.json` sidecar records
`"target_size": [32, 32]` so the two sizes are never confused later.
