# T-0351 evidence -- Tier-1 master sheet REGEN in limb-separating poses

## Status: blocked at the card's own 5-attempt cap, nothing promoted

All 5 attempts permitted by `check_attempt_cap` (the same ~25-50 GPU-second,
5-attempt budget T-0336 used) were spent. None met the acceptance criteria --
no attempt produced five panels in the specified poses (front T-pose, back
T-pose, side-left-forward, side-right-forward, side-neutral) with a
mid-hip-or-shorter coat and a legible hooded-mask head in every panel. Per
this card's own "Do not... promote it and report... as a blocker" wording
(which applies specifically to a coat-concealment-only defect), and per the
`assets.md` rule that a blocked generation must be written down rather than
silently stopped or faked, nothing is promoted to
`assets/src/character/master_sheets/` and this README records what was
tried and why it fell short.

**This is not a host-only blocker** -- ComfyUI, the GPU, and every model/LoRA
file were reachable and working throughout (each attempt completed in
27-33 GPU-seconds with no errors). This is a **generation-capability finding**:
under this card's fixed recipe (IP-Adapter 0.35 on the unchanged
`concept_crop_box`, no ControlNet, style/identity LoRA weights unchanged --
all pinned by the card, pose asked to be a prompt-only lever), five
independent, individually named whole-figure poses in one image did not
reliably follow from text alone across five systematically varied prompt
strategies.

## The five attempts

| # | Seed | Strategy | Result |
|---|---|---|---|
| 1 | 314159265 | Baseline: "character reference turnaround sheet" framing, five panels in prose, plain mid-hip wording | Two near-duplicate standing figures + small floating garment-callout insets (matches the IP-Adapter conditioning crop's own composition almost exactly). No T-pose, no back view, no side profile. Coat well past mid-hip. |
| 2 | 271828182 | Reframed as "pose reference chart", explicit "single horizontal row" + "five independent full-body poses" wording, added a card-specific negative prompt (duplicate poses, accessory insets, long coat) | Six figures in a two-row grid. Still no T-pose/side-profile pose compliance. Coat still past mid-hip. |
| 3 | 161803398 | Moved pose instructions to the front of the prompt (ahead of costume text) and wrapped each panel clause in ComfyUI's native CLIPTextEncode emphasis syntax (`(text:1.3)`) -- ComfyUI's own stock-node feature, not a custom node, not ControlNet, not an IP-Adapter/LoRA weight change | The mid-hip/bare-thigh clause worked -- every panel's coat came out short, a genuine partial win -- but pose still didn't follow, and the emphasis weighting destabilised unrelated regions: blank/cropped heads, high heels instead of boots, legs isolated into their own cropped row apart from the whole figure. |
| 4 | 141421356 | Raised pose-clause emphasis 1.3 -> 1.5, folded head/footwear wording into the emphasised clauses | Worse in a new way: three panels (not five), arms down (not T-pose/profile), and outright costume drift -- no coat at all, orange goggles instead of the hooded mask, robotic knee braces. Confirms higher emphasis destabilises more than it helps. |
| 5 | 173205080 | Dialled pose emphasis back to 1.3, shortened each clause to bare pose keywords, repeated costume wording unweighted to counter attempt 4's drift | Closest attempt: roughly five figures approximate a single row in the top strip, and several panels show a short/mid-thigh coat. But no attempt shows an actual T-pose (arms horizontal, legs apart) or a true 90-degree side profile with one limb extended forward -- all figures stand with arms at their sides, coat lengths are inconsistent panel to panel, and several heads render as blank white ovals rather than the hooded mask. |

Full prompts, negative prompts, and every other recipe field for each
attempt are in `attempt_<N>_provenance.json` alongside this README (and in
`assets/src/character/ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md`, this card's
own attempt log).

## What stayed constant across all 5 (per the card's own scope)

- 1024x1024, no ControlNet
- style LoRA `soviet_brutalism_style_v1.safetensors` @ 0.70
- identity LoRA `player_identity_v2.safetensors` @ 0.5 (chained)
- IP-Adapter `ip-adapter-plus_sdxl_vit-h.safetensors` @ 0.35
- IP-Adapter conditioned on the same `concept_crop_box = (0, 0, 615, 615)`
  #365 established
- Same hooded-mask-with-visible-eye-lenses head wording as #365's promoted
  attempt

Only the prompt text (and, within the prompt, ComfyUI's native emphasis
syntax on specific clauses) varied between attempts -- pose stayed a
prompt-only lever throughout, per this card's explicit "Do not add
ControlNet, and do not change the LoRA or IP-Adapter weights" instruction.

## Observed pattern

Attempts 1-2 (wording-only changes) reproduced the IP-Adapter conditioning
crop's own composition almost verbatim, regardless of what the text asked
for. Attempts 3-4 (increasing emphasis weight) show that *more* aggressive
textual intervention correlates with *more* instability (blank heads, wrong
footwear, costume drift, leg-only crops) rather than more pose compliance.
The one clause that reliably worked at any weight was the mid-hip/bare-thigh
coat-length instruction (attempts 3 and 5) -- garment silhouette detail is
evidently far more prompt-steerable than whole-body pose is, under this
specific IP-Adapter-heavy recipe.

## Recommendation

Achieving five distinct, individually named whole-figure poses in a single
image, under a fixed IP-Adapter weight and no ControlNet, does not look
achievable through further prompt engineering alone within this card's own
5-attempt budget -- the failure mode did not trend toward compliance as
wording was iterated, it traded one defect for another. A human decision is
needed on how to proceed: e.g. raise the attempt budget for a fresh prompt
strategy, permit a lightweight OpenPose ControlNet pass scoped to this card
only, or split the five poses across five separate single-pose generations
(one IP-Adapter-conditioned txt2img call per pose) composited by script
rather than asked for as one five-panel image.
