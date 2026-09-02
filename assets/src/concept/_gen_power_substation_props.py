"""Generator for T-0244 -- Signal Tower / Power Substation new prop geometry.

Generates the two prop slots this room needs that have no coverage on the
original v1 concept sheet: the transformer housings (cover, x2) and the
breaker panel (switch-locked gate object, docs/design/14-vertical-slice.md
§4). The room's third slot (dedicated hiding spot) reuses the
already-committed `locker_v1` (T-0201/T-0221) and is not touched here.

Goes through the committed RGBA-cutout path
(`tools/comfy-client/src/comfy_client/cutout.py::generate_cutout`) -- not a
hand-transcribed ComfyUI graph -- per this card's own acceptance criterion.
`tools/comfy-client` and `tools/gen-client-base` are not pip-installed in
this environment (no writable cwd for `cd tools/comfy-client && pip install
-e .` under this session's Bash grants); instead their `src/` trees are
added to `sys.path` directly and the real committed modules are imported
unmodified, so `provenance.generator` still resolves to
`tools/comfy-client/src/comfy_client/cutout.py` exactly as the T-0219
resolvability gate expects. Run with a Python 3.12 interpreter that has
`requests`, `numpy`, and `Pillow` installed (this repo runs it via
`~/dev/lora-train-venv/bin/python3`, the LoRA-training venv, which happens
to carry exactly those three packages already).

Each new prop's prompt/negative_prompt is copied **verbatim** from
`signal_tower_props_concept_sheet_v3.recipe.json`'s own reviewed sub-panel
text (`panels[1].sub_panels`) -- the same "reuse the approved sheet's own
prompt" pattern T-0243 used for `archive_shelving_v1` -- rather than being
freshly authored, since that text is what DL-5 approval actually covers.
Only the seed changes (cutout generation is independent of the sheet's own
generation, per T-0243 precedent) and the target dimensions (game-pixel
cutout size, not the sheet's 768x768 panel canvas).

Usage (from repo root):
    ~/dev/lora-train-venv/bin/python3 assets/src/concept/_gen_power_substation_props.py

Outputs (committed, not gitignored):
    assets/final/props/signal_tower/transformer_housing_a_v1.png(.provenance.json)
    assets/final/props/signal_tower/transformer_housing_b_v1.png(.provenance.json)
    assets/final/props/signal_tower/breaker_panel_v1.png(.provenance.json)
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

# Verbatim from signal_tower_props_concept_sheet_v3.recipe.json panels[1].sub_panels
_TRANSFORMER_A_PROMPT = (
    "single isolated game prop, flat side elevation view, orthographic, no perspective, "
    "no vanishing point, plain flat concrete-grey backdrop, no other objects, no scene, "
    "no text, no diagram, no colour swatches, no palette chips, no pedestal, no sculpture. "
    "A squat horizontal industrial transformer housing tank, a simple sealed rectangular "
    "metal box, low and wide, much wider than tall, flat rectangular top with sharp square "
    "corners, a row of horizontal cooling fins along its lower side, completely flush "
    "featureless front face otherwise, no doors, no hinges, no handles, no legs, no feet, "
    "no rounded base, no beveled roof, no booth shape, mid-value grey-green painted heavy "
    "metal, sitting flush on the ground with no visible gap underneath, opaque solid inert "
    "blocky form -- an electrical cover prop, not an enclosure, not a piece of furniture. "
    "Soviet brutalist industrial palette, hard value separation, flat unlit shading, one "
    "single object filling most of the frame, no gradients, no chrome, no photorealism, "
    "no humans, no vehicles."
)
_TRANSFORMER_A_NEGATIVE = (
    "kiosk, booth, phone booth, sentry box, rounded base, pedestal base, feet, stubby legs, "
    "beveled roof, angled roof, sloped roof, locker, wardrobe, cabinet, filing cabinet, "
    "storage cabinet, hinged door, door, door handle, latch, louvre vent, vertical louvres, "
    "legs, stand, tall narrow, taller than wide, standing height, server rack, relay "
    "cabinet, crate stack, HVAC duct, multiple objects, several objects, grid of objects, "
    "scattered objects, collage, sheet, array, breakdown, exploded view, colour swatches, "
    "colour chips, palette strip, pedestal, plinth display, sphere, ball, abstract "
    "sculpture, art installation, control panel, switch panel, breaker panel, instrument "
    "panel, dashboard, gauge cluster, dial, window, porthole, hatch, cockpit, notch, "
    "cutout, irregular shape, blueprint, technical schematic, wireframe, CAD drawing, line "
    "art, monochrome line drawing, refrigerator appliance branding, pink, salmon, warm "
    "background, white background, beige background, building, architecture, tower, "
    "skyscraper, silo, chimney, lighthouse, rocket, robot, mecha, tank, military vehicle, "
    "humanoid figure, character, creature, car, vehicle, product photography, chrome, "
    "glossy, photorealistic, 3d render, perspective, vanishing point, text, watermark, "
    "blurry, low quality"
)
_TRANSFORMER_B_PROMPT = (
    "single isolated game prop, flat side elevation view, orthographic, no perspective, "
    "no vanishing point, plain flat concrete-grey backdrop, no other objects, no scene, no "
    "text, no diagram, no colour swatches, no palette chips, no pedestal, no sculpture, no "
    "creature, no figure of any kind. A squat horizontal industrial transformer housing "
    "tank, a simple sealed rectangular metal box, low and wide, much wider than tall, "
    "flat-topped with a shallow bolted top plate and a row of horizontal cooling fins along "
    "its lower side, completely flush featureless front face otherwise, no doors, no "
    "hinges, no handles, no legs, no feet, no limbs, no head, no eyes, mid-value grey-green "
    "painted heavy metal, sitting flush on the ground with no visible gap underneath, "
    "opaque solid inert blocky form -- an electrical cover prop, not an enclosure, not a "
    "piece of furniture, not a machine that moves. Soviet brutalist industrial palette, "
    "hard value separation, flat unlit shading, one single object filling most of the "
    "frame, no gradients, no chrome, no photorealism, no humans, no vehicles."
)
_TRANSFORMER_B_NEGATIVE = (
    "robot, mecha, mech, gundam, transformer robot, giant robot, humanoid mecha, biped, "
    "quadruped, walking machine, legs, limbs, arms, head, face, eyes, visor, antenna "
    "weapon, gun, cannon, turret, weapon, blaster, laser, creature, animal, insect, "
    "spider, character, figurine, action figure, toy, statue, locker, wardrobe, cabinet, "
    "filing cabinet, storage cabinet, hinged door, door, door handle, latch, louvre vent, "
    "vertical louvres, stand, tall narrow, taller than wide, standing height, server rack, "
    "relay cabinet, crate stack, HVAC duct, multiple objects, several objects, grid of "
    "objects, scattered objects, collage, sheet, array, breakdown, exploded view, colour "
    "swatches, colour chips, palette strip, pedestal, plinth display, sphere, ball, "
    "abstract sculpture, art installation, control panel, switch panel, breaker panel, "
    "instrument panel, dashboard, gauge cluster, dial, window, porthole, hatch, cockpit, "
    "notch, cutout, irregular shape, blueprint, technical schematic, wireframe, CAD "
    "drawing, line art, monochrome line drawing, refrigerator appliance branding, pink, "
    "salmon, warm background, white background, beige background, building, architecture, "
    "tower, skyscraper, silo, chimney, lighthouse, rocket, tank, military vehicle, "
    "humanoid figure, car, vehicle, product photography, chrome, glossy, photorealistic, "
    "3d render, perspective, vanishing point, text, watermark, blurry, low quality"
)
_BREAKER_PROMPT = (
    "single isolated game prop, exactly one object, flat side elevation view, orthographic, "
    "no perspective, no vanishing point, plain flat concrete-grey backdrop, no other "
    "objects, no scene, no text, no diagram, no multiple panels, no collage, no catalog "
    "page, no repeating pattern. One single small wall-mounted breaker panel plate, a "
    "single rectangular flat institutional-green painted plate mounted flush against a "
    "flat concrete wall segment, exactly three small square switches in one single "
    "horizontal row across its face with one small round indicator lamp above each switch, "
    "nothing else on the plate -- a switch-locked gate object, one isolated object filling "
    "most of the frame. Soviet brutalist industrial palette, muted institutional green and "
    "near-black, hard value separation, flat unlit shading, no atmospheric haze, no depth "
    "of field, one single object study, no background scene composition."
)
_BREAKER_NEGATIVE = (
    "locker, server rack, relay cabinet, crate stack, HVAC duct, multiple panels, several "
    "panels, dozens of switches, many switches, repeated switches, grid, tiled, tiling, "
    "rows and columns, grid of panels, grid of switches, collage, catalog page, product "
    "sheet, montage, breakdown, exploded view, array, sheet, documentation, pink, salmon, "
    "warm background, orange background, brown background, white background, beige "
    "background, illegible glyphs, speckled texture, noise texture, fragments, "
    "disconnected pieces, perspective, vanishing point, three-quarter view, isometric, "
    "receding walls, atmospheric haze, depth of field, sky, clouds, foliage, scene, "
    "composed illustration, photorealistic, 3d render, soft gradient lighting, ambient "
    "occlusion, painterly, bright saturated colors, cartoon, cheerful, text, watermark, "
    "signature, blurry, low quality, humanoid figure, player character, entities, watcher, "
    "sound, still air, face, portrait, tower, building, skyscraper, robot, mecha, tank, "
    "vehicle, car, refrigerator, appliance, safe, vault, tall cabinet, humanoid, character"
)


def main() -> None:
    concept_hash = hashlib.sha256(V3_SHEET_PATH.read_bytes()).hexdigest()
    concept_source = "assets/src/concept/signal_tower_props_concept_sheet_v3.png"

    jobs = [
        dict(
            name="transformer_housing_a_v1",
            prompt=_TRANSFORMER_A_PROMPT,
            negative_prompt=_TRANSFORMER_A_NEGATIVE,
            # seed=24501 (first attempt) matted to only 9.4% opaque -- the
            # background cutout keyed out most of the object, leaving
            # disconnected edge fragments, not a solid prop. Re-rolled
            # (24511/24521/24531/24541/24551/24571 all rejected on visual
            # review -- fragmented, weapon-like, or window/porthole drift);
            # 24561 renders a clean solid rectangular tank, matte opaque
            # fraction 0.875, matching the prompt's "sealed rectangular
            # metal box ... sitting flush on the ground" shape.
            seed=24561,
            width=44,
            height=24,
            prop_class="cover",
        ),
        dict(
            name="transformer_housing_b_v1",
            prompt=_TRANSFORMER_B_PROMPT,
            negative_prompt=_TRANSFORMER_B_NEGATIVE,
            seed=24502,
            width=44,
            height=24,
            prop_class="cover",
        ),
        dict(
            name="breaker_panel_v1",
            prompt=_BREAKER_PROMPT,
            negative_prompt=_BREAKER_NEGATIVE,
            seed=24503,
            width=20,
            height=18,
            prop_class="gate",
        ),
    ]

    for job in jobs:
        recipe = Recipe(
            prompt=job["prompt"],
            negative_prompt=job["negative_prompt"],
            seed=job["seed"],
            steps=30,
            cfg=7.0,
            width=job["width"],
            height=job["height"],
            checkpoint=CHECKPOINT,
            sampler="euler",
            scheduler="normal",
            name=job["name"],
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
            extra={"prop_class": job["prop_class"]},
        )
        print(f"{job['name']}: {result.path} (prompt_id={result.prompt_id})")
        print(f"  provenance: {asdict(result.provenance)['output_hash']}")


if __name__ == "__main__":
    main()
