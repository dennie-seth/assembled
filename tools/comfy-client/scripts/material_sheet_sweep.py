#!/usr/bin/env python3
"""Manual, NOT-CI denoise/seed sweep for the T-0106 material concept sheet.

Like `live_smoke.py`, never invoked by pytest or CI. Runs
`generate_concept_conditioned` against the hand-blocked layout template
(`assets/src/concept/signal_tower_material_template.png`) at a few denoise
strengths and seeds, writing candidates to `assets/out/material_sweep/`
(gitignored scratch, not `assets/src/concept/`) for a human/agent to curate
before promoting one to the committed concept sheet.

Usage (from tools/comfy-client, with the venv set up):

    .venv/bin/python scripts/material_sheet_sweep.py
"""

from __future__ import annotations

from comfy_client.base_url import resolve_base_url
from comfy_client.concept import generate_concept_conditioned
from comfy_client.recipe import Recipe

TEMPLATE_PATH = "assets/src/concept/signal_tower_material_template.png"
OUT_DIR = "assets/out/material_sweep"

PROMPT = (
    "brutalist concrete wall texture, worn concrete floor surface, "
    "wall-to-floor trim, muted concrete grey and oxide and institutional "
    "green, flat side-on reference sheet, no perspective, value-separated "
    "material panels, interior, weathered surface detail, rough stained concrete"
)
NEGATIVE_PROMPT = (
    "equipment, control panel, machinery, switches, buttons, sky, "
    "perspective, three-quarter view, isometric, vanishing point, "
    "text, watermark, glow, blurry, low quality, character, creature, "
    "smooth, flat colour, solid colour"
)

# Empirically (2026-08-03, seed 3101): 0.55/0.65/0.75 all reproduced the
# template almost pixel-for-pixel -- SDXL barely painted texture over the
# init latent below ~0.85. 0.90 was the first value that actually rendered
# concrete/oxide/institutional-green material into the panels while the
# wall/floor/transition arrangement stayed legible. But 0.90 is also seed-
# sensitive: a second seed at 0.90 collapsed into an incoherent patchwork
# instead of material. Treat this range, not 0.55-0.75, as the starting
# point for future sweeps, and expect to need multiple seeds per denoise
# to find one that renders cleanly rather than assuming the first works.
DENOISE_SWEEP = [0.80, 0.85, 0.90]
SEEDS = [3101, 3102]


def main() -> int:
    base_url = resolve_base_url()
    print(f"resolved ComfyUI base URL: {base_url}")

    # Primary pass: one seed across the denoise sweep.
    combos = [(d, SEEDS[0]) for d in DENOISE_SWEEP]
    # Second pass: a second seed at the highest denoise, where texture
    # actually renders -- this is also where seed variance is riskiest.
    combos.append((0.90, SEEDS[1]))

    for denoise, seed in combos:
        name = f"material_sheet_d{int(denoise * 100)}_s{seed}"
        recipe = Recipe(
            prompt=PROMPT,
            negative_prompt=NEGATIVE_PROMPT,
            seed=seed,
            steps=30,
            cfg=7.0,
            denoise=denoise,
            name=name,
        )
        print(f"generating {name} (denoise={denoise}, seed={seed}) ...")
        result = generate_concept_conditioned(
            recipe, init_image_path=TEMPLATE_PATH, out_dir=OUT_DIR, timeout=300.0
        )
        print(f"  -> {result.path}")

    print("done. candidates in", OUT_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
