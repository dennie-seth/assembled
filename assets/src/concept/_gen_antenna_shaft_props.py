"""Generator for T-0246 -- Signal Tower / Antenna Shaft new prop geometry.

Generates the one prop slot this room needs that has no coverage on the
original v1 concept sheet: the hiding alcove (docs/design/14-vertical-slice.md
§10 -- "At least one hiding alcove partway up -- the room's only reliable
safety valve" against The Still Air, which runs a fixed patrol lap with no
LOS check, so a free-standing cover prop or locker cannot substitute for an
alcove set into the shaft wall). The room's other slot (shaft-wall duct
dressing) reuses the already-committed `low_duct_v1` (T-0201/T-0221) and is
not touched here.

Goes through the committed RGBA-cutout path
(`tools/comfy-client/src/comfy_client/cutout.py::generate_cutout`) -- not a
hand-transcribed ComfyUI graph -- per this card's own acceptance criterion.
`tools/comfy-client` and `tools/gen-client-base` are not pip-installed in
this environment; instead their `src/` trees are added to `sys.path`
directly and the real committed modules are imported unmodified, so
`provenance.generator` still resolves to
`tools/comfy-client/src/comfy_client/cutout.py` exactly as the T-0219
resolvability gate expects (same approach as T-0244's/T-0245's own
generator scripts). Run with a Python 3.12 interpreter that has `requests`,
`numpy`, and `Pillow` installed (this repo runs it via
`~/dev/lora-train-venv/bin/python3`).

The prompt/negative_prompt is a **verbatim** copy of
`signal_tower_props_concept_sheet_v3.recipe.json`'s own reviewed
"HIDING ALCOVE -- HIDING SPOT" sub-panel text (`panels[3]`, seed 23121) --
the same "reuse the approved sheet's own prompt" pattern T-0243/T-0244/T-0245
used -- since that text is what DL-5 approval actually covers. This is a
*distinct* sub-panel from the sibling "CRAWLSPACE OPENING -- HIDING SPOT"
sub-panel (`panels[2]`, seed 21203) T-0245 already used for Equipment
Floor's crawlspace_v1 -- the two rooms' hiding-spot slots resolve to two
different approved sub-panels, not the same one reused twice. The alcove
panel is already flat/orthographic by construction (a recess cut into a
wall has no depth to foreshorten), so no art-direction amendment was needed
for the 2026-09-02 "no isometry or perspective" re-gate the way the
transformer housings needed one -- confirmed by visual inspection of the
generated sprite below, not assumed from the prompt text.

Usage (from repo root):
    ~/dev/lora-train-venv/bin/python3 assets/src/concept/_gen_antenna_shaft_props.py

Outputs (committed, not gitignored):
    assets/final/props/signal_tower/hiding_alcove_v1.png(.provenance.json)
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

# Verbatim copy of signal_tower_props_concept_sheet_v3.recipe.json
# panels[3] (row=1, col=1, label="HIDING ALCOVE -- HIDING SPOT")'s
# reviewed prompt/negative_prompt text. Only the cutout target
# width/height/seed differ from the sheet's own 768x768 sub-panel
# generation.
_ALCOVE_PROMPT = (
    "single isolated game prop, flat side elevation view, orthographic, no "
    "perspective, no vanishing point, plain flat concrete-grey backdrop, no "
    "other objects, no scene, no text, no diagram, no documentation, no "
    "inset panels, no colour swatches. Hiding alcove: an empty rectangular "
    "recess cut straight into a flat concrete wall panel, single-occupant "
    "standing height and width, no door, no hatch, no doorway frame, no "
    "cover, no ornamentation, no emblem -- just a plain rectangular hole in "
    "the wall whose interior is rendered completely near-black and dark, "
    "only a thin lit edge visible around the opening rim where the recess "
    "meets the flat wall surface, a hiding spot for a person to stand "
    "inside. Soviet brutalist industrial palette, near-black and dark "
    "concrete-grey, hard value separation, flat unlit shading, one single "
    "object filling most of the frame, no gradients, no chrome, no "
    "photorealism, no humans, no vehicles."
)
_ALCOVE_NEGATIVE = (
    "text, watermark, caption, label, diagram, documentation, page layout, "
    "exploded diagram, inset panel, thumbnail, key, legend, logo, "
    "signature, multiple panels, side panel, sidebar, annotation, callout, "
    "door, gate, portal, doorway, hatch, frame, ornate, emblem, insignia, "
    "circular emblem, badge, decoration, character select, icon grid, "
    "blueprint, technical schematic, wireframe, CAD drawing, line art, "
    "monochrome line drawing, grid, repeating panels, facade, elevation of "
    "many bays, architectural facade, floor plan, multiple rooms, "
    "building, architecture, tower, skyscraper, car, vehicle, white "
    "background, product photography, bright, light-coloured, chrome, "
    "glossy, photorealistic, 3d render, perspective, vanishing point, "
    "blurry, low quality, humanoid figure, interior scene, room interior, "
    "furniture"
)


def main() -> None:
    concept_hash = hashlib.sha256(V3_SHEET_PATH.read_bytes()).hexdigest()
    concept_source = "assets/src/concept/signal_tower_props_concept_sheet_v3.png"

    recipe = Recipe(
        prompt=_ALCOVE_PROMPT,
        negative_prompt=_ALCOVE_NEGATIVE,
        # Standing-height recess, distinct in silhouette from the room's
        # cover prop (low_duct_v1, 48x12, wide flat horizontal duct) and
        # from the other rooms' standing hiding props (locker_v1 14x42,
        # server_rack_v1 20x46) -- narrower than a locker since it is a
        # recess cut into a wall plane, not a free-standing enclosure.
        #
        # Seed search, all visually reviewed via 10x nearest-neighbour
        # upscale before commit. The sheet's own sub-panel seed (23121)
        # was tried first, verbatim prompt/negative -- the raw 768x768
        # generation itself was clean (a flat concrete wall with a dark
        # standing recess, no isometry), but the border-seeded background
        # cutout (tools/comfy_client/transparency.py) grew through the
        # soft blur between the recess interior and the grey wall border
        # at this small 20x40 target size and matted away most of the
        # subject, leaving only 14.6% opaque fragments (a thin bracket
        # outline, not a usable prop) -- the same class of matting failure
        # T-0244/T-0245 saw on other sub-panels at small cutout sizes.
        # Re-seeded at the same prompt/negative text (still the approved
        # sub-panel's own wording, DL-5 coverage unchanged): 23131/23141/
        # 23151 all produced clean, coherent, non-fragmented flat-elevation
        # recesses (62-66% opaque). seed=23131 has the cleanest silhouette
        # and the widest 16px luma gap against low_duct_v1 (114.1, vs 74.9
        # and 96.8 for the other two) -- comfortably clear of the 15.0 P-3
        # floor. This is the committed result.
        seed=23131,
        steps=30,
        cfg=7.0,
        width=20,
        height=40,
        checkpoint=CHECKPOINT,
        sampler="euler",
        scheduler="normal",
        name="hiding_alcove_v1",
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
    print(f"hiding_alcove_v1: {result.path} (prompt_id={result.prompt_id})")
    print(f"  provenance: {asdict(result.provenance)['output_hash']}")


if __name__ == "__main__":
    main()
