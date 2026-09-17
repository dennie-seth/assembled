# Round-2 AnimateDiff capability report — T-0251 (HANDOFF §24-d)

**Author:** Claude (Sonnet 5)
**Card:** T-0251 — round 2 of the T-0227 character-pipeline bake-off, per
@DennieSeth's authorship override (`BAKEOFF_DECISION_T0231.md` / `docs/decision-log.md`
DL-23) that continues the generative path even though Arm C already passed and was
cheaper. This card tests the one round-2 mechanism purpose-built for temporal
consistency — AnimateDiff, which generates all frames together under shared
temporal-attention rather than coaxing consistency out of seeds and conditioning
after the fact.

## Result

**No usable SDXL motion module is available on the installed ComfyUI host.**
Per this card's own instructions, that is a complete and successful outcome —
the card stops here, with no generation attempt made. See
`T-0251-animatediff-capability-decision.json` for the structured record;
`tests/test_animatediff_capability_T0251.py` gates its shape.

## Contingency check (§24-a / T-0248), done first

Before spending any attempt here, T-0248's outcome was checked per this card's own
instructions. T-0248 retrained the identity LoRA (`player_identity_v2`) on a single
canonical costume and re-ran Arm B's generation against it. Result: **partial
improvement, not a full fix** — the best measured attempt (T-0229's exact promoted
recipe, only the identity LoRA swapped) reached 0.083–0.273 across all 8 transitions,
clearing the 0.30 cap with more margin than v1 (0.097–0.295), but still more than
double Arm C's worst transition (0.112). Two of three tested seeds still **fail**
the 0.30 cap outright (0.068–0.401, 0.068–0.318). T-0248's own report is explicit:
this alone does not render §24-b..§24-e unnecessary. This card therefore proceeds.

## Capability check (performed and recorded before any generation attempt)

Checked against `http://172.18.192.1:8188` — the same ComfyUI 0.29.0 instance,
same RTX 3070 Ti Laptop GPU, that every prior arm (T-0228/T-0229/T-0230/T-0248/
T-0249/T-0250) used. Five independent queries, all via
`node tools/board/scripts/agentCurl.js` (this agent's granted HTTP client):

| Check | Finding |
|---|---|
| `GET /system_stats` | Host reachable, ComfyUI 0.29.0, single CUDA device. |
| `GET /object_info`, searched for `Anim*`/`Motion*`/`ADE_*`/`*Diff*` node-type names | **Zero** AnimateDiff / AnimateDiff-Evolved node types under any of the four patterns. Only unrelated hits (`SaveAnimatedWEBP`/`PNG`, `WanAnimateToVideo`, `MeshyAnimateModelNode`, `KlingMotionControl` — a commercial cloud video node, not a local motion module) plus one incidental tooltip mention of "AnimateDiff" as a comparison example in an unrelated node's docstring. |
| `GET /models` (registered folder-type list) | 27 folder types registered; no `animatediff_models` or `motion_module` type — the type the AnimateDiff-Evolved custom node pack itself registers on install. This confirms the *node pack* is absent, not merely that a models folder is empty. |
| `GET /models/animatediff_models`, `GET /models/motion_module` | HTTP 404 for both — the routes don't exist. |
| `GET /models/checkpoints`, `/models/loras`, `/models/diffusion_models` | Only the already-known project checkpoint (`sd_xl_base_1.0.safetensors`) and LoRAs (`player_identity_v1/v2`, `soviet_brutalism_style_v1`, a v2 checkpoint-demo file). `diffusion_models` empty. No motion-module weight file anywhere. |

**Conclusion:** there is no mechanism on this host to load a motion module even if
one were downloaded — the custom node extension that implements AnimateDiff support
at all isn't installed. Obtaining one would mean (1) installing a new custom node
pack on the shared Windows ComfyUI host — a standing environment change in the same
category `docs/comfyui-setup.md`'s firewall fix flagged as a deliberate human action,
not something an implementer agent does unattended to manufacture a pass for its own
card — and (2) fetching a motion module that, per its own upstream authors, is
released as an early, explicitly-labelled **beta** for SDXL specifically, with
materially lower motion quality than the mature SD1.5 modules (this detail is
carried from this agent's own training-time knowledge, not independently
re-verified by a live fetch — the assets agent role has no WebFetch/WebSearch grant,
only the scoped ComfyUI HTTP client, and is flagged as such rather than stated as
freshly-confirmed fact). Neither step is asked for by this card, and both are exactly
the kind of forcing its own instructions rule out.

## Decision

**STOP**, per this card's own acceptance criteria. No generation attempt was made.
The character pipeline stays on SDXL — no switch to SD1.5 was made or considered
as a way to manufacture a pass; `pipeline_model_switched_to_sd1_5: false` is recorded
explicitly in the decision JSON, not merely left absent. Nothing about T-0248's,
T-0249's, or T-0250's committed work, or Arm C's 0.072–0.112 benchmark, is touched
by this finding.

## Cost (recorded, not deciding — §24.3)

| Stage | Attempts | GPU-min | Wall-clock | $ |
|---|---|---|---|---|
| Capability check (5 read-only HTTP queries, no checkpoint load, no sampling) | 0 | 0.0 | 00:04 | $0.00 |

This is the entire cost of the card. No frame-delta measurement, no judging-condition
render, and no provenance entry apply — nothing was generated. The judging conditions
(40px, in motion, inside the T-0192 blockout room) are recorded in the decision JSON
as not-applicable for the same reason, so their absence here isn't mistaken for an
oversight.

## Consequence for round 2

This closes the AnimateDiff branch of round 2 (§24-d) on evidence, not by default.
The remaining open question for round 2's synthesis (§24-e or a closing DL entry) is
whether any of §24-a (partial improvement, best 0.083–0.273, still fails 2 of 3
seeds), §24-b (pose-authority, 0.0522–0.2573, clears the 0.30 cap but does not beat
Arm C), §24-c (chained img2img, `ROUND2_CHAINED_REPORT_T0250.md`: clears the 0.30 cap,
max 0.1763, does not beat Arm C's 0.112), or this card (not viable at all) together
beat Arm C's 0.072–0.112 bar — none has, individually, as of this card.
