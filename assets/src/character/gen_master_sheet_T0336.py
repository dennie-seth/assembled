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
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reused directly from Arm A (T-0228) -- checkpoint/LoRA/IP-Adapter
# identifiers and the HTTP client helpers are unchanged.
from gen_arm_a_idle_T0228 import (  # noqa: E402
    CHECKPOINT,
    CHECKPOINT_HASH,
    CHECKPOINT_LICENSE,
    CHECKPOINT_LICENSE_ALLOWLIST,
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
    just repeated whole-figure poses. See `ARM_MASTER_SHEET_ATTEMPT_LOG_T0336.md`
    for the attempts this was compared against."""
    return (
        f"{entity.trigger_token}, exploded parts diagram, disassembled equipment "
        f"breakdown sheet, {entity.costume_description}, same uniform and same equipment "
        "loadout, consistent identity, flat uniform neutral grey background, flat even "
        "lighting, no cast shadow, no perspective, clean readable outline, three "
        "whole-figure turnaround views at the top -- front view, side view, back view -- "
        "and below them separate disassembled equipment pieces laid flat side by side with "
        "empty space between each piece so nothing overlaps or touches: a severed upper arm "
        "sleeve piece by itself, a severed lower arm and glove piece by itself, a severed "
        "upper leg piece by itself, a severed lower leg and boot piece by itself, a hood and "
        "head piece by itself, a torso and coat piece by itself, no text, no UI, no watermark"
    )


def build_negative_prompt() -> str:
    """`MAIN_NEGATIVE` (T-0249) already forbids perspective and inconsistent
    identity; this adds the master-sheet-specific defects (a whole-figure
    view getting composited/cropped instead of laid out as its own clean
    panel)."""
    return (
        MAIN_NEGATIVE
        + ", cropped limbs, cropped figure, overlapping panels, panels touching, "
        "different costume between panels, different colour between panels"
    )


# ── Graph node ids -- named, not raw string literals re-derived per call ────
CHECKPOINT_NODE_ID = "1"
STYLE_LORA_NODE_ID = "11"
IDENTITY_LORA_NODE_ID = "12"
POSITIVE_PROMPT_NODE_ID = "13"
NEGATIVE_PROMPT_NODE_ID = "14"
CONCEPT_IMAGE_NODE_ID = "17"
IPADAPTER_LOADER_NODE_ID = "18"
IPADAPTER_NODE_ID = "19"
LATENT_NODE_ID = "20"
SAMPLER_NODE_ID = "21"
VAE_DECODE_NODE_ID = "22"
MAIN_SAVE_NODE_ID = "23"

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
) -> dict:
    """txt2img + style LoRA at 1024, IP-Adapter on the approved concept
    sheet, NO ControlNet (DL-30 / this card's own scope). The identity LoRA
    is optional and, when present, chains after the style LoRA -- an enemy
    entity with no trained identity LoRA yet (`identity_lora_name=None`)
    still gets a graph, just without that node."""
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

    g[CONCEPT_IMAGE_NODE_ID] = {
        "class_type": "LoadImage",
        "inputs": {"image": concept_filename},
    }
    g[IPADAPTER_LOADER_NODE_ID] = {
        "class_type": "IPAdapterUnifiedLoader",
        "inputs": {"model": model_source, "preset": IPADAPTER_PRESET},
    }
    g[IPADAPTER_NODE_ID] = {
        "class_type": "IPAdapterAdvanced",
        "inputs": {
            "model": [IPADAPTER_LOADER_NODE_ID, 0],
            "ipadapter": [IPADAPTER_LOADER_NODE_ID, 1],
            "image": [CONCEPT_IMAGE_NODE_ID, 0],
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
            "positive": [POSITIVE_PROMPT_NODE_ID, 0],
            "negative": [NEGATIVE_PROMPT_NODE_ID, 0],
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


def check_attempt_cap(attempt: int) -> None:
    """~25-50 GPU-second budget: a small job, not a sweep -- T-0272/T-0317's
    own 84-attempt failure mode is exactly what this card's own scope
    section warns against repeating. Cap stays at 5."""
    if not (1 <= attempt <= 5):
        raise SystemExit(
            "attempt cap is 5 -- this card's own budget is ~25-50 GPU-seconds, a small "
            "job, not a sweep (see T-0272/T-0317's 84-attempt failure mode); refusing to "
            "run further attempts"
        )


# ── Attempt log + promotion bookkeeping ─────────────────────────────────

ATTEMPT_LOG_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "ARM_MASTER_SHEET_ATTEMPT_LOG_T0336.md"
)
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


def append_attempt_log(provenance: dict, notes: str = "") -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['entity']} | {provenance['seed']} "
        f"| {provenance['style_lora_weight']} | {provenance.get('identity_lora_weight')} "
        f"| {provenance['ip_adapter_weight']} | {provenance['width']} "
        f"| {provenance['height']} | {provenance['gpu_seconds']} "
        f"| {'yes' if provenance.get('promoted') else 'no'} | {notes} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


def promote_attempt(entity_name: str, out_dir: Path, provenance: dict) -> None:
    """Copy this attempt's master sheet + provenance into
    assets/src/character/master_sheets/ -- master sheets are pipeline
    inputs, not game-scale finals, so they land under assets/src/, not
    assets/final/ (this card's own acceptance criterion)."""
    MASTER_SHEETS_DIR.mkdir(parents=True, exist_ok=True)
    dest_png = MASTER_SHEETS_DIR / f"{entity_name}_master_sheet_T0336.png"
    dest_png.write_bytes((out_dir / "master_sheet_1024.png").read_bytes())

    promoted = dict(provenance)
    promoted["promoted"] = True
    dest_json = MASTER_SHEETS_DIR / f"{entity_name}_master_sheet_T0336.provenance.json"
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

    out_dir = (
        REPO_ROOT / "assets" / "out" / "master_sheet_T0336" / entity_name / f"attempt_{attempt}"
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    positive_text = build_positive_prompt(entity)
    negative_text = build_negative_prompt()

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
            "background; layout is not script-composited at this tier."
        ),
        "generator": "assets/src/character/gen_master_sheet_T0336.py",
        "card": "T-0336",
        "spec": "docs/decision-log.md DL-30",
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "promoted": False,
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entity", type=str, default="player", choices=sorted(ENTITIES))
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

    if args.promote_attempt is not None:
        out_dir = (
            REPO_ROOT
            / "assets"
            / "out"
            / "master_sheet_T0336"
            / args.entity
            / f"attempt_{args.promote_attempt}"
        )
        provenance = json.loads((out_dir / "provenance_candidate.json").read_text())
        promote_attempt(args.entity, out_dir, provenance)
        promoted_record = json.loads(
            (MASTER_SHEETS_DIR / f"{args.entity}_master_sheet_T0336.provenance.json").read_text()
        )
        append_attempt_log(promoted_record, notes=args.notes)
        print(f"promoted attempt {args.promote_attempt} -> {MASTER_SHEETS_DIR}")
        return

    if args.attempt is None or args.seed is None:
        parser.error("--attempt and --seed are required unless --promote-attempt is passed")

    check_attempt_cap(args.attempt)

    provenance = run_attempt(
        entity_name=args.entity,
        attempt=args.attempt,
        seed=args.seed,
        style_lora_weight=args.style_lora_weight,
        identity_lora_weight=args.identity_lora_weight,
        ipadapter_weight=args.ipadapter_weight,
        width=args.width,
        height=args.height,
    )
    append_attempt_log(provenance, notes=args.notes)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
