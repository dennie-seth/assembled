#!/usr/bin/env python3
"""T-0213: Generate concept-conditioned player state sheets (move, crouch-hide, die).

Each sheet is img2img-seeded from T-0212's player_idle_sheet_v2.png.
This is iter-2 of T-0199 — same approach, seeded from the concept-conditioned
idle sheet instead of the original synthetic T-0198 idle.

Pipeline per sheet:
  1. Load player_idle_sheet_v2.png (the T-0212 output, 144×144).
  2. Scale it up to gen resolution and tile to the target grid.
  3. Submit to ComfyUI as img2img (denoise varies by state).
  4. Descent: BOX-resize → native, Oklab palette quantize, orphan cleanup,
     internal cell-border clear, indexed mode-P save.
  5. Write provenance JSON with concept_hash = SHA-256(player_idle_sheet_v2.png).

concept_hash recorded here is the hash of player_idle_sheet_v2.png (T-0212),
satisfying the T-0106 conditioning-chain provenance requirement.
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
IDLE_V2_PATH = REPO_ROOT / "assets/final/character/player_idle_sheet_v2.png"
PALETTE_PATH = REPO_ROOT / "assets/final/palette/home_palette.json"

COMFYUI_HOST = "http://172.18.192.1:8188"

# ComfyUI model paths (Windows-side via /mnt/f)
COMFYUI_CHECKPOINTS = Path("/mnt/f/ComfyUI/models/checkpoints")
COMFYUI_LORAS = Path("/mnt/f/ComfyUI/models/loras")

CELL_NATIVE = 48

# ---------------------------------------------------------------------------
# Shared generation parameters
# ---------------------------------------------------------------------------
STEPS = 30
CFG = 7.0
LORA_WEIGHT = 0.70

NEGATIVE_PROMPT = (
    "multiple characters, different costumes, costume sheet, turnaround, "
    "perspective, three-quarter view, vanishing point, diagonal composition, "
    "depth of field, atmospheric haze, blurry, low quality, photorealistic, "
    "watermark, text, UI, background clutter, bright colours, neon"
)

# State-specific generation configs
STATES = {
    "move": {
        "output_path": REPO_ROOT / "assets/final/character/player_move_sheet_v2.png",
        "provenance_path": (
            REPO_ROOT / "assets/final/character/player_move_sheet_v2.provenance.json"
        ),
        "cols": 3,
        "rows": 4,
        "native_w": 144,
        "native_h": 192,
        "gen_w": 1152,
        "gen_h": 1536,
        "seed": 31417,
        "denoise": 0.85,
        "upload_filename": "player_move_v2_template.png",
        "output_prefix": "player_move_v2",
        "prompt": (
            "pixel art walk cycle animation sprite sheet, Soviet brutalist soldier "
            "in standard military uniform, flat side-on orthographic side view, "
            "twelve frame cells arranged in a 3x4 grid, same single character in every cell, "
            "walk cycle animation with leg stride variation between frames, "
            "left and right leg alternating forward and back across adjacent frames, "
            "body upright and stable, arms swinging slightly, "
            "institutional grey concrete background, muted olive-green and grey military palette, "
            "value-separated pixel art silhouette, clean readable pixel outline, "
            "no perspective, no vanishing point, no action poses other than walking, "
            "no multiple characters, no UI, no text"
        ),
        "frame_cells": [
            "(0,0)", "(0,1)", "(0,2)",
            "(1,0)", "(1,1)", "(1,2)",
            "(2,0)", "(2,1)", "(2,2)",
            "(3,0)",
        ],
        "spare_cells": ["(3,1)", "(3,2)"],
        "description": "10 walk-cycle frames + 2 spare cells",
    },
    "crouch_hide": {
        "output_path": (
            REPO_ROOT / "assets/final/character/player_crouch_hide_sheet_v2.png"
        ),
        "provenance_path": (
            REPO_ROOT
            / "assets/final/character/player_crouch_hide_sheet_v2.provenance.json"
        ),
        "cols": 3,
        "rows": 3,
        "native_w": 144,
        "native_h": 144,
        "gen_w": 1152,
        "gen_h": 1152,
        "seed": 31418,
        "denoise": 0.80,
        "upload_filename": "player_crouch_hide_v2_template.png",
        "output_prefix": "player_crouch_hide_v2",
        "prompt": (
            "pixel art crouch and hide animation sprite sheet, Soviet brutalist soldier "
            "in standard military uniform, flat side-on orthographic side view, "
            "nine frame cells arranged in a 3x3 grid, same single character in every cell, "
            "progressive crouching sequence across frames from standing to fully crouched, "
            "figure compresses vertically as character descends into hiding position, "
            "character partially hidden behind imagined cover by final frames, "
            "institutional grey concrete background, muted olive-green and grey military palette, "
            "value-separated pixel art silhouette, clean readable pixel outline, "
            "no perspective, no vanishing point, no action poses other than crouching, "
            "no multiple characters, no UI, no text"
        ),
        "frame_cells": [
            "(0,0)", "(0,1)", "(0,2)",
            "(1,0)", "(1,1)", "(1,2)",
            "(2,0)", "(2,1)", "(2,2)",
        ],
        "spare_cells": [],
        "description": "9 crouch-hide frames",
    },
    "die": {
        "output_path": REPO_ROOT / "assets/final/character/player_die_sheet_v2.png",
        "provenance_path": (
            REPO_ROOT / "assets/final/character/player_die_sheet_v2.provenance.json"
        ),
        "cols": 3,
        "rows": 3,
        "native_w": 144,
        "native_h": 144,
        "gen_w": 1152,
        "gen_h": 1152,
        "seed": 31419,
        "denoise": 0.85,
        "upload_filename": "player_die_v2_template.png",
        "output_prefix": "player_die_v2",
        "prompt": (
            "pixel art death animation sprite sheet, Soviet brutalist soldier "
            "in standard military uniform, flat side-on orthographic side view, "
            "nine frame cells arranged in a 3x3 grid, same single character in every cell, "
            "progressive death fall sequence across frames from standing to collapsed, "
            "figure gradually falls sideways and collapses to ground across frames, "
            "figure becomes horizontal by final frames, dramatic fall animation, "
            "institutional grey concrete background, muted olive-green and grey military palette, "
            "value-separated pixel art silhouette, clean readable pixel outline, "
            "no perspective, no vanishing point, no action poses other than falling, "
            "no multiple characters, no UI, no text"
        ),
        "frame_cells": [
            "(0,0)", "(0,1)", "(0,2)",
            "(1,0)", "(1,1)", "(1,2)",
            "(2,0)", "(2,1)", "(2,2)",
        ],
        "spare_cells": [],
        "description": "9 death-sequence frames",
    },
}


# ---------------------------------------------------------------------------
# Model hashing (T-0151)
# ---------------------------------------------------------------------------

def hash_file(path: Path) -> str:
    """Return SHA-256 hex digest of *path*, reading in 8 MiB chunks."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(8 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Step 1: Build img2img template from the v2 idle sheet
# ---------------------------------------------------------------------------

def build_template(cfg: dict) -> bytes:
    """Scale idle v2 sheet up and tile to the target grid, return PNG bytes."""
    print(f"  Loading idle v2 sheet: {IDLE_V2_PATH}")
    idle = Image.open(IDLE_V2_PATH).convert("RGB")
    print(f"  Idle v2 size: {idle.size}")

    gen_w, gen_h = cfg["gen_w"], cfg["gen_h"]
    cols, rows = cfg["cols"], cfg["rows"]
    cell_gen_w = gen_w // cols
    cell_gen_h = gen_h // rows

    # Scale idle sheet to gen size (full sheet → upscaled, then tile per cell)
    idle_cell_size = CELL_NATIVE  # 48px native
    # Take one cell from the idle sheet (top-left idle frame cell 0,0)
    idle_cell = idle.crop((0, 0, idle_cell_size, idle_cell_size))
    idle_cell_scaled = idle_cell.resize(
        (cell_gen_w, cell_gen_h), Resampling.LANCZOS
    )

    template = Image.new("RGB", (gen_w, gen_h))
    for row in range(rows):
        for col in range(cols):
            template.paste(idle_cell_scaled, (col * cell_gen_w, row * cell_gen_h))

    buf = BytesIO()
    template.save(buf, format="PNG")
    buf.seek(0)
    print(f"  Template built: {template.size} ({cols}×{rows} grid)")
    return buf.read()


# ---------------------------------------------------------------------------
# Step 2: Upload template to ComfyUI
# ---------------------------------------------------------------------------

def upload_template(png_bytes: bytes, upload_filename: str) -> str:
    """Upload PNG bytes to ComfyUI /upload/image, return filename."""
    boundary = "----ComfyBoundary1234"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{upload_filename}"\r\n'
        f"Content-Type: image/png\r\n"
        f"\r\n"
    ).encode() + png_bytes + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{COMFYUI_HOST}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    print(f"  Uploaded template: {result}")
    return result["name"]


# ---------------------------------------------------------------------------
# Step 3: Build and submit img2img workflow
# ---------------------------------------------------------------------------

def build_workflow(uploaded_filename: str, cfg: dict) -> dict:
    """Build a ComfyUI workflow dict for img2img on the tiled template."""
    gen_w, gen_h = cfg["gen_w"], cfg["gen_h"]
    native_w, native_h = cfg["native_w"], cfg["native_h"]
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
            "inputs": {"text": cfg["prompt"], "clip": ["12", 1]},
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
                "width": gen_w,
                "height": gen_h,
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
                "seed": cfg["seed"],
                "steps": STEPS,
                "cfg": CFG,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": cfg["denoise"],
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
                "width": native_w,
                "height": native_h,
                "crop": "disabled",
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": cfg["output_prefix"],
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
    """Poll /history until the prompt completes or timeout."""
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
# Step 6: Descent pipeline
# ---------------------------------------------------------------------------

def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """Convert sRGB uint8 to Oklab float."""
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


def descent_pipeline(
    raw_img: Image.Image, cfg: dict
) -> tuple[np.ndarray, list[tuple[int, int, int]]]:
    """BOX-resize → Oklab palette quantize → orphan cleanup → cell-border clear."""
    palette_data = json.loads(PALETTE_PATH.read_text())
    slots = sorted(palette_data["slots"], key=lambda s: s["index"])
    palette: list[tuple[int, int, int]] = []
    for slot in slots:
        h = slot["hex"].lstrip("#")
        palette.append((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    print(f"  Palette: {len(palette)} colours")

    native_w, native_h = cfg["native_w"], cfg["native_h"]
    cols, rows = cfg["cols"], cfg["rows"]

    descaled = raw_img.resize((native_w, native_h), Resampling.BOX)

    arr = np.array(descaled, dtype=np.uint8)
    h_px, w_px, _ = arr.shape
    pixel_oklab = srgb_to_oklab(arr.reshape(-1, 3))
    palette_rgb = np.array(palette, dtype=np.uint8)
    palette_oklab = srgb_to_oklab(palette_rgb)
    dists = ((pixel_oklab[:, None, :] - palette_oklab[None, :, :]) ** 2).sum(axis=-1)
    index_arr = dists.argmin(axis=1).astype(np.uint8).reshape(h_px, w_px)
    print(f"  Unique palette indices used: {sorted(set(index_arr.flatten().tolist()))}")

    # Orphan cleanup (single-pixel noise removal)
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

    # Cell-border clear: set 1px internal border strips to index 0 (BG)
    for c in range(1, cols):
        index_arr[:, c * CELL_NATIVE - 1] = 0
        index_arr[:, c * CELL_NATIVE] = 0
    for r in range(1, rows):
        index_arr[r * CELL_NATIVE - 1, :] = 0
        index_arr[r * CELL_NATIVE, :] = 0
    print("  Cell-border strips cleared.")

    return index_arr, palette


def save_indexed_png(
    index_arr: np.ndarray,
    palette: list[tuple[int, int, int]],
    output_path: Path,
) -> None:
    """Save as indexed mode-P PNG."""
    out_img = Image.fromarray(index_arr, mode="P")
    flat_palette = [0] * (256 * 3)
    for i, rgb in enumerate(palette):
        flat_palette[3 * i : 3 * i + 3] = list(rgb)
    out_img.putpalette(flat_palette)
    out_img.save(output_path)
    print(f"  Saved: {output_path}")


# ---------------------------------------------------------------------------
# Step 7: Write provenance JSON
# ---------------------------------------------------------------------------

def write_provenance(
    cfg: dict,
    concept_hash: str,
    prompt_id: str,
    model_hash: str | None,
    lora_hash: str | None,
    state_name: str,
) -> None:
    """Write provenance JSON with concept_hash of the T-0212 idle-sheet-v2 seed."""
    prov = {
        "model": (
            f"sd_xl_base_1.0.safetensors + LoRA soviet_brutalism_style_v1.safetensors "
            f"(weight {LORA_WEIGHT})"
        ),
        "model_license": "CreativeML Open RAIL++-M (base) / CreativeML OpenRAIL++-M (LoRA)",
        "model_hash": model_hash,
        "lora_hash": lora_hash,
        "prompt": cfg["prompt"],
        "negative_prompt": NEGATIVE_PROMPT,
        "seed": cfg["seed"],
        "steps": STEPS,
        "cfg": CFG,
        "width": cfg["gen_w"],
        "height": cfg["gen_h"],
        "concept_hash": concept_hash,
        "concept_source": "assets/final/character/player_idle_sheet_v2.png",
        "concept_card": "T-0212",
        "method": (
            f"img2img concept-conditioned via ComfyUI HTTP API (SDXL KSampler, euler/normal, "
            f"denoise={cfg['denoise']}); single idle frame cell (0,0) cropped from T-0212 "
            "idle-sheet-v2 (player_idle_sheet_v2.png), scaled and tiled to "
            f"{cfg['cols']}x{cfg['rows']} at {cfg['gen_w']}x{cfg['gen_h']} as img2img "
            "template so character identity is preserved across all cells while diffusion "
            f"introduces {state_name}-specific pose variation per frame. "
            "ComfyUI workflow: assets/src/character/gen_states_v2_tiled.py"
        ),
        "img2img_denoise": cfg["denoise"],
        "idle_v2_crop": [0, 0, CELL_NATIVE, CELL_NATIVE],
        "tile_grid": (
            f"{cfg['cols']}x{cfg['rows']} "
            f"({cfg['gen_w'] // cfg['cols']}x{cfg['gen_h'] // cfg['rows']}px per cell)"
        ),
        "lora_name": "soviet_brutalism_style_v1.safetensors",
        "lora_weight": LORA_WEIGHT,
        "lora_license": "CreativeML OpenRAIL++-M",
        "comfyui_prompt_id": prompt_id,
        "generator": "assets/src/character/gen_states_v2_tiled.py",
        "card": "T-0213",
        "spec": (
            "docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) + "
            "§6 (archetype-first coherence guard)"
        ),
        "layout": {
            "sheet_px": [cfg["native_w"], cfg["native_h"]],
            "cell_px": CELL_NATIVE,
            "cols": cfg["cols"],
            "rows": cfg["rows"],
            "figure_height_px": 40,
            "frame_cells": [{"cell": c} for c in cfg["frame_cells"]],
            "spare_cells": cfg["spare_cells"],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    cfg["provenance_path"].write_text(json.dumps(prov, indent=2))
    print(f"  Provenance written: {cfg['provenance_path']}")


# ---------------------------------------------------------------------------
# Main: generate one state sheet
# ---------------------------------------------------------------------------

def generate_state(state_name: str) -> None:
    """Generate a single player state sheet via ComfyUI img2img."""
    cfg = STATES[state_name]
    print(f"\n=== T-0213: Player {state_name} sheet v2 — concept-conditioned ===\n")

    # Verify idle v2 sheet exists and hash it
    assert IDLE_V2_PATH.exists(), f"T-0212 idle-sheet-v2 not found: {IDLE_V2_PATH}"
    print("Step 0: Hash idle-sheet-v2 (conditioning chain)...")
    concept_hash = hashlib.sha256(IDLE_V2_PATH.read_bytes()).hexdigest()
    print(f"  concept_hash: {concept_hash}\n")

    # Hash models
    ckpt_path = COMFYUI_CHECKPOINTS / "sd_xl_base_1.0.safetensors"
    lora_path = COMFYUI_LORAS / "soviet_brutalism_style_v1.safetensors"
    print("Step 0b: Hash models...")
    model_hash = hash_file(ckpt_path) if ckpt_path.exists() else None
    lora_hash = hash_file(lora_path) if lora_path.exists() else None
    print(f"  model_hash: {model_hash}")
    print(f"  lora_hash:  {lora_hash}\n")

    print("Step 1: Build tiled template from idle-sheet-v2...")
    template_png = build_template(cfg)
    print()

    print("Step 2: Upload template to ComfyUI...")
    uploaded_name = upload_template(template_png, cfg["upload_filename"])
    print()

    print("Step 3: Submit img2img workflow...")
    workflow = build_workflow(uploaded_name, cfg)
    prompt_id = submit_workflow(workflow)
    print()

    print("Step 4: Poll for completion...")
    history_entry = poll_until_done(prompt_id, timeout_s=600)
    print()

    print("Step 5: Download output...")
    output_filename = get_output_filename(history_entry)
    print(f"  Output filename: {output_filename}")
    raw_img = download_output(output_filename)
    print()

    print("Step 6: Descent pipeline...")
    index_arr, palette = descent_pipeline(raw_img, cfg)
    save_indexed_png(index_arr, palette, cfg["output_path"])
    print()

    print("Step 7: Write provenance...")
    write_provenance(cfg, concept_hash, prompt_id, model_hash, lora_hash, state_name)
    print()

    print(f"=== DONE: {state_name} ===")
    print(f"Output: {cfg['output_path']}")
    print(f"Provenance: {cfg['provenance_path']}")


def main() -> None:
    import sys

    states = list(STATES.keys())
    if len(sys.argv) > 1:
        states = sys.argv[1:]

    for state_name in states:
        if state_name not in STATES:
            print(f"Unknown state '{state_name}'. Available: {list(STATES.keys())}")
            sys.exit(1)
        generate_state(state_name)

    print("\n=== ALL STATES COMPLETE ===")
    print("\nRun gate tests:")
    print(
        "  cd assets/src/character && .venv/bin/pytest "
        "tests/test_player_move_v2_gate.py "
        "tests/test_player_crouch_hide_v2_gate.py "
        "tests/test_player_die_v2_gate.py -v"
    )


if __name__ == "__main__":
    main()
