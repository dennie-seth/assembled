"""Generate concept-conditioned entity character sheets v2 (T-0214).

Produces 9 entity animation sheets conditioned on T-0210's entities concept
sheet (entities_concept_sheet_v1.png) via ComfyUI img2img + LoRA:
  - Watcher: idle (3×2, 6 frames), move (4×2, 8 frames), trapped (2×2, 4 frames)
  - Sound: idle (3×2), move (4×2), trapped (2×2)
  - Still Air: idle (3×2), move (4×2), trapped (2×2)

Pipeline (13-asset-pipeline.md §3.1, §6.11):
  crop concept section -> tile to gen dims -> upload to ComfyUI ->
  img2img + LoRA (SDXL) -> fetch raw output -> descend cell-by-cell
  (8x, 384->48px, Oklab quantize + orphan cleanup) -> stitch sheet ->
  write indexed PNG (mode P) + provenance JSON.

Requires:
  - ComfyUI at http://172.18.192.1:8188
  - sd_xl_base_1.0.safetensors + soviet_brutalism_style_v1.safetensors
  - pillow, numpy installed (char-gen pyproject.toml deps)

Usage:
    cd /path/to/repo
    python3 assets/src/character/gen_entities_v2.py
"""

from __future__ import annotations

import hashlib
import io
import json
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from PIL import Image
from PIL.Image import Resampling

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[3]
CONCEPT_SHEET = REPO_ROOT / "assets" / "src" / "concept" / "entities_concept_sheet_v1.png"
CONCEPT_PROV = REPO_ROOT / "assets" / "src" / "concept" / "entities_concept_sheet_v1.provenance.json"
PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"
ENTITY_OUT = REPO_ROOT / "assets" / "final" / "entity"
OUT_RAW = REPO_ROOT / "assets" / "out" / "entity_v2_raw"

COMFYUI_URL = "http://172.18.192.1:8188"
CHECKPOINT = "sd_xl_base_1.0.safetensors"
LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_WEIGHT = 0.70
# Known hashes from T-0213 provenance
MODEL_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
LORA_HASH = "2dab82287f6d36a98a142dae5199df47e001d86d4c9507a0524742b4d34f2b9f"

CELL_NATIVE = 48   # native cell size (px)
CELL_GEN = 384     # generation cell size (= CELL_NATIVE × 8)

NEGATIVE_PROMPT = (
    "humanoid, arms, legs, head on humanoid body, multiple different entities, "
    "perspective, vanishing point, three-quarter view, atmospheric haze, depth of field, "
    "blurry, low quality, photorealistic, watermark, text, UI, background clutter, "
    "bright saturated colors, cartoon, cheerful, scene composition, player character, "
    "single isolated entity without context, busy background"
)

# ---------------------------------------------------------------------------
# Concept sheet crop coordinates (matches _gen_entities_concept.py layout):
#   MARGIN=16, GUTTER=8, PW=PH=492, SEC_W=164
#   Panel IDLE:    x=[16,  508], y=[16,  508]
#   Panel MOVE:    x=[524, 1016], y=[16,  508]
#   Panel TRAPPED: x=[16,  508], y=[524, 1016]
#   Watcher:   x_offset=[0,   164]
#   Sound:     x_offset=[164, 328]
#   Still Air: x_offset=[328, 492]
# ---------------------------------------------------------------------------

CONCEPT_CROPS: dict[tuple[str, str], tuple[int, int, int, int]] = {
    # (entity, state): (x0, y0, x1, y1)
    ("watcher", "idle"):     (16,  16,  180, 508),
    ("watcher", "move"):     (524, 16,  688, 508),
    ("watcher", "trapped"):  (16,  524, 180, 1016),
    ("sound", "idle"):       (180, 16,  344, 508),
    ("sound", "move"):       (688, 16,  852, 508),
    ("sound", "trapped"):    (180, 524, 344, 1016),
    ("still_air", "idle"):   (344, 16,  508, 508),
    ("still_air", "move"):   (852, 16,  1016, 508),
    ("still_air", "trapped"): (344, 524, 508, 1016),
}

# ---------------------------------------------------------------------------
# Sheet specs: (cols, rows, seed, prompt)
# ---------------------------------------------------------------------------

ENTITY_SPECS: list[dict] = [
    # Watcher — wide compact surveillance orb
    {
        "entity": "watcher", "state": "idle",
        "cols": 3, "rows": 2,
        "seed": 21401,
        "denoise": 0.80,
        "prompt": (
            "pixel art sprite sheet, wide compact surveillance orb entity, flat side-on "
            "orthographic, six frame cells arranged in a 3x2 grid, same entity in every cell, "
            "subtle idle float animation between cells, wide horizontal orb silhouette with "
            "scanner lens detail on lower face, concrete grey body with institutional green "
            "accent lens, no limbs, non-humanoid foreign entity, Soviet brutalist interior "
            "aesthetic, muted desaturated home palette, value-separated pixel art silhouette, "
            "clean readable pixel outline, no perspective, no vanishing point, no background "
            "elements, no multiple different entities, no text, no UI"
        ),
    },
    {
        "entity": "watcher", "state": "move",
        "cols": 4, "rows": 2,
        "seed": 21402,
        "denoise": 0.85,
        "prompt": (
            "pixel art sprite sheet, wide compact surveillance orb entity horizontal drift "
            "animation, flat side-on orthographic, eight frame cells arranged in a 4x2 grid, "
            "same entity in every cell, entity position drifts left and right across cells "
            "in a smooth horizontal glide cycle, wide horizontal orb silhouette with scanner "
            "lens, concrete grey body with institutional green accent, no limbs, non-humanoid, "
            "Soviet brutalist aesthetic, muted desaturated palette, value-separated pixel art, "
            "no perspective, no text"
        ),
    },
    {
        "entity": "watcher", "state": "trapped",
        "cols": 2, "rows": 2,
        "seed": 21403,
        "denoise": 0.80,
        "prompt": (
            "pixel art sprite sheet, wide compact surveillance orb entity constrained/trapped "
            "state, flat side-on orthographic, four frame cells arranged in a 2x2 grid, same "
            "entity in every cell, entity appears contained or delayed with subtle micro-float "
            "variation, wide horizontal orb silhouette with scanner lens, concrete grey body "
            "with institutional green accent, no limbs, non-humanoid, Soviet brutalist aesthetic, "
            "muted desaturated palette, value-separated pixel art, no perspective, no text"
        ),
    },
    # Sound — wide flat wave-band
    {
        "entity": "sound", "state": "idle",
        "cols": 3, "rows": 2,
        "seed": 21404,
        "denoise": 0.80,
        "prompt": (
            "pixel art sprite sheet, wide flat wave-band entity, flat side-on orthographic, "
            "six frame cells arranged in a 3x2 grid, same entity in every cell, subtle idle "
            "float animation, wide horizontal ripple band silhouette with lighter crest accent "
            "on upper edge, desaturated institutional green tones, no limbs, ambient and "
            "expansive non-humanoid entity, Soviet brutalist aesthetic, muted desaturated "
            "home palette, value-separated pixel art silhouette, no perspective, no text"
        ),
    },
    {
        "entity": "sound", "state": "move",
        "cols": 4, "rows": 2,
        "seed": 21405,
        "denoise": 0.85,
        "prompt": (
            "pixel art sprite sheet, wide flat wave-band entity horizontal drift animation, "
            "flat side-on orthographic, eight frame cells arranged in a 4x2 grid, same entity "
            "in every cell, entity position drifts left and right across cells, wide horizontal "
            "ripple band with lighter crest accent on top, desaturated institutional green "
            "tones, no limbs, non-humanoid, Soviet brutalist aesthetic, muted desaturated "
            "palette, value-separated pixel art, no perspective, no text"
        ),
    },
    {
        "entity": "sound", "state": "trapped",
        "cols": 2, "rows": 2,
        "seed": 21406,
        "denoise": 0.80,
        "prompt": (
            "pixel art sprite sheet, wide flat wave-band entity constrained/trapped state, "
            "flat side-on orthographic, four frame cells arranged in a 2x2 grid, same entity "
            "in every cell, subtle micro-float variation, wide horizontal ripple band with "
            "lighter crest accent, desaturated institutional green tones, no limbs, "
            "non-humanoid, Soviet brutalist aesthetic, muted palette, pixel art, no text"
        ),
    },
    # Still Air — tall narrow atmospheric column
    {
        "entity": "still_air", "state": "idle",
        "cols": 3, "rows": 2,
        "seed": 21407,
        "denoise": 0.80,
        "prompt": (
            "pixel art sprite sheet, tall narrow atmospheric column entity, flat side-on "
            "orthographic, six frame cells arranged in a 3x2 grid, same entity in every cell, "
            "subtle idle float animation, tall narrow vertical pillar silhouette with pale "
            "glowing cap at top, pale concrete grey tones, no limbs, inevitable and silent "
            "non-humanoid entity, Soviet brutalist aesthetic, muted desaturated home palette, "
            "value-separated pixel art silhouette, no perspective, no text"
        ),
    },
    {
        "entity": "still_air", "state": "move",
        "cols": 4, "rows": 2,
        "seed": 21408,
        "denoise": 0.85,
        "prompt": (
            "pixel art sprite sheet, tall narrow atmospheric column entity horizontal sway "
            "animation, flat side-on orthographic, eight frame cells arranged in a 4x2 grid, "
            "same entity in every cell, entity position sways left and right with subtle "
            "horizontal drift across cells, tall narrow pillar silhouette with pale cap at "
            "top, pale concrete grey tones, no limbs, non-humanoid, Soviet brutalist aesthetic, "
            "muted desaturated palette, value-separated pixel art, no perspective, no text"
        ),
    },
    {
        "entity": "still_air", "state": "trapped",
        "cols": 2, "rows": 2,
        "seed": 21409,
        "denoise": 0.80,
        "prompt": (
            "pixel art sprite sheet, tall narrow atmospheric column entity constrained/trapped "
            "state, flat side-on orthographic, four frame cells arranged in a 2x2 grid, same "
            "entity in every cell, subtle micro-float variation, tall narrow pillar silhouette "
            "with pale cap at top, pale concrete grey tones, no limbs, non-humanoid, Soviet "
            "brutalist aesthetic, muted palette, pixel art, no text"
        ),
    },
]

# ---------------------------------------------------------------------------
# Palette loading
# ---------------------------------------------------------------------------

def _load_palette() -> list[tuple[int, int, int]]:
    data = json.loads(PALETTE_PATH.read_text())
    by_index = {}
    for slot in data["slots"]:
        idx = int(slot["index"])
        h = slot["hex"].lstrip("#")
        by_index[idx] = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return [by_index[i] for i in range(len(by_index))]


# ---------------------------------------------------------------------------
# Descent chain (inlined from tools/comfy-client/src/comfy_client/)
# ---------------------------------------------------------------------------

def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    lin = _srgb_to_linear(np.asarray(rgb, dtype=np.float64))
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m_ = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s_ = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    lightness = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([lightness, a, b2], axis=-1)


def _quantize_to_palette(
    image: Image.Image, palette: list[tuple[int, int, int]]
) -> np.ndarray:
    arr = np.array(image.convert("RGB"), dtype=np.uint8)
    h, w, _ = arr.shape
    pixel_oklab = _srgb_to_oklab(arr.reshape(-1, 3))
    palette_oklab = _srgb_to_oklab(np.array(palette, dtype=np.uint8))
    dists = ((pixel_oklab[:, None, :] - palette_oklab[None, :, :]) ** 2).sum(axis=-1)
    return dists.argmin(axis=1).astype(np.uint8).reshape(h, w)


def _cleanup_orphans(index_arr: np.ndarray) -> np.ndarray:
    h, w = index_arr.shape
    out = index_arr.copy()
    for y in range(h):
        for x in range(w):
            idx = index_arr[y, x]
            neighbours = []
            if y > 0:
                neighbours.append(index_arr[y - 1, x])
            if y < h - 1:
                neighbours.append(index_arr[y + 1, x])
            if x > 0:
                neighbours.append(index_arr[y, x - 1])
            if x < w - 1:
                neighbours.append(index_arr[y, x + 1])
            if neighbours and idx not in neighbours:
                values, counts = np.unique(neighbours, return_counts=True)
                out[y, x] = values[np.argmax(counts)]
    return out


def _to_indexed_image(
    index_arr: np.ndarray, palette: list[tuple[int, int, int]]
) -> Image.Image:
    image = Image.fromarray(index_arr, mode="P")
    flat_palette = [0] * (256 * 3)
    for i, rgb in enumerate(palette):
        flat_palette[3 * i: 3 * i + 3] = list(rgb)
    image.putpalette(flat_palette)
    return image


def descend_cell(cell_img: Image.Image, palette: list[tuple[int, int, int]]) -> Image.Image:
    """Descend a square CELL_GEN×CELL_GEN cell to CELL_NATIVE×CELL_NATIVE indexed PNG."""
    assert cell_img.size[0] == CELL_GEN and cell_img.size[1] == CELL_GEN, (
        f"expected {CELL_GEN}×{CELL_GEN} cell, got {cell_img.size}"
    )
    downscaled = cell_img.resize((CELL_NATIVE, CELL_NATIVE), Resampling.BOX)
    index_arr = _quantize_to_palette(downscaled, palette)
    index_arr = _cleanup_orphans(index_arr)
    return _to_indexed_image(index_arr, palette)


def stitch_sheet(
    descended_cells: list[Image.Image], cols: int, rows: int
) -> Image.Image:
    """Stitch descended 48×48 cells into the final indexed PNG sheet."""
    w = cols * CELL_NATIVE
    h = rows * CELL_NATIVE
    sheet = Image.new("P", (w, h))
    # Copy palette from first cell
    sheet.putpalette(descended_cells[0].getpalette())
    for idx, cell in enumerate(descended_cells):
        row = idx // cols
        col = idx % cols
        x0 = col * CELL_NATIVE
        y0 = row * CELL_NATIVE
        sheet.paste(cell, (x0, y0))
    return sheet


# ---------------------------------------------------------------------------
# ComfyUI HTTP API (stdlib urllib only)
# ---------------------------------------------------------------------------

CLIENT_ID = f"T-0214-entities-v2-{uuid.uuid4().hex[:8]}"


def _comfyui_post_json(path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{COMFYUI_URL}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _comfyui_get_json(path: str) -> dict:
    with urllib.request.urlopen(f"{COMFYUI_URL}{path}", timeout=30) as resp:
        return json.loads(resp.read())


def _comfyui_upload_image(image_bytes: bytes, filename: str) -> str:
    """Upload image to ComfyUI /upload/image and return the server-side name."""
    boundary = uuid.uuid4().hex
    body_parts = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'.encode(),
        b"Content-Type: image/png\r\n",
        b"\r\n",
        image_bytes,
        b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="type"\r\n',
        b"\r\n",
        b"input",
        b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="overwrite"\r\n',
        b"\r\n",
        b"true",
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    body = b"".join(body_parts)
    req = urllib.request.Request(
        f"{COMFYUI_URL}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["name"]


def _comfyui_fetch_output(job_result: dict) -> bytes:
    outputs = job_result.get("outputs", {})
    for node_output in outputs.values():
        images = node_output.get("images")
        if images:
            img = images[0]
            fname = urllib.parse.quote(img["filename"])
            subfolder = img.get("subfolder", "")
            file_type = img.get("type", "output")
            url = (
                f"{COMFYUI_URL}/view?filename={fname}"
                f"&subfolder={subfolder}&type={file_type}"
            )
            with urllib.request.urlopen(url, timeout=60) as resp:
                return resp.read()
    raise RuntimeError(f"no image outputs in job result: {job_result!r}")


def _poll_until_done(prompt_id: str, timeout: float = 600.0) -> dict:
    deadline = time.monotonic() + timeout
    interval = 2.0
    while True:
        history = _comfyui_get_json(f"/history/{prompt_id}")
        entry = history.get(prompt_id)
        if entry is not None:
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "success":
                return entry
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI job {prompt_id} failed: {status}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"ComfyUI job {prompt_id} timed out after {timeout}s")
        print(f"  polling {prompt_id[:8]}... (waiting {interval:.0f}s)")
        time.sleep(interval)
        interval = min(interval * 1.5, 10.0)


def _build_workflow(
    prompt: str,
    negative_prompt: str,
    init_image_name: str,
    seed: int,
    denoise: float,
    filename_prefix: str,
    steps: int = 30,
    cfg: float = 7.0,
) -> dict:
    """Build an img2img + LoRA ComfyUI workflow graph."""
    return {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": CHECKPOINT},
        },
        "12": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["4", 0],
                "clip": ["4", 1],
                "lora_name": LORA_NAME,
                "strength_model": LORA_WEIGHT,
                "strength_clip": LORA_WEIGHT,
            },
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["12", 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative_prompt, "clip": ["12", 1]},
        },
        "10": {
            "class_type": "LoadImage",
            "inputs": {"image": init_image_name},
        },
        "11": {
            "class_type": "VAEEncode",
            "inputs": {"pixels": ["10", 0], "vae": ["4", 2]},
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": denoise,
                "model": ["12", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["11", 0],
            },
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": filename_prefix, "images": ["8", 0]},
        },
    }


def _workflow_hash(graph: dict) -> str:
    canonical = json.dumps(graph, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Concept sheet preparation
# ---------------------------------------------------------------------------

def _make_init_image(entity: str, state: str, cols: int, rows: int) -> tuple[bytes, str]:
    """Crop entity/state section from concept sheet, tile to gen dims, return PNG bytes."""
    concept = Image.open(CONCEPT_SHEET).convert("RGB")
    x0, y0, x1, y1 = CONCEPT_CROPS[(entity, state)]
    crop = concept.crop((x0, y0, x1, y1))
    # Resize crop to one cell size
    cell_img = crop.resize((CELL_GEN, CELL_GEN), Resampling.LANCZOS)
    # Tile across the sheet
    sheet_w = cols * CELL_GEN
    sheet_h = rows * CELL_GEN
    tiled = Image.new("RGB", (sheet_w, sheet_h))
    for row in range(rows):
        for col in range(cols):
            tiled.paste(cell_img, (col * CELL_GEN, row * CELL_GEN))
    buf = io.BytesIO()
    tiled.save(buf, format="PNG")
    return buf.getvalue(), f"entity_v2_init_{entity}_{state}.png"


# ---------------------------------------------------------------------------
# Main generation loop
# ---------------------------------------------------------------------------

def _load_concept_hash() -> str:
    prov = json.loads(CONCEPT_PROV.read_text())
    # T-0210 provenance stores the hash of its own output as concept_hash
    return prov["concept_hash"]


def generate_entity_sheet(spec: dict, palette: list[tuple[int, int, int]], concept_hash: str) -> None:
    entity = spec["entity"]
    state = spec["state"]
    cols = spec["cols"]
    rows = spec["rows"]
    seed = spec["seed"]
    denoise = spec["denoise"]
    prompt = spec["prompt"]
    sheet_name = f"{entity}_{state}_sheet_v2"
    out_png = ENTITY_OUT / f"{sheet_name}.png"
    out_prov = ENTITY_OUT / f"{sheet_name}.provenance.json"

    print(f"\n=== Generating {sheet_name} ({cols}×{rows} grid) ===")

    # 1. Prepare tiled init image
    init_bytes, init_filename = _make_init_image(entity, state, cols, rows)
    print(f"  Init image: {cols * CELL_GEN}×{rows * CELL_GEN}px tiled from concept crop")

    # 2. Upload init image
    print("  Uploading init image to ComfyUI...")
    uploaded_name = _comfyui_upload_image(init_bytes, init_filename)
    print(f"  Uploaded as: {uploaded_name}")

    # 3. Build and submit workflow
    filename_prefix = f"entity_v2/{sheet_name}"
    graph = _build_workflow(
        prompt=prompt,
        negative_prompt=NEGATIVE_PROMPT,
        init_image_name=uploaded_name,
        seed=seed,
        denoise=denoise,
        filename_prefix=filename_prefix,
    )
    graph_hash = _workflow_hash(graph)
    payload = {"prompt": graph, "client_id": CLIENT_ID}
    print(f"  Submitting to ComfyUI (seed={seed}, denoise={denoise})...")
    result = _comfyui_post_json("/prompt", payload)
    prompt_id = result["prompt_id"]
    print(f"  prompt_id: {prompt_id}")

    # 4. Poll until complete
    job_result = _poll_until_done(prompt_id)
    print("  Generation complete.")

    # 5. Fetch raw output
    raw_bytes = _comfyui_fetch_output(job_result)
    print(f"  Fetched raw output: {len(raw_bytes)} bytes")

    # Save raw output for reproducibility
    OUT_RAW.mkdir(parents=True, exist_ok=True)
    raw_path = OUT_RAW / f"{sheet_name}_raw_{seed}.png"
    raw_path.write_bytes(raw_bytes)
    print(f"  Saved raw to {raw_path}")

    # 6. Load raw image and process cell by cell
    raw_img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    expected_w = cols * CELL_GEN
    expected_h = rows * CELL_GEN
    if raw_img.size != (expected_w, expected_h):
        # Resize if ComfyUI slightly differs (shouldn't happen but safety net)
        print(f"  Warning: raw size {raw_img.size} != expected {expected_w}×{expected_h}, resizing")
        raw_img = raw_img.resize((expected_w, expected_h), Resampling.BOX)

    # 7. Descend each cell
    descended: list[Image.Image] = []
    for row in range(rows):
        for col in range(cols):
            x0 = col * CELL_GEN
            y0 = row * CELL_GEN
            cell = raw_img.crop((x0, y0, x0 + CELL_GEN, y0 + CELL_GEN))
            d_cell = descend_cell(cell, palette)
            descended.append(d_cell)
    print(f"  Descended {len(descended)} cells to {CELL_NATIVE}×{CELL_NATIVE}px")

    # 8. Stitch final sheet
    final_sheet = stitch_sheet(descended, cols, rows)
    ENTITY_OUT.mkdir(parents=True, exist_ok=True)
    final_sheet.save(out_png)
    print(f"  Saved final sheet: {out_png}")

    # 9. Write provenance
    entity_display = entity.replace("_", " ").title()
    prov = {
        "model": f"{CHECKPOINT} + LoRA {LORA_NAME} (weight {LORA_WEIGHT})",
        "model_license": "CreativeML Open RAIL++-M (SDXL base) / CreativeML OpenRAIL++-M (LoRA)",
        "model_hash": MODEL_HASH,
        "lora_hash": LORA_HASH,
        "prompt": prompt,
        "negative_prompt": NEGATIVE_PROMPT,
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "sampler": "euler",
        "scheduler": "normal",
        "denoise": denoise,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/entities_concept_sheet_v1.png",
        "concept_card": "T-0210",
        "method": (
            f"img2img concept-conditioned via ComfyUI HTTP API "
            f"(SDXL KSampler, euler/normal, denoise={denoise}); "
            f"entity section cropped from T-0210 entities_concept_sheet_v1.png "
            f"({entity}/{state} crop {CONCEPT_CROPS[(entity, state)]}), "
            f"scaled to {CELL_GEN}×{CELL_GEN}px and tiled {cols}×{rows} "
            f"at {cols * CELL_GEN}×{rows * CELL_GEN}px as img2img init. "
            f"Descent: Oklab nearest-colour palette quantize -> orphan cleanup -> "
            f"indexed PNG (mode P). "
            f"ComfyUI workflow hash: {graph_hash}. "
            f"Generator: assets/src/character/gen_entities_v2.py"
        ),
        "img2img_denoise": denoise,
        "init_tiled_dims": f"{cols}x{rows} ({cols * CELL_GEN}x{rows * CELL_GEN}px per sheet, {CELL_GEN}x{CELL_GEN}px per cell)",
        "concept_crop_box": list(CONCEPT_CROPS[(entity, state)]),
        "lora_name": LORA_NAME,
        "lora_weight": LORA_WEIGHT,
        "lora_license": "CreativeML OpenRAIL++-M",
        "workflow_hash": graph_hash,
        "comfyui_prompt_id": prompt_id,
        "generator": "assets/src/character/gen_entities_v2.py",
        "card": "T-0214",
        "spec": "docs/design/13-asset-pipeline.md §3.5 (Characters — the hard class) §6.11 (concept conditioning)",
        "layout": {
            "sheet_px": [cols * CELL_NATIVE, rows * CELL_NATIVE],
            "cell_px": CELL_NATIVE,
            "cols": cols,
            "rows": rows,
            "entity": entity_display,
            "state": state,
            "frame_count": cols * rows,
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    out_prov.write_text(json.dumps(prov, indent=2))
    print(f"  Saved provenance: {out_prov}")


def main() -> None:
    print("T-0214 Entity Sheets v2 Generation")
    print(f"ComfyUI: {COMFYUI_URL}")
    print(f"Concept sheet: {CONCEPT_SHEET}")

    # Load concept hash (sha256 of T-0210's concept sheet output)
    concept_hash = _load_concept_hash()
    print(f"Concept hash: {concept_hash}")

    # Load home palette
    palette = _load_palette()
    print(f"Loaded palette: {len(palette)} colours")

    # Verify ComfyUI is reachable
    try:
        sys_stats = _comfyui_get_json("/system_stats")
        comfyui_ver = sys_stats["system"]["comfyui_version"]
        print(f"ComfyUI version: {comfyui_ver} ✓")
    except Exception as e:
        print(f"ERROR: ComfyUI not reachable at {COMFYUI_URL}: {e}")
        raise SystemExit(1)

    ENTITY_OUT.mkdir(parents=True, exist_ok=True)

    for spec in ENTITY_SPECS:
        generate_entity_sheet(spec, palette, concept_hash)

    print("\n✓ All 9 entity sheets generated successfully.")
    print(f"  Sheets in: {ENTITY_OUT}")
    print("\nNext steps:")
    print("  1. Run gate tests: cd assets/src/character && pytest tests/*gate_v2*")
    print("  2. Attach sheets to card T-0214 via attachments API")
    print("  3. Update ASSET_PROVENANCE.md")
    print("  4. Commit everything")


if __name__ == "__main__":
    main()
