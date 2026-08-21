#!/usr/bin/env python3
"""T-0212 (re-run): Generate player idle sheet — concept-conditioned via tiled figure template.

Fix for v2 mistake: using the full concept sheet as img2img input at denoise=0.7 preserved
the multi-variant composition of the concept art (jacket close-ups + costume turnaround rows).
The output became a re-painted concept turnaround sheet, not an idle animation.

Correct approach:
  1. Crop a single full-body standing figure from the T-0209 concept sheet (bottom-left panel).
  2. Tile it 3x3 at 1152x1152 (nine identical starting frames).
  3. Submit to ComfyUI as img2img (denoise=0.7) — diffusion introduces subtle idle-pose
     variation per cell (breathing, weight shift) while character identity stays constant.
  4. Descent: BOX-resize → 144x144, Oklab palette quantize, orphan cleanup,
     internal cell-border clear, indexed mode-P save.
  5. Write provenance JSON with concept_hash.

This is still concept-conditioned (img2img input derives pixel data directly from T-0209
concept sheet pixels) and satisfies T-0106 archetype-first coherence guard.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image
from PIL.Image import Resampling

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[3]
CONCEPT_SHEET = REPO_ROOT / "assets/src/concept/player_character_concept_sheet_v1.png"
PALETTE_PATH = REPO_ROOT / "assets/final/palette/home_palette.json"
FINAL_OUT = REPO_ROOT / "assets/final/character/player_idle_sheet_v2.png"
PROVENANCE_OUT = REPO_ROOT / "assets/final/character/player_idle_sheet_v2.provenance.json"

COMFYUI_HOST = "http://172.18.192.1:8188"
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

# ---------------------------------------------------------------------------
# Generation parameters
# ---------------------------------------------------------------------------
# Concept sheet is 1024x1024. Bottom-left panel (~row 5): a single standing
# front-facing figure. Approximate crop (x0, y0, x1, y1) in pixels.
# Row 5 starts around y=740; left column ends around x=200.
FIGURE_CROP = (5, 740, 205, 1020)   # single front-facing standing figure

GEN_SIZE = 1152          # ComfyUI generation size (x8 from 144 native)
CELL_PX = 384            # each tiled cell = GEN_SIZE // 3
NATIVE_SIZE = 144        # sprite sheet native size
CELL_NATIVE = 48         # native cell size

SEED = 31416
STEPS = 30
CFG = 7.0
DENOISE = 0.70
LORA_WEIGHT = 0.70

PROMPT = (
    "pixel art idle animation sprite sheet, Soviet brutalist soldier in standard military uniform, "
    "flat side-on orthographic side view, nine frame cells arranged in a 3x3 grid, "
    "same single character in every cell, subtle idle motion between frames, "
    "slight weight shift and natural breathing pose variation, "
    "both feet on ground, arms relaxed at sides, upright standing posture, "
    "consistent character identity across all cells, institutional grey concrete background, "
    "muted olive-green and grey military palette, value-separated pixel art silhouette, "
    "clean readable pixel outline, no perspective, no vanishing point, "
    "no different costumes per panel, no multiple characters, no action poses, no UI, no text"
)
NEGATIVE_PROMPT = (
    "costume turnaround sheet, character design sheet, different outfits per cell, "
    "multiple costume variants, jacket closeup, clothing detail sheet, "
    "perspective, three-quarter view, vanishing point, diagonal composition, "
    "depth of field, atmospheric haze, blurry, low quality, photorealistic, "
    "watermark, text, UI, running, jumping, action pose, background clutter, "
    "bright colours, neon, multiple different characters"
)

UPLOAD_FILENAME = "player_idle_v3_template.png"
OUTPUT_PREFIX = "player_idle_v3"


# ---------------------------------------------------------------------------
# Step 1: Prepare the tiled template from the concept sheet figure
# ---------------------------------------------------------------------------

def build_template() -> bytes:
    """Crop one standing figure from the concept sheet, tile 3x3, return PNG bytes."""
    print(f"Loading concept sheet: {CONCEPT_SHEET}")
    concept = Image.open(CONCEPT_SHEET).convert("RGB")
    print(f"  Concept sheet size: {concept.size}")

    x0, y0, x1, y1 = FIGURE_CROP
    figure = concept.crop((x0, y0, x1, y1))
    print(f"  Cropped figure: {figure.size} from ({x0},{y0})-({x1},{y1})")

    # Scale the single figure up to fill each cell of the gen-size grid
    figure_cell = figure.resize((CELL_PX, CELL_PX), Resampling.LANCZOS)

    # Tile 3x3
    template = Image.new("RGB", (GEN_SIZE, GEN_SIZE))
    for row in range(3):
        for col in range(3):
            template.paste(figure_cell, (col * CELL_PX, row * CELL_PX))

    buf = BytesIO()
    template.save(buf, format="PNG")
    buf.seek(0)
    print(f"  Template built: {template.size}")
    return buf.read()


# ---------------------------------------------------------------------------
# Step 2: Upload template to ComfyUI input folder
# ---------------------------------------------------------------------------

def upload_template(png_bytes: bytes) -> str:
    """Upload PNG bytes to ComfyUI /upload/image, return filename."""
    boundary = "----ComfyBoundary1234"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{UPLOAD_FILENAME}"\r\n'
        f"Content-Type: image/png\r\n"
        f"\r\n"
    ).encode() + png_bytes + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{COMFYUI_HOST}/upload/image",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    print(f"  Uploaded template: {result}")
    return result["name"]


# ---------------------------------------------------------------------------
# Step 3: Submit img2img workflow
# ---------------------------------------------------------------------------

def build_workflow(uploaded_filename: str) -> dict:
    """Build a ComfyUI workflow dict for img2img on the tiled template."""
    return {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"},
        },
        "12": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["4", 0],
                "clip": ["4", 1],
                "lora_name": "soviet_brutalism_style_v1.safetensors",
                "strength_model": LORA_WEIGHT,
                "strength_clip": LORA_WEIGHT,
            },
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": PROMPT, "clip": ["12", 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": NEGATIVE_PROMPT, "clip": ["12", 1]},
        },
        "10": {
            "class_type": "LoadImage",
            "inputs": {"image": uploaded_filename},
        },
        "14": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["10", 0],
                "upscale_method": "lanczos",
                "width": GEN_SIZE,
                "height": GEN_SIZE,
                "crop": "disabled",
            },
        },
        "11": {
            "class_type": "VAEEncode",
            "inputs": {"pixels": ["14", 0], "vae": ["4", 2]},
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["12", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["11", 0],
                "seed": SEED,
                "steps": STEPS,
                "cfg": CFG,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": DENOISE,
            },
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
        },
        "13": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["8", 0],
                "upscale_method": "area",
                "width": NATIVE_SIZE,
                "height": NATIVE_SIZE,
                "crop": "disabled",
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": OUTPUT_PREFIX,
                "images": ["13", 0],
            },
        },
    }


def submit_workflow(workflow: dict) -> str:
    """Submit workflow to ComfyUI and return prompt_id."""
    payload = json.dumps({"prompt": workflow}).encode()
    req = urllib.request.Request(
        f"{COMFYUI_HOST}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    prompt_id = result["prompt_id"]
    print(f"  Submitted workflow, prompt_id: {prompt_id}")
    return prompt_id


# ---------------------------------------------------------------------------
# Step 4: Poll for completion
# ---------------------------------------------------------------------------

def poll_until_done(prompt_id: str, timeout_s: int = 600, interval_s: int = 10) -> dict:
    """Poll /history until the prompt completes or timeout. Returns history entry."""
    deadline = time.monotonic() + timeout_s
    print(f"  Polling for completion (timeout {timeout_s}s)...")
    while time.monotonic() < deadline:
        url = f"{COMFYUI_HOST}/history/{prompt_id}"
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                history = json.loads(resp.read())
        except urllib.error.URLError as exc:
            print(f"  Poll error (will retry): {exc}")
            time.sleep(interval_s)
            continue

        if prompt_id in history:
            entry = history[prompt_id]
            status = entry.get("status", {})
            completed = status.get("completed", False)
            messages = status.get("messages", [])
            last_msg = messages[-1] if messages else None
            print(f"  Status: completed={completed}, last_msg={last_msg}")
            if completed:
                return entry
            # Check for error
            has_error = any(
                m[0] == "execution_error" for m in messages if isinstance(m, (list, tuple))
            )
            if has_error:
                raise RuntimeError(f"ComfyUI execution error for prompt_id={prompt_id}")
        else:
            print("  Waiting... (not in history yet)")

        time.sleep(interval_s)

    raise TimeoutError(f"ComfyUI job {prompt_id} did not complete within {timeout_s}s")


def get_output_filename(history_entry: dict) -> str:
    """Extract the output PNG filename from a history entry."""
    outputs = history_entry.get("outputs", {})
    for node_output in outputs.values():
        for img in node_output.get("images", []):
            if img.get("type") == "output":
                return img["filename"]
    raise RuntimeError(f"No output image found in history entry: {list(outputs.keys())}")


# ---------------------------------------------------------------------------
# Step 5: Download output PNG
# ---------------------------------------------------------------------------

def download_output(filename: str) -> Image.Image:
    """Download the generated PNG from ComfyUI /view endpoint."""
    url = f"{COMFYUI_HOST}/view?filename={urllib.parse.quote(filename)}&type=output"
    print(f"  Fetching output: {url}")
    with urllib.request.urlopen(url, timeout=30) as resp:
        raw_bytes = resp.read()
    img = Image.open(BytesIO(raw_bytes)).convert("RGB")
    print(f"  Downloaded: size={img.size} mode={img.mode}")
    return img


# ---------------------------------------------------------------------------
# Step 6: Descent pipeline (palette quantize → orphan cleanup → cell-border → save)
# ---------------------------------------------------------------------------

def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """Convert sRGB uint8 or [0,1] float to Oklab."""
    if rgb.dtype == np.uint8:
        lin = (rgb / 255.0).astype(np.float32)
    else:
        lin = rgb.astype(np.float32)
    mask = lin > 0.04045
    lin[mask] = ((lin[mask] + 0.055) / 1.055) ** 2.4
    lin[~mask] = lin[~mask] / 12.92
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m_ = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s_ = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b_ok = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([L, a, b_ok], axis=-1)


def descent_pipeline(raw_img: Image.Image) -> np.ndarray:
    """
    Palette quantize → orphan cleanup → cell-border clear → return index_arr.
    """
    # Load home palette
    palette_data = json.loads(PALETTE_PATH.read_text())
    slots = sorted(palette_data["slots"], key=lambda s: s["index"])
    palette: list[tuple[int, int, int]] = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        palette.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    print(f"  Palette: {len(palette)} colours")

    # BOX-resize to native
    descaled = raw_img.resize((NATIVE_SIZE, NATIVE_SIZE), Resampling.BOX)

    # Oklab nearest-colour quantize
    arr = np.array(descaled, dtype=np.uint8)
    h_px, w_px, _ = arr.shape
    pixel_oklab = srgb_to_oklab(arr.reshape(-1, 3))
    palette_rgb = np.array(palette, dtype=np.uint8)
    palette_oklab = srgb_to_oklab(palette_rgb)
    dists = ((pixel_oklab[:, None, :] - palette_oklab[None, :, :]) ** 2).sum(axis=-1)
    index_arr = dists.argmin(axis=1).astype(np.uint8).reshape(h_px, w_px)
    print(f"  Unique palette indices used: {sorted(set(index_arr.flatten().tolist()))}")

    # Orphan cleanup
    out = index_arr.copy()
    for y in range(h_px):
        for x in range(w_px):
            idx = index_arr[y, x]
            neighbours = []
            if y > 0:
                neighbours.append(index_arr[y - 1, x])
            if y < h_px - 1:
                neighbours.append(index_arr[y + 1, x])
            if x > 0:
                neighbours.append(index_arr[y, x - 1])
            if x < w_px - 1:
                neighbours.append(index_arr[y, x + 1])
            if neighbours and idx not in neighbours:
                values, counts = np.unique(neighbours, return_counts=True)
                out[y, x] = values[np.argmax(counts)]
    index_arr = out
    print("  Orphan cleanup done.")

    # Cell-border clear: set 1px internal border strips to index 0
    # Internal verticals: x=47,48,95,96; horizontals: y=47,48,95,96
    for c in range(1, 3):
        index_arr[:, c * CELL_NATIVE - 1] = 0
        index_arr[:, c * CELL_NATIVE] = 0
    for r in range(1, 3):
        index_arr[r * CELL_NATIVE - 1, :] = 0
        index_arr[r * CELL_NATIVE, :] = 0
    print("  Cell-border strips cleared.")

    return index_arr, palette


def save_indexed_png(index_arr: np.ndarray, palette: list[tuple[int, int, int]]) -> None:
    """Save as indexed mode-P PNG."""
    out_img = Image.fromarray(index_arr, mode="P")
    flat_palette = [0] * (256 * 3)
    for i, rgb in enumerate(palette):
        flat_palette[3 * i : 3 * i + 3] = list(rgb)
    out_img.putpalette(flat_palette)
    out_img.save(FINAL_OUT)
    print(f"  Saved: {FINAL_OUT}")


# ---------------------------------------------------------------------------
# Step 7: Write provenance JSON
# ---------------------------------------------------------------------------

def write_provenance(concept_hash: str, prompt_id: str) -> None:
    prov = {
        "model": (
            f"sd_xl_base_1.0.safetensors + LoRA soviet_brutalism_style_v1.safetensors "
            f"(weight {LORA_WEIGHT})"
        ),
        "model_license": "CreativeML Open RAIL++-M (base) / CreativeML OpenRAIL++-M (LoRA)",
        "model_hash": None,
        "prompt": PROMPT,
        "negative_prompt": NEGATIVE_PROMPT,
        "seed": SEED,
        "steps": STEPS,
        "cfg": CFG,
        "width": GEN_SIZE,
        "height": GEN_SIZE,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "method": (
            "img2img concept-conditioned via ComfyUI HTTP API (SDXL KSampler, euler/normal, "
            f"denoise={DENOISE}); single figure cropped from T-0209 concept sheet "
            f"(crop {FIGURE_CROP}), tiled 3x3 to 1152x1152 as img2img template so "
            "character identity is preserved across all 9 cells while diffusion "
            "introduces subtle idle-pose variation (breathing, weight shift) per frame. "
            f"ComfyUI workflow: assets/src/character/gen_idle_v3_tiled.py"
        ),
        "img2img_denoise": DENOISE,
        "figure_crop": list(FIGURE_CROP),
        "tile_grid": "3x3 (9 copies of cropped figure at 384x384 each)",
        "lora_name": "soviet_brutalism_style_v1.safetensors",
        "lora_weight": LORA_WEIGHT,
        "lora_license": "CreativeML OpenRAIL++-M",
        "comfyui_prompt_id": prompt_id,
        "generator": "assets/src/character/gen_idle_v3_tiled.py",
        "card": "T-0212",
        "spec": (
            "docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) + "
            "§6 (archetype-first coherence guard)"
        ),
        "layout": {
            "sheet_px": [NATIVE_SIZE, NATIVE_SIZE],
            "cell_px": CELL_NATIVE,
            "cols": 3,
            "rows": 3,
            "figure_height_px": 40,
            "frame_cells": [
                {"cell": "(0,0)"},
                {"cell": "(0,1)"},
                {"cell": "(0,2)"},
                {"cell": "(1,0)"},
            ],
            "spare_cells": ["(1,1)", "(1,2)", "(2,0)", "(2,1)", "(2,2)"],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    PROVENANCE_OUT.write_text(json.dumps(prov, indent=2))
    print(f"  Provenance written: {PROVENANCE_OUT}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=== T-0212: Player idle sheet v3 — concept-conditioned (tiled figure template) ===\n")

    # Verify concept hash
    print("Step 0: Verify concept sheet hash...")
    concept_hash = hashlib.sha256(CONCEPT_SHEET.read_bytes()).hexdigest()
    assert concept_hash == EXPECTED_CONCEPT_HASH, (
        f"concept hash mismatch: {concept_hash} != {EXPECTED_CONCEPT_HASH}"
    )
    print(f"  concept_hash: {concept_hash}\n")

    # Step 1: Build template
    print("Step 1: Build tiled template from concept sheet figure...")
    template_png = build_template()
    print()

    # Step 2: Upload template
    print("Step 2: Upload template to ComfyUI...")
    uploaded_name = upload_template(template_png)
    print()

    # Step 3: Submit workflow
    print("Step 3: Submit img2img workflow...")
    workflow = build_workflow(uploaded_name)
    prompt_id = submit_workflow(workflow)
    print()

    # Step 4: Poll until done
    print("Step 4: Poll for completion...")
    history_entry = poll_until_done(prompt_id)
    print()

    # Step 5: Download output
    print("Step 5: Download output...")
    output_filename = get_output_filename(history_entry)
    print(f"  Output filename: {output_filename}")
    raw_img = download_output(output_filename)
    print()

    # Step 6: Descent
    print("Step 6: Descent pipeline (palette quantize + orphan cleanup + border clear)...")
    index_arr, palette = descent_pipeline(raw_img)
    save_indexed_png(index_arr, palette)
    print()

    # Step 7: Provenance
    print("Step 7: Write provenance...")
    write_provenance(concept_hash, prompt_id)
    print()

    print("=== DONE ===")
    print(f"Output: {FINAL_OUT}")
    print(f"Provenance: {PROVENANCE_OUT}")
    print("\nRun gate tests:")
    print("  cd assets/src/character && .venv/bin/pytest tests/test_player_idle_v2_gate.py -v")


if __name__ == "__main__":
    main()
