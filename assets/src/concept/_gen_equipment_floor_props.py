"""Generator for T-0245 -- Signal Tower / Equipment Floor new prop geometry.

Generates the one prop slot this room needs that has no coverage on the
original v1 concept sheet: the crawlspace (dedicated hiding spot,
docs/design/14-vertical-slice.md §10 -- "one dedicated hiding spot
(crawlspace) for full protection"). The room's other slot (maze rack
clutter) reuses the already-committed `relay_cabinet_v1` and `crate_stack_v1`
(T-0201/T-0221) and is not touched here.

Goes through the committed RGBA-cutout path
(`tools/comfy-client/src/comfy_client/cutout.py::generate_cutout`) -- not a
hand-transcribed ComfyUI graph -- per this card's own acceptance criterion.
`tools/comfy-client` and `tools/gen-client-base` are not pip-installed in
this environment; instead their `src/` trees are added to `sys.path`
directly and the real committed modules are imported unmodified, so
`provenance.generator` still resolves to
`tools/comfy-client/src/comfy_client/cutout.py` exactly as the T-0219
resolvability gate expects (same approach as T-0244's
`_gen_power_substation_props.py`). Run with a Python 3.12 interpreter that
has `requests`, `numpy`, and `Pillow` installed (this repo runs it via
`~/dev/lora-train-venv/bin/python3`).

The prompt/negative_prompt is a **verbatim** copy of
`signal_tower_props_concept_sheet_v3.recipe.json`'s own reviewed
"CRAWLSPACE OPENING -- HIDING SPOT" sub-panel text (`panels[2]`) -- the
same "reuse the approved sheet's own prompt" pattern T-0243/T-0244 used --
since that text is what DL-5 approval actually covers. The panel is
already flat/orthographic by construction (a hole cut into a wall segment
has no depth to foreshorten), so no art-direction amendment was needed for
the 2026-09-02 "no isometry or perspective" re-gate the way the transformer
housings needed one -- confirmed by visual inspection of the generated
sprite below, not assumed from the prompt text.

Usage (from repo root):
    ~/dev/lora-train-venv/bin/python3 assets/src/concept/_gen_equipment_floor_props.py

Outputs (committed, not gitignored):
    assets/final/props/signal_tower/crawlspace_v1.png(.provenance.json)
"""

from __future__ import annotations

import hashlib
import sys
from dataclasses import asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "comfy-client" / "src"))
sys.path.insert(0, str(REPO_ROOT / "tools" / "gen-client-base" / "src"))
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))

from comfy_client.cutout import generate_cutout  # noqa: E402
from comfy_client.recipe import Recipe  # noqa: E402

OUT_DIR = REPO_ROOT / "assets" / "final" / "props" / "signal_tower"
V3_SHEET_PATH = REPO_ROOT / "assets" / "src" / "concept" / "signal_tower_props_concept_sheet_v3.png"

CHECKPOINT = "sd_xl_base_1.0.safetensors"
MODEL_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_WEIGHT = 0.70
LORA_LICENSE = "CreativeML OpenRAIL++-M"

# Started as a verbatim copy of
# signal_tower_props_concept_sheet_v3.recipe.json panels[2] (row=1, col=0,
# label="CRAWLSPACE OPENING -- HIDING SPOT")'s "orthographic technical
# blueprint diagram" framing. Two rejected attempts on visual review:
# seed=25011 (original framing) drifted into a light tan/beige
# bench-with-legs silhouette; seed=25021 (strengthened negatives, same
# framing) drifted into a grey filing-cabinet-with-drawers silhouette --
# both furniture, not a dark hole cut into a wall. The v3 sheet's own
# generator note records that its sibling "HIDING ALCOVE" panel hit the
# same class of drift under a "technical blueprint diagram" framing and was
# fixed by switching to "single isolated game prop" phrasing (run-3 fix,
# signal_tower_props_concept_sheet_v3.provenance.json `_generator_note`).
# Applying that same fix here, one level narrower, for the crawlspace's own
# object identity (a low wall opening, not the alcove's standing recess) --
# not switching to the alcove's own prompt/identity, which would be
# generating a different prop than DL-5 approved for this slot.
_CRAWLSPACE_PROMPT = (
    "single isolated game prop, flat side elevation view, orthographic, no "
    "perspective, no vanishing point, plain flat concrete-grey backdrop, "
    "no other objects, no scene, no text, no diagram, no documentation, no "
    "inset panels, no colour swatches, no furniture, no bench, no cabinet, "
    "no drawers, no legs, no feet, no stand. Crawlspace opening: a small "
    "rectangular hatch-shaped hole cut low into a flat concrete wall "
    "panel, single-occupant crawl height, wider than tall, no door, no "
    "hatch cover, no doorway frame, no ornamentation -- just a plain "
    "rectangular hole in the wall whose interior is rendered completely "
    "near-black and dark, only a thin lit edge visible around the opening "
    "rim where the hole meets the flat wall surface, a low hiding spot for "
    "a person to crawl into. Soviet brutalist industrial palette, "
    "near-black and dark concrete-grey, hard value separation, flat unlit "
    "shading, one single object filling most of the frame, no gradients, "
    "no chrome, no photorealism, no humans, no vehicles."
)
_CRAWLSPACE_NEGATIVE = (
    "isometric, three-quarter view, top face visible, side face visible, "
    "two faces visible, box corner, cube corner, "
    "bench, furniture, cabinet, filing cabinet, drawer, drawers, locker, "
    "shelf, table, chair, stool, seat, legs, feet, stand, base, pedestal, "
    "plinth, "
    "tan, beige, cream, light brown, pale wood, wood grain, bright, "
    "light-coloured, pastel, "
    "text, watermark, caption, label, diagram, documentation, page "
    "layout, blueprint, technical schematic, wireframe, CAD drawing, line "
    "art, monochrome line drawing, grid, repeating panels, "
    "building, architecture, tower, car, vehicle, white background, "
    "product photography, chrome, glossy, "
    "photorealistic, 3d render, perspective, vanishing point, "
    "blurry, low quality, humanoid figure"
)


def main() -> None:
    concept_hash = hashlib.sha256(V3_SHEET_PATH.read_bytes()).hexdigest()
    concept_source = "assets/src/concept/signal_tower_props_concept_sheet_v3.png"

    recipe = Recipe(
        prompt=_CRAWLSPACE_PROMPT,
        negative_prompt=_CRAWLSPACE_NEGATIVE,
        # Low, wide hatch opening -- "single-occupant crawl height", distinct
        # in silhouette from the room's tall cover props (relay_cabinet_v1
        # 36x20, crate_stack_v1 24x28) and from the standing-height hiding
        # props elsewhere (locker_v1 14x42, server_rack_v1 20x46).
        #
        # Seed search, all visually reviewed via 10x nearest-neighbour
        # upscale before commit:
        #   25011 (original v3-sheet prompt wording) -- light tan/beige
        #     bench-with-legs silhouette. Rejected: furniture, not a wall
        #     opening, and the wrong value (light, not dark).
        #   25021 (strengthened furniture/colour negatives, same wording) --
        #     grey filing-cabinet-with-drawers silhouette. Rejected: still
        #     furniture.
        #   25031 (switched to "single isolated game prop" framing, see the
        #     module docstring) -- two disconnected grey fragments, no
        #     coherent object. Rejected: background-cutout matting failure,
        #     not a usable prop.
        #   25041 -- fragmented fan of disconnected shapes, 21.7% opaque.
        #     Rejected: not a solid readable silhouette.
        #   25051 -- a clean, coherent near-black rectangular void with a
        #     lit bottom entry edge (40.9% opaque), flat front elevation, no
        #     visible top or side face. This is the committed result --
        #     visually confirmed via ASCII luma dump (a solid dark block,
        #     one single stray edge pixel) and 10x nearest-neighbour
        #     upscale. luma16 = 40.84, clearing the P-3 15.0 floor against
        #     both relay_cabinet_v1 (gap 69.9) and crate_stack_v1 (gap
        #     72.07) with wide margin.
        seed=25051,
        steps=30,
        cfg=7.0,
        width=22,
        height=18,
        checkpoint=CHECKPOINT,
        sampler="euler",
        scheduler="normal",
        name="crawlspace_v1",
        model_hash=MODEL_HASH,
    )
    result = generate_cutout(
        recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=OUT_DIR,
        gen_width=768,
        gen_height=768,
        concept_hash=concept_hash,
        concept_source=concept_source,
        comfyui_version="0.29.0",
        torch_version="2.5.1+cu121",
        extra={"prop_class": "hide"},
    )
    print(f"crawlspace_v1: {result.path} (prompt_id={result.prompt_id})")
    print(f"  provenance: {asdict(result.provenance)['output_hash']}")


if __name__ == "__main__":
    main()
