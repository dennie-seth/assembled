"""Signal Tower prop-pack generation recipes (T-0233, HANDOFF §23-j).

The committed *source* (P-3, docs/design/13-asset-pipeline.md: "sources
(assets/src/ recipes) and curated finals (assets/final/) are committed")
for every prop under assets/final/props/signal_tower/. Transcribes the
exact prompt/negative_prompt/seed/dimensions each prop's committed
`.provenance.json` already records.

This closes a real gap T-0221/T-0223 left open: both regenerated props by
submitting a `comfy_client.cutout` workflow directly to the ComfyUI
`/prompt` API, but neither committed the script/data that built the
per-prop `Recipe` -- only the reusable engine (`tools/comfy-client/src/
comfy_client/cutout.py`) was committed, not the recipe itself. That made
the pack real, reproducible-in-principle SDXL output, but not literally
reproducible from anything checked in -- a one-off invocation each time,
violating P-3/P-7 ("no one-off uncommitted script").

`width`/`height` below are the GAME-pixel dimensions passed as
`Recipe.width`/`height` (the `ImageScale` node's resize target, per
`comfy_client.cutout.render_cutout_workflow`); `gen_width`/`gen_height`
are the SDXL-safe generation dimensions, matching what each prop's own
`.provenance.json` records in its `width`/`height` fields.

Regenerate the full pack (requires a reachable ComfyUI instance and
`tools/comfy-client` installed):

    python assets/src/props/signal_tower_prop_recipes.py

This module only imports `comfy_client` lazily, inside `_build_recipe`/
`generate_all` -- the data itself (`PROP_RECIPES`, `CONCEPT_HASH`,
`CONCEPT_SOURCE`) stays importable without comfy-client installed, so the
prop-pack test suite (`assets/src/concept/tests`) can check this data
against the committed provenance sidecars without needing the generation
stack.
"""

from __future__ import annotations

CHECKPOINT = "sd_xl_base_1.0.safetensors"
MODEL_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_WEIGHT = 0.70
LORA_LICENSE = "Apache-2.0"

#: The approved prop concept sheet (T-0211) every recipe below is
#: directionally conditioned on. `concept_hash` is that sheet's own
#: `concept_hash` (assets/src/concept/signal_tower_props_concept_sheet_v1
#: .provenance.json) -- P-7 compliance requires this to resolve, not just
#: `generator`/`model_hash` (docs/decision-log.md).
CONCEPT_SOURCE = "assets/src/concept/signal_tower_props_concept_sheet_v1.png"
CONCEPT_HASH = "da676d790f923bcb266225c96445b1be26bec56b0b651befd0c254415fbe87a4"

_NEG_GENERIC = (
    "perspective, vanishing point, isometric, background, scene, "
    "depth of field, ambient occlusion, photorealistic, 3d render, "
    "multiple props, composed illustration, text, watermark"
)

#: One entry per prop currently committed under
#: assets/final/props/signal_tower/. Cover props block the sight cone only
#: (partial protection); hide props are dedicated single-occupant hiding
#: spots that block all sensors once entered cleanly (docs/design/11 §2).
PROP_RECIPES = [
    {
        "name": "relay_cabinet_v1",
        "prop_class": "cover",
        "prompt": (
            "flat side-on relay junction cabinet sprite, cover prop (sight-cone "
            "block only), Signal Tower interior. 36x20 game px RGBA cutout. Wide "
            "squat form: mid-value concrete grey body (ramp10), darker left shadow "
            "side (ramp06), lit top face (ramp12), institutional-green accent "
            "stripe at mid-height (ramp07). Exposed top and sides - player "
            "crouches behind for sight-cone cover only, sound sensors still "
            "detect. Soviet brutalist, hard value separation."
        ),
        "negative_prompt": _NEG_GENERIC,
        "seed": 7221004,
        "width": 36,
        "height": 20,
        "gen_width": 576,
        "gen_height": 320,
    },
    {
        "name": "crate_stack_v1",
        "prop_class": "cover",
        "prompt": (
            "flat side-on two-crate equipment stack sprite, cover prop "
            "(sight-cone block only), Signal Tower interior. 24x28 game px RGBA "
            "cutout. Bottom crate rows 11-27, top crate slightly narrower rows "
            "0-10. Visible seam line. Mid-value concrete grey (ramp10 body, "
            "ramp06 side, ramp12 top). Fully exposed from above - cover only, "
            "not a hiding spot. Soviet brutalist style, flat lighting, hard "
            "value edges."
        ),
        "negative_prompt": _NEG_GENERIC,
        "seed": 7221001,
        "width": 24,
        "height": 28,
        "gen_width": 512,
        "gen_height": 576,
    },
    {
        "name": "low_duct_v1",
        "prop_class": "cover",
        "prompt": (
            "flat side-on horizontal HVAC duct segment sprite, cover prop "
            "(sight-cone block only), Signal Tower interior. 48x12 game px RGBA "
            "cutout. Wide flat horizontal form. Duct body: darker concrete grey "
            "side (ramp06). Top lit face (ramp12). Institutional-green end-cap "
            "flanges left and right (ramp07). Low clearance, player slides "
            "behind for partial cover. Soviet brutalist style, flat value "
            "blocks."
        ),
        "negative_prompt": _NEG_GENERIC,
        "seed": 7221003,
        "width": 48,
        "height": 12,
        "gen_width": 768,
        "gen_height": 192,
    },
    {
        "name": "locker_v1",
        "prop_class": "hide",
        "prompt": (
            "flat side-on standing locker sprite, hiding-spot prop (all-sensor "
            "block, single-occupant), Signal Tower interior. 14x42 game px RGBA "
            "cutout. Tall narrow form. Near-black metal outer shell "
            "(ramp00-ramp01) covering nearly the entire visible surface area. "
            "Thin dark seam line only (ramp02), no light-value panels or "
            "highlights. Tiny door-handle accent, small and mid-dark (ramp06) "
            "at most, under 5 percent of surface area. Interior of entry gap "
            "near-black (ramp00). Single-occupant, fully seals all sensors "
            "once player enters. Soviet brutalist style, hard value "
            "separation, overall silhouette reads as a dark solid block, "
            "low-key lighting."
        ),
        "negative_prompt": (
            "perspective, vanishing point, isometric, background, scene, depth "
            "of field, ambient occlusion, photorealistic, 3d render, multiple "
            "props, composed illustration, text, watermark, bright, "
            "light-colored, pale, high-key lighting, large light panel, glossy "
            "highlight, chrome, reflective, silver, white"
        ),
        "seed": 7223002,
        "width": 14,
        "height": 42,
        "gen_width": 256,
        "gen_height": 768,
    },
    {
        "name": "server_rack_v1",
        "prop_class": "hide",
        "prompt": (
            "flat side-on server rack cabinet sprite, hiding-spot prop "
            "(all-sensor block, single-occupant), Signal Tower interior. 20x46 "
            "game px RGBA cutout. Tall enclosed cabinet form. Dark concrete "
            "outer shell (ramp04), heavier frame border (ramp08), near-black "
            "interior with 3 horizontal rack divider bars (ramp04 over "
            "ramp00). Single-occupant, fully seals all sensors. Soviet "
            "brutalist style, dark heavy form."
        ),
        "negative_prompt": _NEG_GENERIC,
        "seed": 7221005,
        "width": 20,
        "height": 46,
        "gen_width": 448,
        "gen_height": 1024,
    },
]


def _build_recipe(entry: dict):
    """Build a `comfy_client.recipe.Recipe` from a `PROP_RECIPES` entry.

    Imported lazily -- see module docstring.
    """
    from comfy_client.recipe import Recipe

    return Recipe(
        prompt=entry["prompt"],
        negative_prompt=entry["negative_prompt"],
        seed=entry["seed"],
        name=entry["name"],
        width=entry["width"],
        height=entry["height"],
        checkpoint=CHECKPOINT,
        model_hash=MODEL_HASH,
    )


def generate_all(out_dir: str = "assets/final/props/signal_tower") -> list:
    """Regenerate the full pack through the committed cutout path.

    Requires a reachable ComfyUI instance (`comfy_client.base_url`) and
    `tools/comfy-client` installed. Not called by any test -- this is the
    reproducible entrypoint P-3 requires, run by hand when the pack needs
    regenerating.
    """
    from comfy_client.cutout import generate_cutout

    results = []
    for entry in PROP_RECIPES:
        recipe = _build_recipe(entry)
        result = generate_cutout(
            recipe,
            lora_name=LORA_NAME,
            lora_weight=LORA_WEIGHT,
            lora_license=LORA_LICENSE,
            out_dir=out_dir,
            gen_width=entry["gen_width"],
            gen_height=entry["gen_height"],
            concept_hash=CONCEPT_HASH,
            concept_source=CONCEPT_SOURCE,
        )
        results.append(result)
    return results


if __name__ == "__main__":
    generate_all()
