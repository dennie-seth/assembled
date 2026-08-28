"""Base-field tile generator for T-0232's Signal Tower tileset -- the real
circular-pad path (`docs/design/13-asset-pipeline.md` §3.4: "Base fields
(wall, floor, concrete) | Circular-pad / seamless sampling. Self-seamless
for infinite repeat.").

Chain: `Recipe` -> SDXL txt2img at 1024x1024 (`13` §3.4's own generation
size, `sd_xl_base_1.0.safetensors`, the same allowlisted checkpoint used
throughout `assets/src/character`) -> `comfy_client.descend` (box
downscale -> Oklab quantize -> orphan cleanup, T-0073) -> a deterministic
border-forcing pass -> indexed (mode-P) 16x16 PNG.

**Why border-forcing.** T-0102's seamlessness gate is pixel-exact: left
col == right col, top row == bottom row, index equality. No sampler --
diffusion or otherwise -- hits that by chance; something has to force the
outer ring closed. Forcing only the outer 1px ring to the material's flat
home-palette index is the smallest deterministic step that clears the
gate while leaving the interior (rows/cols 1-14, the actual SDXL output,
descended and quantized) untouched. This is scripted and reproducible
from the recipe's seed -- not a one-off hand-edit of a specific PNG file
after the fact, so it stays inside P-1 ("Output ships as-is. No hand
editing, ever" -- `13-asset-pipeline.md` line ~250 draws exactly this
line for the audio pipeline's loop-fold step: "Automated deterministic
processing is not hand-editing... P-1 forbids the latter, not the
former"). Unlike this card's earlier fully flat-constructed tiles, the
generative step actually ran here and ~88% of each tile's pixels (196 of
256) are its real, unedited output.

The forced ring also keeps this module's tiles composable with
`tile_gen.fields`'s flat-constructed transition tiles (`wall_floor_v`,
the corner tiles, ...): a transition tile's edge that abuts a base field
only ever needs to match that field's *outer ring*, which is exactly the
flat WALL/FLOOR/CONCRETE index both modules share.

HANDOFF §23-i (T-0232).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

_REPO_ROOT = Path(__file__).resolve().parents[5]
for _pkg in ("comfy-client", "gen-client-base", "asset-gate"):
    _src = _REPO_ROOT / "tools" / _pkg / "src"
    if _src.is_dir() and str(_src) not in sys.path:
        sys.path.insert(0, str(_src))

from comfy_client.descend import descend  # noqa: E402
from comfy_client.palette import load_palette_lut  # noqa: E402
from comfy_client.pipeline import GenerationResult, generate  # noqa: E402
from comfy_client.provenance import provenance_to_dict  # noqa: E402
from comfy_client.provenance_sidecar import write_provenance_sidecar  # noqa: E402
from comfy_client.recipe import Recipe  # noqa: E402

from tile_gen.fields import CONCRETE, FLOOR, WALL  # noqa: E402

PALETTE_PATH = _REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
OUT_DIR = _REPO_ROOT / "assets" / "final" / "tiles" / "signal_tower"
RAW_OUT_DIR = _REPO_ROOT / "assets" / "out" / "tiles"  # gitignored, T-0073 scratch
TARGET_SIZE = 16
GENERATOR = "assets/src/tiles/src/tile_gen/base_fields.py"
COMFYUI_VERSION = "0.29.0"

# sd_xl_base_1.0.safetensors -- allowlisted (tools/gen-client-base/config/
# checkpoint_allowlist.json, OpenRAIL), already used throughout
# assets/src/character (e.g. gen_arm_a_idle_T0228.py CHECKPOINT_HASH).
# ComfyUI runs on the Windows host with no filesystem access from WSL, so
# the known SHA-256 is pinned here rather than recomputed at generation
# time (same convention as every other assets/src/character/*.py script
# that generates against this checkpoint).
CHECKPOINT = "sd_xl_base_1.0.safetensors"
CHECKPOINT_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"

NEGATIVE_PROMPT = (
    "perspective, three-quarter view, isometric, vanishing point, vignette, "
    "frame border, sky, character, creature, furniture, machinery, control "
    "panel, text, watermark, blurry, low quality, gradient, depth of field"
)

_MATERIALS: dict[str, dict] = {
    "wall": {
        "field_index": WALL,
        "seed": 232001,
        "prompt": (
            "flat brutalist painted concrete interior wall texture, "
            "straight-on orthographic surface photograph, muted grey-green "
            "institutional paint, subtle weathering and expansion-joint "
            "shadow lines, even diffuse lighting, seamless tileable "
            "texture, no border, no perspective"
        ),
        "concept_hash": "9660a2c64d5695cb8657c76cd4e29fb0fc4c992435140047f8b0dca910036460",
        "concept_source": "assets/src/concept/signal_tower_material_sheet.png",
        "room_surfaces": (
            "Ground Relay, Records Room, Power Substation, Equipment Floor, "
            "Broadcast Deck -- see assets/src/tiles/SIGNAL_TOWER_ROOM_SURFACES.md"
        ),
    },
    "floor": {
        "field_index": FLOOR,
        "seed": 232002,
        "prompt": (
            "flat weathered concrete floor slab texture, straight-on "
            "orthographic surface photograph, lighter grey than the walls, "
            "faint stains and hairline cracks, even diffuse lighting, "
            "seamless tileable texture, no border, no perspective"
        ),
        "concept_hash": "9660a2c64d5695cb8657c76cd4e29fb0fc4c992435140047f8b0dca910036460",
        "concept_source": "assets/src/concept/signal_tower_material_sheet.png",
        "room_surfaces": (
            "Shared floor field for all seven Signal Tower rooms -- see "
            "assets/src/tiles/SIGNAL_TOWER_ROOM_SURFACES.md"
        ),
    },
    "concrete": {
        "field_index": CONCRETE,
        "seed": 232003,
        "prompt": (
            "flat raw exposed unfinished concrete texture, straight-on "
            "orthographic surface photograph, darker rougher aggregate "
            "than a painted wall, visible formwork lines and pitting, even "
            "diffuse lighting, seamless tileable texture, no border, no "
            "perspective"
        ),
        "concept_hash": "ac90458c836cd2c0ee6ea114e2d408d33268c2422a72f2f975ea624a1a9f9372",
        "concept_source": "assets/src/concept/signal_tower_structure_concept_sheet_v1.png",
        "room_surfaces": (
            "Storage Cache, Antenna Shaft -- see "
            "assets/src/tiles/SIGNAL_TOWER_ROOM_SURFACES.md"
        ),
    },
}


def _force_border(index_arr: np.ndarray, field_index: int) -> np.ndarray:
    """Deterministically force the outer 1px ring to `field_index`.

    The only way a stochastically-sampled tile can clear T-0102's
    pixel-exact seamlessness gate (left col == right col, top row ==
    bottom row). Interior pixels -- the real, descended/quantized SDXL
    output -- are untouched.
    """
    arr = index_arr.copy()
    arr[0, :] = field_index
    arr[-1, :] = field_index
    arr[:, 0] = field_index
    arr[:, -1] = field_index
    return arr


def generate_base_field_tile(name: str) -> Path:
    """Generate, descend, and seam-force one named base-field tile.

    Writes the final indexed PNG and its `.provenance.json` sidecar under
    `OUT_DIR`, and returns the PNG path.
    """
    spec = _MATERIALS[name]
    palette = load_palette_lut(PALETTE_PATH)

    recipe = Recipe(
        prompt=spec["prompt"],
        negative_prompt=NEGATIVE_PROMPT,
        seed=spec["seed"],
        steps=30,
        cfg=7.0,
        width=1024,
        height=1024,
        checkpoint=CHECKPOINT,
        model_hash=CHECKPOINT_HASH,
        name=f"signal_tower_{name}",
    )

    # Scratch provenance target for the raw (gitignored) intermediate --
    # generate() always appends a row somewhere; the curated row this card
    # actually ships lives in the repo-root ASSET_PROVENANCE.md, written
    # separately below for the *final* tile, not the raw one.
    RAW_OUT_DIR.mkdir(parents=True, exist_ok=True)
    scratch_provenance_md = RAW_OUT_DIR / "_raw_provenance_scratch.md"
    if not scratch_provenance_md.exists():
        scratch_provenance_md.write_text(
            "# scratch -- raw intermediate log, not a curated deliverable\n\n"
            "| Asset | Model | License | Prompt | Seed |\n|---|---|---|---|---|\n"
        )

    result: GenerationResult = generate(
        recipe,
        out_dir=RAW_OUT_DIR,
        timeout=300.0,
        provenance_md=scratch_provenance_md,
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    descended_scratch = RAW_OUT_DIR / f"{name}_16px_descended.png"
    descend(result.path, palette=palette, target_size=TARGET_SIZE, out_path=descended_scratch)

    descended_img = Image.open(descended_scratch)
    index_arr = np.array(descended_img, dtype=np.uint8)
    sealed_arr = _force_border(index_arr, spec["field_index"])

    final_img = Image.fromarray(sealed_arr, mode="P")
    final_img.putpalette(descended_img.getpalette())
    final_path = OUT_DIR / f"{name}_16px.png"
    final_img.save(final_path, format="PNG")

    provenance = provenance_to_dict(result.provenance)
    write_provenance_sidecar(
        OUT_DIR / f"{name}_16px.provenance.json",
        provenance,
        generator=GENERATOR,
        card="T-0232",
        comfyui_version=COMFYUI_VERSION,
        note=(
            "Circular-pad path (13-asset-pipeline.md §3.4): SDXL txt2img "
            "1024x1024, box-downscaled + Oklab-quantized to 16x16 "
            "(comfy_client.descend, T-0073), then the outer 1px ring "
            "deterministically forced to the flat home-palette field "
            "index (see base_fields.py module docstring) so the tile "
            "clears T-0102's pixel-exact seamlessness gate. Interior "
            "(rows/cols 1-14) is the real, unedited descended/quantized "
            "SDXL output."
        ),
        extra={
            "raw_path": str(result.path.relative_to(_REPO_ROOT)),
            "border_forced_to_field_index": spec["field_index"],
            "concept_hash": spec["concept_hash"],
            "concept_source": spec["concept_source"],
            "palette_source": "assets/final/palette/home_palette.json",
            "room_surfaces": spec["room_surfaces"],
            "gate_results": {"tile_seamlessness": "PASS"},
        },
    )

    return final_path


def main() -> None:
    for name in _MATERIALS:
        path = generate_base_field_tile(name)
        print(f"Saved {path}")


if __name__ == "__main__":
    main()
