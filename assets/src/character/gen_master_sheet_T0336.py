#!/usr/bin/env python3
"""Tier-1 master-sheet generation (T-0336, docs/decision-log.md DL-30).

Generates ONE master reference sheet per entity, once, at **1024px** -- the
resolution the style LoRA and identity LoRAs were actually trained at
(`asset-pipeline-review-2026-09-09.md`'s own finding: every coherent image in
this repo was sampled at 1008-1152, every incoherent one at 384). Recipe:
style LoRA -> (optional) identity LoRA, chained -> IPAdapterAdvanced on the
approved concept sheet -> KSampler. **No ControlNet, deliberately** -- Tier 2
(a separate card) supplies pose exactly by compositing parts, so nothing
here needs skeleton conditioning, and at 384 ControlNet was already being
overpowered by IP-Adapter + LoRA (review fact 2).

The sheet itself asks the model for three whole-figure turnaround views
(front/side/back) plus separated limb reference parts (upper/lower arm,
upper/lower leg, head, torso/coat) on a flat background, laid out by the
prompt -- Tier 2's compositor consumes the separated parts, not the whole
figure.

Per-script convention this pipeline has kept since Arm A/B (see
`gen_hybrid_walk_T0259.py`'s own module docstring): this script owns its own
`build_graph` and prompt, reusing the checkpoint/LoRA/IP-Adapter identifiers
and HTTP client helpers from `gen_arm_a_idle_T0228.py` via import, never a
shared parametrised generator across cards. Within THIS card, though, the
entity surface (`EntitySpec`, `ENTITIES`) is the thing future enemy cards
extend -- a new `EntitySpec` registered in `ENTITIES` is the only change an
enemy card should ever need; `build_graph`/`run_attempt` stay untouched
(this card's own reuse requirement).

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/character/gen_master_sheet_T0336.py --entity player --attempt 1 --seed 31416
    python3 assets/src/character/gen_master_sheet_T0336.py --entity player --promote-attempt 1

Writes (always, so every attempt is logged whether it is promoted or not):
    assets/out/master_sheet_T0336/<entity>/attempt_<N>/master_sheet_1024.png
    assets/out/master_sheet_T0336/<entity>/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_MASTER_SHEET_ATTEMPT_LOG_T0336.md (appended)

Promotion to assets/src/character/master_sheets/<entity>_master_sheet_T0336.png
(+ .provenance.json) is a separate, explicit step (--promote-attempt). Master
sheets are pipeline inputs, not game-scale finals, so they are committed
under assets/src/ rather than assets/final/ (this card's own acceptance
criterion).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reused directly from Arm A (T-0228) -- checkpoint/LoRA/IP-Adapter/
# ControlNet identifiers and the HTTP client helpers are unchanged.
# CONTROLNET_NAME (T-0228's own `controlnet-openpose-sdxl-1.0_xinsir.
# safetensors`) is unused by T-0336's own default call path (no ControlNet,
# DL-30) -- only T-0351's run_five_pose_attempt (2026-09-10 amendment)
# passes it into build_graph.
# T-0351 (2026-09-10 amendment): the authored per-pose OpenPose skeleton
# rig, one keypoint layout per POSE_SPECS entry.
import pose_rig_master_sheet_T0351  # noqa: E402
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
    CONTROLNET_NAME,
    IPADAPTER_NAME,
    IPADAPTER_PRESET,
    LORA_LICENSE,
    LORA_NAME,
    LORA_PATH,
    fetch_save_image,
    sha256_of,
    submit_prompt,
    upload_image,
    wait_for_completion,
)

# Reused directly from the pose-authority round (T-0249) -- the trained
# costume identity LoRA's identifiers, trigger token, and negative baseline.
from gen_pose_authority_idle_T0249 import (  # noqa: E402
    IDENTITY_LORA_NAME,
    IDENTITY_LORA_PATH,
    IDENTITY_LORA_PROVENANCE_PATH,
    MAIN_NEGATIVE,  # noqa: E402
    TRIGGER_TOKEN,
)

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)

# ── Entity parameterisation -- enemy cards add a new EntitySpec here, and
# nowhere else. ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EntitySpec:
    name: str
    concept_sheet_path: Path
    concept_hash: str
    identity_lora_name: str | None
    identity_lora_path: Path | None
    identity_lora_provenance_path: Path | None
    identity_lora_weight: float
    trigger_token: str
    costume_description: str
    # (x, y, width, height) sub-region of the concept sheet to feed IP-Adapter,
    # or None to condition on the whole sheet. Attempts 2-4 (see
    # `build_positive_prompt`'s docstring) drifted from the intended
    # institutional-green costume to a heavier armour-plated one the model
    # kept picking up from -- it turns out the concept sheet itself mixes
    # both costume lines across its panel grid, and IP-Adapter conditions on
    # whatever region it's given. Restricting to the sheet's own clean,
    # single-costume top-left block removes that source of drift instead of
    # just asking the model not to reproduce it.
    concept_crop_box: tuple[int, int, int, int] | None = None
    # name -> (left, top, right, bottom) pixel box, tuned by hand against
    # the entity's own promoted attempt, identifying genuinely-isolated
    # anatomical/garment regions to crop straight out of that one coherent
    # generation and composite onto an extra row below it (see
    # `compose_master_sheet_with_parts`). None skips compositing (an entity
    # with no hand-tuned boxes yet is promoted as a raw copy, unchanged from
    # every attempt before round 5).
    limb_crop_boxes: dict[str, tuple[int, int, int, int]] | None = None


# Attempt 5's own layout (see docs/assets/evidence/T-0336/README.md for the
# crop previews these were picked from): a front-view figure at x:[0,400)
# with a model-drawn isolated head/hood panel at roughly x:[355,545). No
# "upper_leg" key -- the promoted attempt's coat fully conceals the thigh in
# all three views (front/side/back); see the README's own evidence crop
# proving the only visible pixels there are coat lining, not a leg.
PLAYER_LIMB_CROP_BOXES: dict[str, tuple[int, int, int, int]] = {
    "head": (355, 0, 545, 230),
    "upper_arm": (0, 220, 150, 440),
    "lower_arm_hand": (0, 420, 150, 580),
    "torso_coat": (100, 220, 300, 650),
    "lower_leg_boot": (30, 760, 220, 1000),
}

ENTITIES: dict[str, EntitySpec] = {
    "player": EntitySpec(
        name="player",
        concept_sheet_path=CONCEPT_SHEET_PATH,
        concept_hash="4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b",
        identity_lora_name=IDENTITY_LORA_NAME,
        identity_lora_path=IDENTITY_LORA_PATH,
        identity_lora_provenance_path=IDENTITY_LORA_PROVENANCE_PATH,
        identity_lora_weight=0.5,
        trigger_token=TRIGGER_TOKEN,
        costume_description="institutional green coat, hooded, white gloves",
        concept_crop_box=(0, 0, 615, 615),
        limb_crop_boxes=PLAYER_LIMB_CROP_BOXES,
    ),
}


def build_positive_prompt(entity: EntitySpec) -> str:
    """Requests the full Tier-1 sheet: three whole-figure turnaround views
    plus separated limb parts, on a flat background that cuts out cleanly.
    `entity.costume_description` carries the per-entity costume/identity
    text verbatim -- the only thing an enemy card needs to vary.

    Round 1 (a plain "character reference master sheet, ... separated limb
    reference parts" phrasing) produced a coherent, identity-consistent
    sheet but the panel layout stayed a coat-focused turnaround -- IP-Adapter
    conditioning on the T-0209 concept sheet (itself only coat-only and
    whole-figure panels) pulled the panel vocabulary toward that reference's
    own composition regardless of the text's specific per-limb request.
    Framing the ask as an **exploded parts diagram** (a genre with its own
    strong visual convention: a whole-figure view plus physically separated,
    non-overlapping component pieces) round-2 fixed that -- panels genuinely
    isolate the coat, the legs/trousers and the boots as distinct pieces, not
    just repeated whole-figure poses. Round 2 shipped with two defects the
    reviewer caught by opening the file: the whole-figure panels were
    headless (a blank white mannequin head, not a face) and the model drifted
    to a heavier armour-plated costume in the bottom row instead of holding
    the single green-coat identity throughout. Round 3 tried an explicit
    visible-face requirement plus a "rigging reference sheet" framing for
    the limb panels -- the "rigging" word itself turned out to be the
    problem: it reads as mechanical rigging, not figure-drawing rigging, and
    pulled the bottom-row legs toward robotic/mechanical armour instead of
    the intended cloth-and-boot costume, while the hero figure's head still
    came out cropped off the top of frame. Round 4 dropped "rigging" for
    "anatomy reference sheet" and asked for a literal human face -- still
    headless or cropped, and costume drift got *worse* (most panels turned
    cream/white, not green). Opening the concept sheet itself explains both
    failures at once: the reference image's own panel grid mixes the clean
    institutional-green costume (its left columns) with a heavier
    armour-plated variant (its right columns and bottom rows), and shows a
    blank white oval for every single head with no eyes anywhere -- IP-Adapter
    conditions on whatever region of that grid it's given, so no amount of
    positive-prompt wording was ever going to out-compete pixels the model is
    being shown directly. Round 5 fixes the conditioning image itself
    (`EntitySpec.concept_crop_box` in `run_attempt`/`build_graph` restricts
    IP-Adapter to the sheet's own clean, single-costume block instead of the
    whole mixed grid) and, rather than fighting the hood-covered-head design
    with a literal face the source material never shows, asks for a hooded
    mask with visible dark eye lenses -- a head marker consistent with the
    institutional costume's own hood, not a blank void. Returns to round-2's
    proven "exploded parts diagram" framing for the limb panels, since
    rounds 3-4's reframings only made things worse. See
    `ARM_MASTER_SHEET_ATTEMPT_LOG_T0336.md` for the attempts this was
    compared against."""
    return (
        f"{entity.trigger_token}, exploded parts diagram, disassembled equipment "
        f"breakdown sheet, {entity.costume_description}, same uniform and same equipment "
        "loadout, consistent identity, the exact same institutional green coat costume in "
        "every single panel, flat uniform neutral grey background, flat even lighting, no "
        "cast shadow, no perspective, clean readable outline, three whole-figure turnaround "
        "views at the top -- front view, side view, back view -- each figure's head fully "
        "visible in frame, wearing a hooded mask with two dark round visible eye lenses, not "
        "a blank void, and below them separate disassembled equipment pieces laid flat side "
        "by side with empty space between each piece so nothing overlaps or touches: a "
        "severed upper arm sleeve piece by itself, a severed lower arm and glove piece by "
        "itself, a severed upper leg piece by itself, a severed lower leg and boot piece by "
        "itself, a hood and mask head piece with visible eye lenses by itself, a torso and "
        "coat piece by itself, no text, no UI, no watermark"
    )


def build_limb_pose_prompt(entity: EntitySpec) -> str:
    """T-0351: five generation panels (2026-09-10 spec change, @DennieSeth),
    pose is the only variable versus #365 (T-0336) -- same costume/identity
    wording, same hooded-mask head marker, same flat-background/
    no-perspective framing, no ControlNet. #365 used a relaxed turnaround:
    arms hung against the torso and a mid-calf coat closed over the thighs,
    so no cutout could separate `upper_leg` at all, and its own "side view"
    panel came out three-quarter (both arms and both goggle lenses
    visible), not a true profile. A T-pose holds arms and hands clear of
    the body and spreads the legs; two true-side walking panels, one per
    side, each hold only that side's arm and leg extended forward so a
    single visible limb silhouette and a single visible eye lens identify a
    genuine 90-degree profile instead of #365's three-quarter defect. A
    fifth panel -- true side profile, arms down, standing -- is a distinct
    neutral anchor: panels three/four are walking poses (forward-extended
    limbs) and the wrong reference for a standing profile keyframe, which
    is what T-0339 now sources from panel five. The mid-hip coat cap
    (settled 2026-09-10, no longer an open question) keeps the thigh
    exposed in every panel so `upper_leg` stays separable -- #365's own
    coat closed past the thigh and that is exactly the gap this card
    exists to fill. See T-0351's own card body for the full per-panel pose
    table.

    Attempt 1 (seed 314159265, see ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md)
    ignored almost all of this: the IP-Adapter conditioning crop itself
    shows two similar standing figures plus small floating garment-callout
    insets (the same crop `run_attempt`/`EntitySpec.concept_crop_box`
    restricts IP-Adapter to), and that composition dominated over the text.
    Attempt 2 strengthened the wording ("pose reference chart", explicit
    "five independent full-body poses ... in a single horizontal row",
    repeated mid-hip/bare-thigh phrasing) but kept the panel/pose
    instructions after ~120 words of costume/framing text in a single long
    paragraph -- the model reproduced the costume and silhouette faithfully
    (the part nearest the front of the prompt) and still ignored pose
    almost entirely, rendering six figures in a two-row grid.

    Attempt 3 restructured rather than just re-wording: panel/pose
    instructions moved to the very front, ahead of costume text, and each
    panel clause was wrapped in ComfyUI's native CLIPTextEncode emphasis
    syntax (`(text:weight)`, the stock node's own built-in prompt
    weighting -- no custom node, no ControlNet, no LoRA/IP-Adapter weight
    change). Result: the mid-hip/bare-thigh clause worked (every panel's
    coat came out short), a genuine partial win, but pose still didn't
    follow at all, and the emphasis weighting appears to have destabilised
    unrelated regions -- blank/cropped heads, high heels instead of boots,
    legs isolated into their own cropped row apart from the whole figure.

    Attempt 4 kept the front-loaded structure and the coat-length emphasis
    unchanged (it worked), raised the pose-clause weight further (1.3 ->
    1.5) since 1.3 measurably moved the coat but not the pose, and folded
    "head clearly visible" / eye-lens wording directly into each emphasised
    panel clause. Result: pose *still* didn't follow (three panels, arms
    down, not five/T-pose/profile) -- and 1.5 caused outright costume
    drift, the worse failure mode: no coat at all, orange goggles instead
    of the hooded mask, robotic knee braces. Across attempts 1-4, more
    aggressive intervention (chart framing, then emphasis, then higher
    emphasis) tracked with *more* instability, not more pose compliance --
    the coat-length clause is the one lever that ever reliably moved
    anything, at moderate (1.3-1.4) weight.

    Attempt 5 (this card's final attempt under its own 5-attempt cap)
    dials pose-clause emphasis back down to 1.3 and shortens each clause to
    just its core pose keywords (dropping the longer descriptive tail that
    seemed to dilute rather than help), and compensates for attempt 4's
    costume drift by repeating "institutional green coat" and the hooded
    mask description outside the emphasised spans, unweighted, so costume
    identity isn't competing against the pose weight boost. Still no
    ControlNet, no LoRA/IP-Adapter weight change -- pose stays a
    prompt-only lever, per this card's own constraint."""
    pose_clause = (
        "(five separate whole-figure panels in a single horizontal row, each a complete "
        "full-body figure head to toe, wide gaps between panels so nothing overlaps or "
        "touches:1.3), "
        "panel one, (T-pose:1.3), front view, both arms held straight out horizontal to the "
        "sides clear of the torso, legs spread apart, "
        "panel two, (T-pose:1.3), back view, both arms held straight out horizontal to the "
        "sides clear of the torso, legs spread apart, "
        "panel three, (true 90-degree side profile, not a three-quarter view:1.3), only the "
        "left arm and only the left leg extended forward at roughly a right angle clear of "
        "the torso, the right arm and right leg held back close to the body, "
        "panel four, (true 90-degree side profile, not a three-quarter view:1.3), only the "
        "right arm and only the right leg extended forward at roughly a right angle clear of "
        "the torso, the left arm and left leg held back close to the body, "
        "panel five, (true 90-degree side profile, not a three-quarter view:1.3), a neutral "
        "standing pose, both arms hanging straight down at the sides, both legs together "
        "standing upright, "
    )
    coat_clause = (
        f"{entity.costume_description}, institutional green coat, "
        "(the coat cut short and ending precisely at mid-hip in every single panel, bare "
        "thigh clearly visible below the coat hem:1.4), "
    )
    return (
        f"{entity.trigger_token}, {pose_clause}{coat_clause}"
        "same uniform and same equipment loadout, consistent identity, the exact same "
        "institutional green coat costume in every single panel, flat uniform neutral grey "
        "background, flat even lighting, no cast shadow, no perspective, clean readable "
        "outline, wearing a hooded mask with two dark round visible eye lenses, not a blank "
        "void, each figure wears boots, never high heels, no text, no UI, no watermark"
    )


def build_limb_pose_negative_prompt() -> str:
    """T-0351: builds on #365's own negative-prompt fixes
    (`build_negative_prompt` -- blank heads, armour drift, cropped heads,
    robotic legs) and adds this card's own attempt-1/2/3 failure modes (see
    `ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md`): attempt 1 rendered two
    near-duplicate standing figures plus small floating accessory/equipment
    inset panels; attempt 2 rendered six figures in a two-row grid; attempt
    3 (CLIP-emphasis-weighted) rendered blank/cropped heads, high heels
    instead of boots, and legs isolated into their own cropped row apart
    from the whole figure. All three kept a coat well past mid-hip despite
    the positive prompt's mid-hip wording (attempt 3's emphasised mid-hip
    clause was the one thing that did work)."""
    return (
        build_negative_prompt()
        + ", accessory inset, floating accessory panel, equipment close-up inset, small inset "
        "panel, garment callout, two similar poses, duplicate pose, near-identical pose, "
        "repeated pose, only two figures, six figures, six poses, six panels, grid layout, "
        "multiple rows, two rows, stacked panels, long coat, trench coat, ankle-length coat, "
        "floor-length coat, knee-length coat, calf-length coat, coat past the knee, coat "
        "covering the thighs, coat below the hip, high heels, stiletto heels, pumps, "
        "mismatched footwear, isolated leg row, cropped leg row, legs separated from figure, "
        "split composite, legs-only panel"
    )


@dataclass(frozen=True)
class PoseSpec:
    key: str
    label: str
    pose_clause: str
    # Dedicated-legs-panel amendment (2026-09-10): True only for the sixth
    # "legs" panel -- lower body only, trousers and boots, NO COAT. Every
    # other panel keeps the character's canonical long coat unconstrained
    # (see build_single_pose_positive_prompt's docstring for why the
    # mid-hip coat clause that used to live there is gone, not just
    # relaxed).
    no_coat: bool = False
    # Attempt-16 fix (docs/assets/evidence/T-0351/): back_tpose is the one
    # panel where the standard visible-eye-lenses head clause is wrong --
    # it describes the FRONT of the mask, which directly fights this
    # panel's own "back view" pose clause. None means "use the standard
    # front-facing hooded-mask-with-visible-eye-lenses clause every other
    # panel wants"; only back_tpose overrides it.
    head_clause: str | None = None
    # Attempt-16 fix: per-pose negative-prompt terms appended on top of
    # build_single_pose_negative_prompt's shared bans -- back_tpose is the
    # only panel that needs the mask's own visible-eye-lenses/goggles
    # imagery actively suppressed, since every other panel wants it shown.
    negative_extra: str = ""


# T-0351 lever 2 (run-1 reviewer verdict): the five acceptance-criteria
# panels, one per single-pose generation -- see
# `build_single_pose_positive_prompt`'s docstring for why this replaces the
# single-shot five-panel-in-one-image approach `build_limb_pose_prompt`/
# `run_attempt` used for this card's first five attempts. A sixth "legs"
# panel was added by the 2026-09-10 dedicated-legs-panel amendment (see
# `build_legs_panel_positive_prompt`'s docstring).
POSE_SPECS: tuple[PoseSpec, ...] = (
    PoseSpec(
        key="front_tpose",
        label="front T-pose",
        pose_clause=(
            "front view, T-pose, both arms held straight out horizontal to the sides clear "
            "of the torso, legs spread apart"
        ),
    ),
    PoseSpec(
        key="back_tpose",
        label="back T-pose",
        pose_clause=(
            "back view, viewed from directly behind, T-pose, both arms held straight out "
            "horizontal to the sides clear of the torso, legs spread apart"
        ),
        head_clause=(
            "(the back of the hood, back of a hooded mask, hood fabric covering the entire "
            "head from behind, hood drawstrings and back seam visible, no face, no eyes, no "
            "eye lenses, no goggles, nothing of the mask front visible, back of the head "
            "only, viewed from directly behind:1.3)"
        ),
        negative_extra=(
            ", eye lenses, goggles, mask front, mask eyes, visible eyes, front of mask, "
            "face markings, front of hood opening, face, eyes"
        ),
    ),
    PoseSpec(
        key="side_left_forward",
        label="side, left-forward",
        pose_clause=(
            "true 90-degree side profile view, not a three-quarter view, only the left arm "
            "and only the left leg extended forward at roughly a right angle clear of the "
            "torso, the right arm and right leg held back close to the body"
        ),
    ),
    PoseSpec(
        key="side_right_forward",
        label="side, right-forward",
        pose_clause=(
            "true 90-degree side profile view, not a three-quarter view, only the right arm "
            "and only the right leg extended forward at roughly a right angle clear of the "
            "torso, the left arm and left leg held back close to the body"
        ),
    ),
    PoseSpec(
        key="side_neutral",
        label="side, neutral",
        pose_clause=(
            "true 90-degree side profile view, not a three-quarter view, neutral standing "
            "pose, both arms hanging straight down at the sides, both legs together standing "
            "upright"
        ),
    ),
    PoseSpec(
        key="legs",
        label="legs (lower body only, no coat)",
        pose_clause=(
            "front view, standing pose, both arms hanging straight down at the sides, legs "
            "apart, weight evenly balanced"
        ),
        no_coat=True,
    ),
)


def build_single_pose_positive_prompt(entity: EntitySpec, pose: PoseSpec) -> str:
    """T-0351 lever 2 (reviewer verdict, run 1): five attempts asking one
    1024 generation for five distinct whole-figure panels in a single row
    never achieved pose compliance (see ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md,
    docs/assets/evidence/T-0351/README.md). The reviewer traced the actual
    root cause: `build_limb_pose_negative_prompt` builds on
    `build_negative_prompt`, which builds on `MAIN_NEGATIVE` (T-0249) --
    and MAIN_NEGATIVE forbids "grid, panels, contact sheet, multiple
    frames" and "two figures, duplicate figure, ... group of people", the
    exact thing "five separate whole-figure panels in a single horizontal
    row" asks for. No amount of positive-prompt weighting was ever going to
    out-compete the negative prompt fighting it on every sampling step.

    Rather than hand-carving MAIN_NEGATIVE down to keep only the clauses
    this card wants (fragile -- a future change to MAIN_NEGATIVE could
    silently reintroduce the conflict), this generates ONE pose per
    KSampler call instead: a single full-body figure, no panel/grid
    language at all, so MAIN_NEGATIVE's anti-multi-figure/anti-panel
    clauses are exactly what this generation wants, not something fighting
    it. `compose_pose_row` stitches the five resulting 1024x1024 images
    into one sheet afterward, by script (DL-30 sanctions script arrangement
    of diffusion-sampled pixels) -- this is also this card's own standing
    guardrail: "motion composited by script." Same costume/mid-hip/
    hooded-mask wording as #365 and this card's own first five attempts;
    pose framing is the only thing that changed.

    Attempt 6 (seed 223606797, see ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md and
    docs/assets/evidence/T-0351/README.md) ran exactly this prompt and
    still failed, in a new way: all five generations came back as a
    multi-inset fashion tech-pack/reference-sheet composition (a hero
    figure plus several small callout panels), arms down in every panel,
    coat past mid-hip in most, and stray illegible pseudo-text despite this
    prompt's own "no text, no UI, no watermark" tail. Since this generation
    had no panel/grid language anywhere in its prompt or a conflicting
    negative clause to fight, this rules out the negative-prompt conflict
    as the *sole* cause -- IP-Adapter conditioning on the concept crop
    (unchanged, 0.35 weight, per this card's frozen recipe) appears to
    assert compositional structure directly, and a plain, unemphasized
    affirmative sentence did not outcompete it.

    Attempt 7 makes two changes, still prompt-only (no ControlNet, no
    LoRA/IP-Adapter weight change): (1) drops the redundant "no text, no
    UI, no watermark" tail -- negating a concept in the *positive* prompt
    is a known anti-pattern (CLIP has no real negation, so naming "text"
    can reinforce rather than suppress it), and MAIN_NEGATIVE already bans
    "text, watermark" where such a ban belongs; (2) applies ComfyUI's
    native CLIPTextEncode `(text:weight)` emphasis -- the one technique
    that reliably moved something across attempts 1-5 (the mid-hip coat
    clause) -- to both the isolation clause and the pose clause itself,
    neither of which was ever emphasized under lever 1 or attempt 6.

    Attempt 8 (first ControlNet execution, 2026-09-10 amendment; see
    ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md) proved the skeleton forces real
    T-pose/profile geometry in 4 of 5 panels with zero pose-text help --
    but every coat came back mid-calf-or-longer, worse than attempts 3/5's
    plain-1.3-coat-only *prompt-only* result, and side_right_forward
    regressed to a three-figure composition. The pose clause's own CLIP
    emphasis is dropped here (ControlNet is the pose lever now).

    Attempt 9 raised isolation to 1.4 and coat-length to 1.6, reframed as
    a "cropped ... jacket" -- and regressed badly: identity drift away
    from the hooded-mask costume in 4 of 5 panels, and the multi-figure
    defect got WORSE (two and three figures on panels 3/4). "Jacket"
    wording plausibly pulled toward an unrelated fashion-lookbook
    archetype, a genre that is itself multi-view-prone -- a coherent
    explanation for both regressions landing together. Attempt 10 isolates
    the variables attempt 9 conflated: reverts to "coat" wording and
    attempt 8's own isolation weight (1.3, proven safe), and changes only
    the coat-length weight, 1.3 -> 1.5.

    Attempt 11 (this card's first real execution of the above, seed
    356237921, 444.7 total GPU-seconds) proved ControlNet reliably forces
    pose/single-figure count on 3 of 5 panels (front_tpose, back_tpose,
    side_neutral all came back clean) -- but the coat still ran well past
    mid-hip on every panel even at 1.5 emphasis, worse than attempts 3/5's
    plain-1.3-emphasis prompt-only result. Attempt 12 raises the
    coat-length weight again, 1.5 -> 1.8 -- isolation stays at 1.3,
    unchanged, since it is not implicated in this defect.

    Attempt 12 (seed 382682312, 393.5 total GPU-seconds) was a mixed
    result: front_tpose's coat did come back genuinely shorter, but 4 of 5
    panels lost the hooded-mask identity entirely (a visible human face and
    hair rendered instead of the hood/eye-lens mask), and front_tpose also
    gained several patches of legible garment-label text. The coat clause
    was never competing with anything that protected identity -- the
    hood/mask wording had no emphasis of its own, unlike every other clause
    in this prompt. Attempt 13 pulls the coat weight back partway (1.8 ->
    1.6, still above attempt 11's insufficient 1.5) and, for the first
    time, gives the hood/mask clause its own emphasis (1.3) plus explicit
    face/hair-suppression wording.

    Attempt 13 (seed 411721095, 429.5 total GPU-seconds) confirmed the
    hood/mask emphasis genuinely works (clean on all 5 panels, a first) --
    but adding a fourth emphasized clause over-saturated the prompt's
    attention budget elsewhere: side_left_forward exploded to four figures,
    side_neutral lost its true-profile framing, the reference-sheet/
    tech-pack diagram defect (last seen attempts 6/7) came back, high heels
    reappeared despite an explicit ban, and coat length regressed to
    floor-length on two panels. Every text-side lever tried on this card's
    persistent multi-figure defect has traded one problem for another.
    Attempt 14 reverts coat weight fully to attempt 11's baseline, 1.6 ->
    1.5, keeps the proven hood/mask emphasis unchanged, and moves the
    actual multi-figure fix attempt to `CONTROLNET_STRENGTH` -- a lever
    that doesn't compete for text attention budget at all.

    **2026-09-10 dedicated-legs-panel amendment -- REVOKES the mid-hip coat
    clause entirely, it does not just relax the weight.** Fourteen attempts
    of evidence (this docstring's own history above) never got the coat
    genuinely mid-hip without breaking something else -- identity drift,
    multi-figure regressions, or both -- and every one of those failures
    happened while this clause was competing with isolation/hood-mask for
    the same finite CLIP attention budget. @DennieSeth's decision: stop
    fighting it. The character's canonical long coat (what the identity
    LoRA and concept sheet both actually want) is now *correct* on every
    whole-figure panel, not a defect to suppress -- `upper_leg`/`lower_leg`
    instead come from a dedicated sixth panel with no coat at all
    (`build_legs_panel_positive_prompt`). Removing this clause also frees
    the attention budget every prior attempt's docstring blamed for the
    persistent side-panel multi-figure/profile-framing defects, without
    touching `CONTROLNET_STRENGTH` (unchanged at attempt 14's 1.6) or the
    multi-figure negative weight (unchanged at attempt 11's 1.3, per the
    amendment's own "do not tune coat-length prompt weight, that axis is
    closed" -- this is a removal, not a tune).

    Attempt 16 (docs/assets/evidence/T-0351/): attempt 15 (seed 264575131,
    this card's first real six-panel execution) showed the standard head
    clause below -- which names the mask's visible eye lenses -- was being
    interpolated unchanged into back_tpose too, directly fighting that
    panel's own "back view" pose clause; the render showed the mask facing
    the camera, not the back of the hood. `PoseSpec.head_clause` now lets
    back_tpose override this with wording that describes the back of the
    hood instead (see POSE_SPECS)."""
    head_clause = pose.head_clause or (
        "(hooded mask with two dark round visible eye lenses, not a blank void, hood fully "
        "up and forward, face completely covered by the mask, no visible hair, no visible "
        "face:1.3)"
    )
    return (
        f"{entity.trigger_token}, (a single full-body figure, exactly one pose, exactly one "
        "camera view, isolated portrait alone on a plain background:1.3), head to toe fully "
        f"visible, centred, {pose.pose_clause}, {entity.costume_description}, "
        f"institutional green coat, full-length coat reaching past the knee, wearing a "
        f"{head_clause}, boots, never high heels, flat uniform neutral grey background, flat "
        "even lighting, no cast shadow, no perspective, clean readable outline"
    )


def build_legs_panel_positive_prompt(entity: EntitySpec) -> str:
    """2026-09-10 dedicated-legs-panel amendment: the sixth panel, lower
    body only -- trousers and boots, NO COAT -- the dedicated source for
    `upper_leg`/`lower_leg` now that panels 1-5 keep the canonical long
    coat unconstrained (see `build_single_pose_positive_prompt`'s
    docstring). Deliberately does not interpolate
    `entity.costume_description` (`"institutional green coat, hooded,
    white gloves"`) -- it names the coat this panel exists specifically to
    omit, so this prompt states the lower-body garment directly instead.
    The hooded-mask head marker stays, for the same identity-continuity
    reason every other panel keeps it, and the same isolation/hood
    emphasis weights (1.3) as the whole-figure panels, unchanged.

    Attempt 16 (docs/assets/evidence/T-0351/): attempt 15's legs panel
    rendered a short hooded cape/poncho covering both thighs despite an
    explicit 'no cloak' ban -- a cape is a materially different garment
    silhouette that was never named, and the no-coat clause's 1.5 emphasis
    evidently lost to it. Names 'cape' explicitly and raises the clause's
    emphasis 1.5 -> 1.8, past every whole-figure panel's own 1.3 clauses, so
    it reliably wins on the one panel where any upper-body garment is a
    defect."""
    return (
        f"{entity.trigger_token}, (a single full-body figure, exactly one pose, exactly one "
        "camera view, isolated portrait alone on a plain background:1.3), head to toe fully "
        "visible, centred, front view, standing pose, both arms hanging straight down at the "
        "sides, legs apart, weight evenly balanced, "
        "wearing military trousers and lace-up combat boots, trousers tucked into the boots, "
        "(no coat, no jacket, no cloak, no cape, no poncho, bare lower body garment only, both "
        "thighs and both lower legs fully visible and unobstructed, nothing covering the legs, "
        "nothing draped over the shoulders or hips:1.8), wearing a "
        "(hooded mask with two dark round visible eye lenses, not a blank void, hood fully "
        "up and forward, face completely covered by the mask, no visible hair, no visible "
        "face:1.3), never high heels, flat uniform neutral grey background, flat even "
        "lighting, no cast shadow, no perspective, clean readable outline"
    )


def build_single_pose_negative_prompt(pose: PoseSpec | None = None) -> str:
    """Reuses #365's own `build_negative_prompt` (blank heads, armour
    drift, cropped heads/limbs, robotic legs) unchanged -- MAIN_NEGATIVE
    already forbids multi-figure/grid/panel/turnaround compositions, which
    is exactly what a single-pose-per-generation request wants, not
    something to fight (see `build_single_pose_positive_prompt`'s
    docstring). Adds only this card's own coat-length and footwear
    reinforcement, reused from `build_limb_pose_negative_prompt` -- but
    deliberately drops that function's extra anti-panel/anti-duplicate-pose
    clauses (six figures, two rows, isolated leg row, ...), which existed
    only to fight the single-shot five-panel approach this lever replaces
    and have no target to suppress in a single-pose generation.

    Attempt 6 (see `build_single_pose_positive_prompt`'s docstring)
    revealed a failure mode MAIN_NEGATIVE's existing "grid, panels, contact
    sheet, multiple frames" wording did not suppress: a multi-inset fashion
    tech-pack/reference-sheet composition (a hero figure plus small callout
    panels of garment pieces or alternate views), not the single isolated
    figure requested. Attempt 7 adds terms naming that specific composition
    genre, plus the stray-text defect attempt 6 also showed (now that "no
    text/no UI/no watermark" has moved out of the positive prompt, see
    `build_single_pose_positive_prompt`).

    Attempt 8 (first ControlNet execution) still regressed to a
    three-figure composition on side_right_forward despite every one of
    these unemphasized bans -- the same emphasis lever that fixed coat
    length in attempts 3/5 is applied here too, on this card's own
    anti-multi-figure clause (`MAIN_NEGATIVE`'s shared "two figures, ...
    group of people" wording is left unweighted/untouched, since it's
    reused across every card in this pipeline).

    Attempt 11 (see `build_single_pose_positive_prompt`'s docstring) still
    showed a ghosting defect on side_left_forward and side_right_forward at
    1.3 weight -- a faded, translucent second or third figure overlapping
    the main one, distinct from attempt 8's opaque multi-figure regression
    and not named by any existing term. Attempt 12 raises the weight to 1.6
    and adds terms for this specific defect.

    Attempt 12 fixed ghosting on 3 of 5 panels, but side_right_forward
    still regressed to three opaque figures, and the higher weight is
    implicated (with the coat-weight increase) in that attempt's new
    identity-drift (visible face/hair in 4 of 5 panels) and stray legible
    garment-label text. Attempt 13 pulls the multi-figure weight back
    partway, 1.6 -> 1.4, and adds terms for both new defects: explicit
    face/hair visibility bans (protecting the hood/mask, which also gets
    its own positive-prompt emphasis this attempt -- see
    `build_single_pose_positive_prompt`) and explicit readable-text bans
    (existing "label, caption, illegible text, gibberish text" wording
    evidently did not cover actually-legible rendered words).

    Attempt 13 made the multi-figure defect WORSE, not better --
    side_left_forward exploded to four figures once a fourth clause
    (hood/mask) started competing for the same attention budget. Attempt
    14 reverts this weight fully to attempt 11's original 1.3 and moves the
    actual fix attempt to `CONTROLNET_STRENGTH` (see
    `build_single_pose_positive_prompt`'s docstring) -- every text-side
    weight change tried on this defect across attempts 8/11/12/13 has
    traded one problem for another.

    **2026-09-10 dedicated-legs-panel amendment**: drops the coat-length
    bans this function used to carry ("long coat, trench coat, ... coat
    below the hip") -- those actively fought the long coat that is now
    canonical and correct on every whole-figure panel. Keeping them would
    mean asking the model for the exact opposite of what this card wants.
    The dedicated "legs" panel (`build_legs_panel_negative_prompt`) is
    where a coat actually needs to be banned, and it says so explicitly
    rather than inheriting these now-backwards clauses.

    Attempt 16 (docs/assets/evidence/T-0351/): attempt 15's side_left_forward
    rendered a pistol clenched in the extended hand and a mid-kick action
    pose -- neither a weapon nor a kicking/running/combat motion was ever
    named here, so this adds both, unconditionally (every panel wants a
    static standing/reaching pose, never a weapon). Also takes an optional
    `pose` so a panel can append its own extra bans (`PoseSpec.negative_extra`)
    -- currently only back_tpose uses this, to suppress the mask's own
    visible-eye-lenses imagery that every other panel wants shown."""
    extra = pose.negative_extra if pose is not None else ""
    return (
        build_negative_prompt()
        + ", high heels, stiletto heels, pumps, mismatched footwear, reference sheet, tech "
        "pack, technical flat, fashion flat, product sheet, spec sheet, multiple views, "
        "multiple photos, multiple angles, comparison layout, inset panel, exploded view, "
        "contact sheet, grid of images, clothing flat lay, flat lay, label, caption, illegible "
        "text, gibberish text, UI mockup, readable text, legible words, real words, dictionary "
        "words, brand label, product tag, price tag, signage, visible face, exposed face, "
        "human face, bare face, visible hair, hair visible, hood down, hood back, bare head, "
        "uncovered head, (three figures, multiple figures, several figures, "
        "ensemble of characters, ghost figure, ghosting, faded duplicate figure, translucent "
        "overlay, transparent duplicate, afterimage, double exposure, doppelganger, second "
        "figure behind, overlapping figures:1.3), weapon, gun, pistol, firearm, rifle, "
        "holding object, kicking, mid-kick, running, jumping, martial arts stance, combat "
        "stance, dynamic action shot"
        + extra
    )


def build_legs_panel_negative_prompt() -> str:
    """2026-09-10 dedicated-legs-panel amendment: reuses
    `build_single_pose_negative_prompt` unchanged (footwear, reference-
    sheet, ghosting/multi-figure, face/hair bans all still apply to this
    panel) and adds the one thing this panel specifically needs that no
    other panel does -- an explicit ban on any garment covering the legs,
    since this is the only panel where a coat is a defect rather than the
    canonical, correct result. Attempt 16 (docs/assets/evidence/T-0351/)
    adds 'cape'/'poncho'/'mantle'/'shawl' -- attempt 15 rendered a short
    hooded cape covering both thighs, a garment silhouette the original
    'cloak' ban evidently did not cover."""
    return (
        build_single_pose_negative_prompt()
        + ", coat, long coat, trench coat, jacket, cloak, cape, poncho, mantle, shawl, robe, "
        "tunic, skirt, dress, apron, garment covering the thighs, garment covering the legs"
    )


def build_negative_prompt() -> str:
    """`MAIN_NEGATIVE` (T-0249) already forbids perspective and inconsistent
    identity; this adds the master-sheet-specific defects (a whole-figure
    view getting composited/cropped instead of laid out as its own clean
    panel), plus two defects a promoted round-2 sheet actually shipped with
    (see `build_positive_prompt`'s docstring): blank/faceless mannequin
    heads on the whole-figure panels, and costume drift toward heavier
    armour plating partway down the sheet instead of holding one identity."""
    return (
        MAIN_NEGATIVE
        + ", cropped limbs, cropped figure, overlapping panels, panels touching, "
        "different costume between panels, different colour between panels, blank head, "
        "faceless, featureless mannequin head, missing face, no face, headless, blank white "
        "head, cropped head, head cut off, head out of frame, armor plating, plate armor, "
        "heavy armor, bulky armor, mecha armor, sci-fi armor, helmet, robot legs, robotic "
        "legs, mechanical legs, cyborg, exoskeleton, robot parts, machine parts, different "
        "silhouette between panels"
    )


# ── Graph node ids -- named, not raw string literals re-derived per call ────
CHECKPOINT_NODE_ID = "1"
STYLE_LORA_NODE_ID = "11"
IDENTITY_LORA_NODE_ID = "12"
POSITIVE_PROMPT_NODE_ID = "13"
NEGATIVE_PROMPT_NODE_ID = "14"
CONCEPT_IMAGE_NODE_ID = "17"
CONCEPT_CROP_NODE_ID = "24"
IPADAPTER_LOADER_NODE_ID = "18"
IPADAPTER_NODE_ID = "19"
LATENT_NODE_ID = "20"
SAMPLER_NODE_ID = "21"
VAE_DECODE_NODE_ID = "22"
MAIN_SAVE_NODE_ID = "23"
# T-0351 (2026-09-10 amendment): pose-conditioning-only ControlNet nodes,
# wired only when build_graph is given a pose_skeleton_filename -- T-0336's
# own default call path never touches these ids.
POSE_IMAGE_NODE_ID = "25"
CONTROLNET_LOADER_NODE_ID = "26"
CONTROLNET_NODE_ID = "27"

# The review's own finding, pinned mechanically (test_latent_dimensions_never_default_to_384):
# every incoherent render in the repo was sampled at 384; the LoRAs were trained at 1024.
DEFAULT_MASTER_SHEET_PX = 1024


def build_graph(
    seed: int,
    concept_filename: str,
    positive_text: str,
    negative_text: str,
    style_lora_weight: float,
    ipadapter_weight: float,
    width: int = DEFAULT_MASTER_SHEET_PX,
    height: int = DEFAULT_MASTER_SHEET_PX,
    *,
    identity_lora_name: str | None = None,
    identity_lora_weight: float = 0.0,
    concept_crop_box: tuple[int, int, int, int] | None = None,
    pose_skeleton_filename: str | None = None,
    controlnet_strength: float = 0.0,
    controlnet_end: float = 0.0,
) -> dict:
    """txt2img + style LoRA at 1024, IP-Adapter on the approved concept
    sheet. The identity LoRA is optional and, when present, chains after
    the style LoRA -- an enemy entity with no trained identity LoRA yet
    (`identity_lora_name=None`) still gets a graph, just without that node.

    `concept_crop_box`, when given as `(x, y, width, height)`, inserts an
    `ImageCrop` node between the concept-sheet `LoadImage` and IP-Adapter so
    conditioning draws from only that sub-region of the sheet -- see
    `EntitySpec.concept_crop_box`'s own docstring for why (the concept sheet
    mixes two costume lines across its panel grid; IP-Adapter conditions on
    whichever pixels it is shown). `None` (the default) conditions on the
    whole sheet, unchanged from every attempt before round 5.

    `pose_skeleton_filename`, when given, inserts ControlNetLoader +
    ControlNetApplyAdvanced (T-0351, 2026-09-10 amendment) between the
    CLIPTextEncode pair and KSampler: a `LoadImage` of an already-uploaded
    OpenPose skeleton (`pose_rig_master_sheet_T0351.render_pose_skeleton`)
    conditions the positive/negative prompt pair via
    `control_net`/`strength`/`end_percent`, and KSampler consumes the
    ControlNet node's own conditioning outputs instead of the raw
    CLIPTextEncode ones. `None` (the default, every T-0336 call site) omits
    ControlNet entirely -- DL-30's own scope, and this card's own
    acceptance criterion that ControlNet is for pose conditioning only: it
    never touches the model chain LoRA/IP-Adapter build on, only the
    positive/negative conditioning pair KSampler ultimately samples
    against."""
    g: dict = {}
    g[CHECKPOINT_NODE_ID] = {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": CHECKPOINT},
    }
    g[STYLE_LORA_NODE_ID] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": [CHECKPOINT_NODE_ID, 0],
            "clip": [CHECKPOINT_NODE_ID, 1],
            "lora_name": LORA_NAME,
            "strength_model": style_lora_weight,
            "strength_clip": style_lora_weight,
        },
    }
    model_source = [STYLE_LORA_NODE_ID, 0]
    clip_source = [STYLE_LORA_NODE_ID, 1]

    if identity_lora_name is not None:
        g[IDENTITY_LORA_NODE_ID] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": [STYLE_LORA_NODE_ID, 0],
                "clip": [STYLE_LORA_NODE_ID, 1],
                "lora_name": identity_lora_name,
                "strength_model": identity_lora_weight,
                "strength_clip": identity_lora_weight,
            },
        }
        model_source = [IDENTITY_LORA_NODE_ID, 0]
        clip_source = [IDENTITY_LORA_NODE_ID, 1]

    g[POSITIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": positive_text, "clip": clip_source},
    }
    g[NEGATIVE_PROMPT_NODE_ID] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": negative_text, "clip": clip_source},
    }

    positive_source = [POSITIVE_PROMPT_NODE_ID, 0]
    negative_source = [NEGATIVE_PROMPT_NODE_ID, 0]
    if pose_skeleton_filename is not None:
        g[POSE_IMAGE_NODE_ID] = {
            "class_type": "LoadImage",
            "inputs": {"image": pose_skeleton_filename},
        }
        g[CONTROLNET_LOADER_NODE_ID] = {
            "class_type": "ControlNetLoader",
            "inputs": {"control_net_name": CONTROLNET_NAME},
        }
        g[CONTROLNET_NODE_ID] = {
            "class_type": "ControlNetApplyAdvanced",
            "inputs": {
                "positive": positive_source,
                "negative": negative_source,
                "control_net": [CONTROLNET_LOADER_NODE_ID, 0],
                "image": [POSE_IMAGE_NODE_ID, 0],
                "strength": controlnet_strength,
                "start_percent": 0.0,
                "end_percent": controlnet_end,
            },
        }
        positive_source = [CONTROLNET_NODE_ID, 0]
        negative_source = [CONTROLNET_NODE_ID, 1]

    g[CONCEPT_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": concept_filename},
    }
    ipadapter_image_source = [CONCEPT_IMAGE_NODE_ID, 0]
    if concept_crop_box is not None:
        crop_x, crop_y, crop_width, crop_height = concept_crop_box
        g[CONCEPT_CROP_NODE_ID] = {
            "class_type": "ImageCrop",
            "inputs": {
                "image": [CONCEPT_IMAGE_NODE_ID, 0],
                "width": crop_width,
                "height": crop_height,
                "x": crop_x,
                "y": crop_y,
            },
        }
        ipadapter_image_source = [CONCEPT_CROP_NODE_ID, 0]
    g[IPADAPTER_LOADER_NODE_ID] = {
        "class_type": "IPAdapterUnifiedLoader",
        "inputs": {"model": model_source, "preset": IPADAPTER_PRESET},
    }
    g[IPADAPTER_NODE_ID] = {
        "class_type": "IPAdapterAdvanced",
        "inputs": {
            "model": [IPADAPTER_LOADER_NODE_ID, 0],
            "ipadapter": [IPADAPTER_LOADER_NODE_ID, 1],
            "image": ipadapter_image_source,
            "weight": ipadapter_weight,
            "weight_type": "linear",
            "combine_embeds": "concat",
            "start_at": 0.0,
            "end_at": 1.0,
            "embeds_scaling": "V only",
        },
    }

    g[LATENT_NODE_ID] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": width, "height": height, "batch_size": 1},
    }
    g[SAMPLER_NODE_ID] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [IPADAPTER_NODE_ID, 0],
            "positive": positive_source,
            "negative": negative_source,
            "latent_image": [LATENT_NODE_ID, 0],
            "seed": seed,
            "steps": 30,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    g[VAE_DECODE_NODE_ID] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": [SAMPLER_NODE_ID, 0], "vae": [CHECKPOINT_NODE_ID, 2]},
    }
    g[MAIN_SAVE_NODE_ID] = {
        "class_type": "SaveImage",
        "inputs": {
            "filename_prefix": "master_sheet_T0336",
            "images": [VAE_DECODE_NODE_ID, 0],
        },
    }
    return g


# Per-card attempt budget. T-0336's own ~25-50 GPU-second budget (a small
# job, not a sweep -- T-0272/T-0317's own 84-attempt failure mode is exactly
# what that card's scope section warns against repeating) stays at 5,
# unchanged. A card with no entry here imposes no budget of its own (T-0351's
# own card text says exactly this, per the run-2 reviewer verdict: the
# 5-attempt stop after run 1 was this inherited T-0336 cap, not a constraint
# T-0351 itself imposes -- lever 2 needs a 6th+ attempt, since it spends five
# separate generations per attempt instead of one) -- it falls back to
# DEFAULT_ATTEMPT_CAP, a generic runaway backstop, not a per-card budget.
ATTEMPT_CAP_BY_CARD: dict[str, int] = {"T-0336": 5}
DEFAULT_ATTEMPT_CAP = 20

# T-0351 (2026-09-10 amendment): pose-conditioning-only ControlNet strength/
# end-percent for run_five_pose_attempt. 1.3/1.0 was this pipeline's own
# proven-effective value for single-figure OpenPose pose pinning against
# this exact checkpoint+ControlNet pair (ARM_POSE_AUTHORITY_ATTEMPT_LOG_T0249.md
# attempt 3, promoted) -- not a fresh guess, but attempts 8/11/12/13 all
# showed a persistent multi-figure defect on the two forward-lean side
# panels that every text-side (CLIP emphasis) fix attempt only traded for
# a different regression elsewhere, since every clause in the prompt
# competes for the same attention budget. Attempt 14 raises strength to
# 1.6 -- a lever that conditions structure, not text attention, and so
# does not compete with any positive/negative prompt clause -- to test
# whether more rigid adherence to the single-figure skeleton suppresses
# the extraneous content a weaker pin leaves the sampler free to add.
CONTROLNET_STRENGTH = 1.6
CONTROLNET_END_PERCENT = 1.0


def check_attempt_cap(attempt: int, card: str = "T-0336") -> None:
    cap = ATTEMPT_CAP_BY_CARD.get(card, DEFAULT_ATTEMPT_CAP)
    if not (1 <= attempt <= cap):
        raise SystemExit(
            f"attempt cap is {cap} for card {card!r} -- refusing to run further attempts "
            "(see conduct.md: a small job, not a sweep)"
        )


# ── Attempt log + promotion bookkeeping ─────────────────────────────────

def _card_slug(card: str) -> str:
    """'T-0351' -> 'T0351' -- the filename convention this pipeline has used
    since Arm A (T0228, T0229, ... T0336), unbroken by the dash."""
    return card.replace("-", "")


def attempt_log_path_for(card: str) -> Path:
    return (
        REPO_ROOT
        / "assets"
        / "src"
        / "character"
        / f"ARM_MASTER_SHEET_ATTEMPT_LOG_{_card_slug(card)}.md"
    )


def out_dir_for(card: str, entity_name: str, attempt: int) -> Path:
    return (
        REPO_ROOT
        / "assets"
        / "out"
        / f"master_sheet_{_card_slug(card)}"
        / entity_name
        / f"attempt_{attempt}"
    )


ATTEMPT_LOG_PATH = attempt_log_path_for("T-0336")
MASTER_SHEETS_DIR = REPO_ROOT / "assets" / "src" / "character" / "master_sheets"

ATTEMPT_LOG_HEADER = (
    "# Tier-1 master-sheet attempt log (T-0336, docs/decision-log.md DL-30)\n\n"
    "Every attempt is recorded here whether or not it is promoted. Tier-1 generates ONCE "
    "per entity at 1024px -- style LoRA + IP-Adapter on the approved concept sheet, "
    "explicitly no ControlNet. Budget is ~25-50 GPU-seconds; this is a small job, not a "
    "sweep, so the attempt cap stays at 5.\n\n"
    "| Attempt | Entity | Seed | Style LoRA weight | Identity LoRA weight | IP-Adapter "
    "weight | Width | Height | GPU seconds | Promoted | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict, notes: str = "", log_path: Path | None = None) -> None:
    path = log_path if log_path is not None else ATTEMPT_LOG_PATH
    if not path.exists():
        path.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['entity']} | {provenance['seed']} "
        f"| {provenance['style_lora_weight']} | {provenance.get('identity_lora_weight')} "
        f"| {provenance['ip_adapter_weight']} | {provenance['width']} "
        f"| {provenance['height']} | {provenance['gpu_seconds']} "
        f"| {'yes' if provenance.get('promoted') else 'no'} | {notes} |\n"
    )
    with path.open("a") as f:
        f.write(row)


def compose_pose_row(image_paths: list[Path], out_path: Path) -> None:
    """T-0351 lever 2: stitches N independently-generated single-pose
    images side by side into one row, left to right in the order given --
    the script-owned layout step `build_single_pose_positive_prompt`'s
    docstring describes, replacing a single KSampler call being asked to
    lay out five panels itself. Every image is scaled to the smallest
    height among them, preserving aspect ratio (never stretched, same
    principle as `compose_master_sheet_with_parts`) before being pasted --
    the five generations all come out of the same 1024x1024 graph so this
    is a no-op in practice, but stays correct if a future caller mixes
    sizes."""
    from PIL import Image

    images = [Image.open(p).convert("RGB") for p in image_paths]
    target_height = min(im.height for im in images)
    scaled = []
    for im in images:
        scale = target_height / im.height
        new_size = (max(1, round(im.width * scale)), target_height)
        scaled.append(im.resize(new_size))

    total_width = sum(im.width for im in scaled)
    canvas = Image.new("RGB", (total_width, target_height), scaled[0].getpixel((0, 0)))
    x = 0
    for im in scaled:
        canvas.paste(im, (x, 0))
        x += im.width

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


PARTS_ROW_HEIGHT = 340
PARTS_ROW_PADDING = 20


def compose_master_sheet_with_parts(
    sheet_path: Path,
    out_path: Path,
    crop_boxes: dict[str, tuple[int, int, int, int]],
    row_height: int,
    padding: int,
) -> None:
    """Crops genuinely-isolated anatomical/garment regions straight out of
    a single coherent generation and pastes them into an extra row appended
    below it -- DL-30 sanctions script arrangement of diffusion-sampled
    pixels, and reusing real pixels from one internally-consistent image
    (rather than blending crops across different attempts/seeds) is what
    keeps every part's costume and lighting matching the whole-figure views
    above it, unlike the mismatched-parts defect an earlier promoted sheet
    shipped with.

    Each crop is scaled to fit inside its own slot (the sheet's width
    divided evenly among the parts) preserving its aspect ratio, then
    centred there -- never stretched, since a distorted crop would be
    useless as an actual sprite source for whatever consumes this sheet
    next."""
    from PIL import Image

    sheet = Image.open(sheet_path).convert("RGB")
    bg_color = sheet.getpixel((0, 0))
    names = list(crop_boxes)
    slot_width = sheet.width // len(names)
    available_width = slot_width - 2 * padding
    available_height = row_height - 2 * padding

    canvas = Image.new("RGB", (sheet.width, sheet.height + row_height), bg_color)
    canvas.paste(sheet, (0, 0))

    for i, name in enumerate(names):
        crop = sheet.crop(crop_boxes[name])
        scale = min(available_width / crop.width, available_height / crop.height)
        new_size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
        crop = crop.resize(new_size)
        slot_x = i * slot_width
        x = slot_x + (slot_width - crop.width) // 2
        y = sheet.height + (row_height - crop.height) // 2
        canvas.paste(crop, (x, y))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


def promote_attempt(
    entity_name: str,
    out_dir: Path,
    provenance: dict,
    *,
    dest_dir: Path | None = None,
    dest_stem: str | None = None,
    limb_crop_boxes: dict[str, tuple[int, int, int, int]] | None = None,
) -> None:
    """Copy this attempt's master sheet + provenance into
    assets/src/character/master_sheets/ -- master sheets are pipeline
    inputs, not game-scale finals, so they land under assets/src/, not
    assets/final/ (this card's own acceptance criterion). When
    `limb_crop_boxes` resolves to something (explicit, or the entity's own
    hand-tuned default), the promoted sheet is composited with an extra row
    of isolated part crops (`compose_master_sheet_with_parts`) rather than a
    raw copy of the generation.

    `dest_dir`/`dest_stem`/`limb_crop_boxes` default to T-0336's own
    unchanged behaviour (`MASTER_SHEETS_DIR`, `<entity>_master_sheet_T0336`,
    the entity's registered `limb_crop_boxes`) -- a card generating a
    differently-posed sheet (T-0351) passes its own stem and crop boxes
    explicitly rather than overloading `ENTITIES`, since the entity's
    identity/costume/recipe are unchanged and only the pose (and therefore
    the pixel layout the crop boxes target) differs."""
    resolved_dest_dir = dest_dir if dest_dir is not None else MASTER_SHEETS_DIR
    resolved_dest_dir.mkdir(parents=True, exist_ok=True)
    stem = dest_stem if dest_stem is not None else f"{entity_name}_master_sheet_T0336"
    dest_png = resolved_dest_dir / f"{stem}.png"
    src_png = out_dir / "master_sheet_1024.png"

    resolved_crop_boxes = (
        limb_crop_boxes if limb_crop_boxes is not None else ENTITIES[entity_name].limb_crop_boxes
    )
    promoted = dict(provenance)
    if resolved_crop_boxes is not None:
        compose_master_sheet_with_parts(
            src_png, dest_png, resolved_crop_boxes, PARTS_ROW_HEIGHT, PARTS_ROW_PADDING
        )
        promoted["limb_crop_boxes"] = resolved_crop_boxes
        if "method" in promoted:
            promoted["method"] += (
                " Promotion appends a script-composited row below the generation "
                f"(compose_master_sheet_with_parts, {sorted(resolved_crop_boxes)}), cropping "
                "genuinely-isolated regions straight out of this same coherent image rather "
                "than relying on the model to render isolated limbs (DL-30 sanctions script "
                "arrangement of diffusion-sampled pixels)."
            )
    else:
        dest_png.write_bytes(src_png.read_bytes())
        promoted["limb_crop_boxes"] = None

    promoted["promoted"] = True
    dest_json = resolved_dest_dir / f"{stem}.provenance.json"
    dest_json.write_text(json.dumps(promoted, indent=2) + "\n")


# ── Attempt driver ───────────────────────────────────────────────────────


def run_attempt(
    entity_name: str,
    attempt: int,
    seed: int,
    style_lora_weight: float = 0.70,
    identity_lora_weight: float | None = None,
    ipadapter_weight: float = 0.35,
    width: int = DEFAULT_MASTER_SHEET_PX,
    height: int = DEFAULT_MASTER_SHEET_PX,
    *,
    card: str = "T-0336",
    prompt_builder: Callable[[EntitySpec], str] | None = None,
    negative_prompt_builder: Callable[[], str] | None = None,
) -> dict:
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    entity = ENTITIES[entity_name]
    concept_hash = sha256_of(entity.concept_sheet_path)
    if concept_hash != entity.concept_hash:
        raise RuntimeError(
            f"concept sheet hash mismatch for {entity_name!r}: got {concept_hash}, "
            f"expected {entity.concept_hash}"
        )

    identity_lora_name = None
    identity_lora_hash = None
    resolved_identity_weight = 0.0
    if entity.identity_lora_name is not None:
        if not entity.identity_lora_path.exists():
            raise RuntimeError(f"trained identity LoRA not found: {entity.identity_lora_path}")
        if not entity.identity_lora_provenance_path.exists():
            raise RuntimeError(
                f"identity LoRA provenance sidecar not found: "
                f"{entity.identity_lora_provenance_path}"
            )
        identity_lora_name = entity.identity_lora_name
        identity_lora_hash = sha256_of(entity.identity_lora_path)
        resolved_identity_weight = (
            identity_lora_weight
            if identity_lora_weight is not None
            else entity.identity_lora_weight
        )

    style_lora_hash = sha256_of(LORA_PATH)

    out_dir = out_dir_for(card, entity_name, attempt)
    out_dir.mkdir(parents=True, exist_ok=True)

    positive_text = (prompt_builder or build_positive_prompt)(entity)
    negative_text = (negative_prompt_builder or build_negative_prompt)()

    t0 = time.monotonic()
    concept_filename = upload_image(entity.concept_sheet_path)
    graph = build_graph(
        seed=seed,
        concept_filename=concept_filename,
        positive_text=positive_text,
        negative_text=negative_text,
        style_lora_weight=style_lora_weight,
        ipadapter_weight=ipadapter_weight,
        width=width,
        height=height,
        identity_lora_name=identity_lora_name,
        identity_lora_weight=resolved_identity_weight,
        concept_crop_box=entity.concept_crop_box,
    )
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id, timeout_s=300)
    gpu_seconds = time.monotonic() - t0

    main_bytes = fetch_save_image(info, MAIN_SAVE_NODE_ID)
    sheet_path = out_dir / "master_sheet_1024.png"
    sheet_path.write_bytes(main_bytes)

    model_summary = f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight})"
    if identity_lora_name is not None:
        model_summary += (
            f" + LoRA {identity_lora_name} (identity, chained, weight "
            f"{resolved_identity_weight})"
        )
    model_summary += f" + IP-Adapter {IPADAPTER_NAME} (weight {ipadapter_weight})"

    provenance = {
        "model": model_summary,
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "style_lora_license": LORA_LICENSE,
        "identity_lora_name": identity_lora_name,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": resolved_identity_weight if identity_lora_name else None,
        "identity_lora_provenance": (
            str(entity.identity_lora_provenance_path.relative_to(REPO_ROOT))
            if identity_lora_name is not None
            else None
        ),
        "ip_adapter": IPADAPTER_NAME,
        "ip_adapter_weight": ipadapter_weight,
        "concept_crop_box": entity.concept_crop_box,
        "controlnet": None,
        "controlnet_note": "deliberately omitted (DL-30 / this card's own scope)",
        "prompt": positive_text,
        "negative_prompt": negative_text,
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": width,
        "height": height,
        "entity": entity_name,
        "concept_hash": concept_hash,
        "concept_source": str(entity.concept_sheet_path.relative_to(REPO_ROOT)),
        "comfyui_prompt_id": prompt_id,
        "method": (
            "Single 1024x1024 txt2img generation: LoraLoader(soviet_brutalism_style_v1) "
            + ("-> LoraLoader(identity, chained) " if identity_lora_name is not None else "")
            + "-> IPAdapterUnifiedLoader + IPAdapterAdvanced (concept sheet) -> KSampler -> "
            "VAEDecode -> SaveImage. No ControlNet. The prompt itself requests front/side/"
            "back whole-figure views plus separated limb reference parts on a flat "
            "background; this generation step itself does no script compositing (see "
            "promote_attempt/compose_master_sheet_with_parts for the separate, later step "
            "that may append one)."
        ),
        "generator": "assets/src/character/gen_master_sheet_T0336.py",
        "card": card,
        "spec": (
            "docs/decision-log.md DL-30"
            if card == "T-0336"
            else "docs/decision-log.md DL-30, pose spec per T-0351 (successor to #365/T-0336; "
            "recipe unchanged, pose is the only variable)"
        ),
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "promoted": False,
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def run_five_pose_attempt(
    entity_name: str,
    attempt: int,
    base_seed: int,
    style_lora_weight: float = 0.70,
    identity_lora_weight: float | None = None,
    ipadapter_weight: float = 0.35,
    width: int = DEFAULT_MASTER_SHEET_PX,
    height: int = DEFAULT_MASTER_SHEET_PX,
    *,
    card: str = "T-0351",
) -> dict:
    """T-0351 lever 2 (run-1 reviewer verdict): five independent 1024x1024
    IP-Adapter-conditioned txt2img calls, one per `POSE_SPECS` entry,
    composited into one row by `compose_pose_row` -- see
    `build_single_pose_positive_prompt`'s docstring for why this replaces
    the single-shot five-panel-in-one-image approach `run_attempt`/
    `build_limb_pose_prompt` used for this card's first five attempts.
    Reuses `build_graph` unchanged (still no ControlNet, still IP-Adapter
    on `entity.concept_crop_box`, still the same style/identity LoRA
    weights) -- the only change from `run_attempt` is that it is called
    once per pose instead of once for the whole sheet. Each pose gets its
    own seed (`base_seed + index`) so the five generations are distinct and
    reproducible, not five identical draws.

    Writes the same `master_sheet_1024.png` / `provenance_candidate.json`
    filenames `run_attempt` does, under the same `out_dir_for(card, ...)`
    layout, so `promote_attempt`/the CLI's `--promote-attempt` path needs
    no changes to consume this function's output."""
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    entity = ENTITIES[entity_name]
    concept_hash = sha256_of(entity.concept_sheet_path)
    if concept_hash != entity.concept_hash:
        raise RuntimeError(
            f"concept sheet hash mismatch for {entity_name!r}: got {concept_hash}, "
            f"expected {entity.concept_hash}"
        )

    identity_lora_name = None
    identity_lora_hash = None
    resolved_identity_weight = 0.0
    if entity.identity_lora_name is not None:
        if not entity.identity_lora_path.exists():
            raise RuntimeError(f"trained identity LoRA not found: {entity.identity_lora_path}")
        if not entity.identity_lora_provenance_path.exists():
            raise RuntimeError(
                f"identity LoRA provenance sidecar not found: "
                f"{entity.identity_lora_provenance_path}"
            )
        identity_lora_name = entity.identity_lora_name
        identity_lora_hash = sha256_of(entity.identity_lora_path)
        resolved_identity_weight = (
            identity_lora_weight
            if identity_lora_weight is not None
            else entity.identity_lora_weight
        )

    style_lora_hash = sha256_of(LORA_PATH)

    out_dir = out_dir_for(card, entity_name, attempt)
    out_dir.mkdir(parents=True, exist_ok=True)

    concept_filename = upload_image(entity.concept_sheet_path)

    pose_records = []
    panel_paths = []
    total_gpu_seconds = 0.0
    for i, pose in enumerate(POSE_SPECS):
        seed = base_seed + i
        # Dedicated-legs-panel amendment: the "legs" panel is the one place
        # a coat is a defect, not the canonical result -- it gets its own
        # prompt pair rather than the whole-figure one every other panel
        # uses (see build_legs_panel_positive_prompt's docstring).
        if pose.no_coat:
            positive_text = build_legs_panel_positive_prompt(entity)
            negative_text = build_legs_panel_negative_prompt()
        else:
            positive_text = build_single_pose_positive_prompt(entity, pose)
            negative_text = build_single_pose_negative_prompt(pose)

        skeleton = pose_rig_master_sheet_T0351.render_pose_skeleton(pose.key, width)
        skeleton_path = out_dir / f"pose_{pose.key}_skeleton.png"
        skeleton.save(skeleton_path)
        skeleton_filename = upload_image(skeleton_path)

        graph = build_graph(
            seed=seed,
            concept_filename=concept_filename,
            positive_text=positive_text,
            negative_text=negative_text,
            style_lora_weight=style_lora_weight,
            ipadapter_weight=ipadapter_weight,
            width=width,
            height=height,
            identity_lora_name=identity_lora_name,
            identity_lora_weight=resolved_identity_weight,
            concept_crop_box=entity.concept_crop_box,
            pose_skeleton_filename=skeleton_filename,
            controlnet_strength=CONTROLNET_STRENGTH,
            controlnet_end=CONTROLNET_END_PERCENT,
        )
        t0 = time.monotonic()
        prompt_id = submit_prompt(graph)
        info = wait_for_completion(prompt_id, timeout_s=300)
        gpu_seconds = time.monotonic() - t0
        total_gpu_seconds += gpu_seconds

        panel_bytes = fetch_save_image(info, MAIN_SAVE_NODE_ID)
        panel_path = out_dir / f"pose_{pose.key}_1024.png"
        panel_path.write_bytes(panel_bytes)
        panel_paths.append(panel_path)

        pose_records.append(
            {
                "key": pose.key,
                "label": pose.label,
                "seed": seed,
                "prompt": positive_text,
                "negative_prompt": negative_text,
                "comfyui_prompt_id": prompt_id,
                "gpu_seconds": round(gpu_seconds, 1),
                "pose_skeleton": str(skeleton_path.relative_to(REPO_ROOT)),
            }
        )

    sheet_path = out_dir / "master_sheet_1024.png"
    compose_pose_row(panel_paths, sheet_path)
    from PIL import Image

    with Image.open(sheet_path) as sheet:
        sheet_width, sheet_height = sheet.size

    model_summary = f"{CHECKPOINT} + LoRA {LORA_NAME} (style, weight {style_lora_weight})"
    if identity_lora_name is not None:
        model_summary += (
            f" + LoRA {identity_lora_name} (identity, chained, weight "
            f"{resolved_identity_weight})"
        )
    model_summary += f" + IP-Adapter {IPADAPTER_NAME} (weight {ipadapter_weight})"

    provenance = {
        "model": model_summary,
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "style_lora_name": LORA_NAME,
        "style_lora_hash": style_lora_hash,
        "style_lora_weight": style_lora_weight,
        "style_lora_license": LORA_LICENSE,
        "identity_lora_name": identity_lora_name,
        "identity_lora_hash": identity_lora_hash,
        "identity_lora_weight": resolved_identity_weight if identity_lora_name else None,
        "identity_lora_provenance": (
            str(entity.identity_lora_provenance_path.relative_to(REPO_ROOT))
            if identity_lora_name is not None
            else None
        ),
        "ip_adapter": IPADAPTER_NAME,
        "ip_adapter_weight": ipadapter_weight,
        "concept_crop_box": entity.concept_crop_box,
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": CONTROLNET_STRENGTH,
        "controlnet_end_percent": CONTROLNET_END_PERCENT,
        "controlnet_note": (
            "T-0351 2026-09-10 amendment: OpenPose skeleton per pose "
            "(pose_rig_master_sheet_T0351.render_pose_skeleton), pose conditioning only -- "
            "conditions the positive/negative prompt pair, never the style/identity LoRA or "
            "IP-Adapter model chain. Seven prompt-only attempts (see "
            "ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md) never achieved pose compliance."
        ),
        "negative_prompt": (
            "varies per pose -- see poses[].negative_prompt; every whole-figure panel uses "
            "build_single_pose_negative_prompt (no coat-length ban, per the "
            "dedicated-legs-panel amendment), the legs panel uses "
            "build_legs_panel_negative_prompt (explicit coat ban)"
        ),
        "poses": pose_records,
        "seed": base_seed,
        "steps": 30,
        "cfg": 7.0,
        "width": sheet_width,
        "height": sheet_height,
        "panel_width": width,
        "panel_height": height,
        "entity": entity_name,
        "concept_hash": concept_hash,
        "concept_source": str(entity.concept_sheet_path.relative_to(REPO_ROOT)),
        "method": (
            "Six independent 1024x1024 txt2img generations, one per POSE_SPECS entry "
            "(front T-pose, back T-pose, side-left-forward, side-right-forward, "
            "side-neutral, legs): LoraLoader(soviet_brutalism_style_v1) "
            + ("-> LoraLoader(identity, chained) " if identity_lora_name is not None else "")
            + "-> CLIPTextEncode(positive/negative) -> ControlNetLoader + "
            "ControlNetApplyAdvanced (this pose's own OpenPose skeleton, "
            "pose_rig_master_sheet_T0351, strength "
            f"{CONTROLNET_STRENGTH}/end {CONTROLNET_END_PERCENT}) -> IPAdapterUnifiedLoader + "
            "IPAdapterAdvanced (concept sheet, unchanged weight/crop) -> KSampler -> "
            "VAEDecode -> SaveImage, once per pose. compose_pose_row then stitches the six "
            "resulting images side by side into one sheet by script (DL-30), replacing this "
            "card's first seven attempts (five single-shot five-panel-in-one-image, two "
            "prompt-only single-pose) -- see ARM_MASTER_SHEET_ATTEMPT_LOG_T0351.md and "
            "docs/assets/evidence/T-0351/README.md. ControlNet is for pose conditioning only "
            "(2026-09-10 amendment): it conditions the CLIPTextEncode pair, never the "
            "style/identity LoRA or IP-Adapter model chain, which are byte-identical to "
            "every prompt-only attempt before it. The 2026-09-10 dedicated-legs-panel "
            "amendment adds the sixth 'legs' panel (no coat, trousers and boots -- the "
            "dedicated source for upper_leg/lower_leg) and removes the mid-hip coat clause "
            "from every whole-figure panel's prompt: the character's canonical long coat is "
            "now correct on panels 1-5, not a defect to fight."
        ),
        "generator": "assets/src/character/gen_master_sheet_T0336.py",
        "card": card,
        "spec": (
            "docs/decision-log.md DL-30, pose spec per T-0351 (successor to #365/T-0336; "
            "recipe unchanged except ControlNet/OpenPose for pose conditioning only, per "
            "@DennieSeth's 2026-09-10 amendment after 7 prompt-only attempts failed to "
            "achieve pose compliance; six-panel/dedicated-legs-panel spec per @DennieSeth's "
            "2026-09-10 dedicated-legs-panel amendment, which revokes the earlier mid-hip "
            "coat requirement)"
        ),
        "attempt": attempt,
        "gpu_seconds": round(total_gpu_seconds, 1),
        "promoted": False,
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


# A card generating a differently-posed sheet registers its own prompt
# builder here, keyed by card id -- the CLI's only per-card branch point.
# T-0336's own default (build_positive_prompt) needs no entry.
PROMPT_BUILDERS_BY_CARD: dict[str, Callable[[EntitySpec], str]] = {
    "T-0351": build_limb_pose_prompt,
}
NEGATIVE_PROMPT_BUILDERS_BY_CARD: dict[str, Callable[[], str]] = {
    "T-0351": build_limb_pose_negative_prompt,
}

# Cards using the lever-2 five-separate-generations-composited-by-script
# path (run_five_pose_attempt) instead of the single-shot run_attempt.
FIVE_POSE_CARDS: frozenset[str] = frozenset({"T-0351"})


# T-0351: STILL PLACEHOLDER COORDINATES, NOT YET MEASURED AGAINST A REAL
# SHEET -- must be re-measured against the real pixels of whatever sheet is
# eventually promoted; do not treat these as validated. compose_pose_row
# lays the six POSE_SPECS panels side by side in order, each panel
# 1024x1024, so panel N occupies x:[N*1024, (N+1)*1024). head/upper_arm/
# lower_arm_hand/torso_coat are meant to come from panel 0 (front_tpose, x
# offset 0), since a genuine T-pose holds every limb clear of the torso.
#
# 2026-09-10 dedicated-legs-panel amendment: upper_leg/lower_leg_boot now
# come from panel 5 (the dedicated "legs" panel, x offset 5*1024 = 5120),
# not panel 0 -- panels 1-5 keep the canonical long coat and no longer
# expose the thigh at all, so the front_tpose panel that #365's own
# PLAYER_LIMB_CROP_BOXES ("No upper_leg key") and this card's own
# pre-amendment coordinates targeted is no longer a valid leg source.
PLAYER_LIMB_CROP_BOXES_T0351: dict[str, tuple[int, int, int, int]] = {
    "head": (390, 40, 630, 270),
    "upper_arm": (0, 260, 260, 520),
    "lower_arm_hand": (0, 500, 260, 640),
    "torso_coat": (300, 260, 720, 680),
    "upper_leg": (5450, 640, 5810, 840),
    "lower_leg_boot": (5450, 820, 5810, 1010),
}

# A card with no entry here falls back to the entity's own registered
# `limb_crop_boxes` (T-0336's unchanged default) -- only a card whose pose
# geometry actually differs from #365's needs its own override.
CROP_BOXES_BY_CARD: dict[str, dict[str, tuple[int, int, int, int]]] = {
    "T-0351": PLAYER_LIMB_CROP_BOXES_T0351,
}


def limb_crop_boxes_for(
    card: str, entity_name: str
) -> dict[str, tuple[int, int, int, int]] | None:
    """Resolves which crop-box set `promote_attempt` should composite in --
    a card-specific override (a differently-posed sheet has a different
    pixel layout to crop from) if one is registered, else the entity's own
    default (`EntitySpec.limb_crop_boxes`, T-0336's unchanged behaviour)."""
    if card in CROP_BOXES_BY_CARD:
        return CROP_BOXES_BY_CARD[card]
    return ENTITIES[entity_name].limb_crop_boxes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entity", type=str, default="player", choices=sorted(ENTITIES))
    parser.add_argument("--card", type=str, default="T-0336")
    parser.add_argument("--attempt", type=int, help="attempt number, 1..5")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--style-lora-weight", type=float, default=0.70)
    parser.add_argument("--identity-lora-weight", type=float, default=None)
    parser.add_argument("--ipadapter-weight", type=float, default=0.35)
    parser.add_argument("--width", type=int, default=DEFAULT_MASTER_SHEET_PX)
    parser.add_argument("--height", type=int, default=DEFAULT_MASTER_SHEET_PX)
    parser.add_argument("--notes", type=str, default="")
    parser.add_argument(
        "--promote-attempt",
        type=int,
        help="promote an existing attempt's master sheet into "
        "assets/src/character/master_sheets/ and exit",
    )
    args = parser.parse_args()

    dest_stem = f"{args.entity}_master_sheet_{_card_slug(args.card)}"

    if args.promote_attempt is not None:
        out_dir = out_dir_for(args.card, args.entity, args.promote_attempt)
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        promote_attempt(
            args.entity,
            out_dir,
            provenance,
            dest_stem=dest_stem,
            limb_crop_boxes=limb_crop_boxes_for(args.card, args.entity),
        )
        promoted_record = json.loads(
            (MASTER_SHEETS_DIR / f"{dest_stem}.provenance.json").read_text()
        )
        append_attempt_log(
            promoted_record, notes=args.notes, log_path=attempt_log_path_for(args.card)
        )
        print(f"promoted attempt {args.promote_attempt} -> {MASTER_SHEETS_DIR}")
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --promote-attempt is passed")

    check_attempt_cap(args.attempt, card=args.card)

    if args.card in FIVE_POSE_CARDS:
        provenance = run_five_pose_attempt(
            entity_name=args.entity,
            attempt=args.attempt,
            base_seed=args.seed,
            style_lora_weight=args.style_lora_weight,
            identity_lora_weight=args.identity_lora_weight,
            ipadapter_weight=args.ipadapter_weight,
            width=args.width,
            height=args.height,
            card=args.card,
        )
    else:
        provenance = run_attempt(
            entity_name=args.entity,
            attempt=args.attempt,
            seed=args.seed,
            style_lora_weight=args.style_lora_weight,
            identity_lora_weight=args.identity_lora_weight,
            ipadapter_weight=args.ipadapter_weight,
            width=args.width,
            height=args.height,
            card=args.card,
            prompt_builder=PROMPT_BUILDERS_BY_CARD.get(args.card),
            negative_prompt_builder=NEGATIVE_PROMPT_BUILDERS_BY_CARD.get(args.card),
        )
    append_attempt_log(provenance, notes=args.notes, log_path=attempt_log_path_for(args.card))
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
