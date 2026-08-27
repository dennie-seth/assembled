#!/usr/bin/env python3
"""Arm A of the T-0227 character-pipeline bake-off (T-0228, HANDOFF §23-d).

`docs/design/13-asset-pipeline.md` §3.5 as written, fully equipped:
  - T-0072 style LoRA (soviet_brutalism_style_v1.safetensors)
  - T-0209's approved player concept sheet as the IP-Adapter reference
  - OpenPose ControlNet pose grid driving the 3x3 cell layout

DL-21 (`docs/decision-log.md`) pins the output spec (3x3 grid, 48x48 cells,
144x144 native, indexed to the locked 16-slot home palette) and the shared
IP-Adapter reference (T-0209's concept sheet) identically across all three
bake-off arms.

T-0218's stage-3 spike ran this same trio of components and reached
`ambiguous`: ControlNet, IP-Adapter, and the LoRA each demonstrably worked,
but the pose-grid conditioning image was itself generated as 9 independently
sampled SDXL "skeleton" panels, so cell-to-cell pose noise let the model
drift costume/equipment across rows (identity_drift). This script's one
change from T-0218's graph is structural, not cosmetic: the pose-grid image
is generated ONCE at cell resolution and tiled into the full pose-grid
canvas via ComfyUI's own ImageStitch node (bit-for-bit identical pose in
every cell), rather than asking SDXL to (re-)generate a skeleton per cell.
Everything else -- checkpoint, LoRA, IP-Adapter preset, ControlNet model,
descent method -- matches T-0218's validated stage-3 configuration.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/character/gen_arm_a_idle_T0228.py --attempt 1 --seed 31415

Writes (always, so every attempt is logged whether it passes or not):
    assets/out/arm_a/attempt_<N>/pose_grid_1008.png
    assets/out/arm_a/attempt_<N>/main_1008.png
    assets/out/arm_a/attempt_<N>/sheet_144_indexed.png
    assets/out/arm_a/attempt_<N>/provenance_candidate.json
    assets/src/character/ARM_A_ATTEMPTS_T0228.json   (appended, one row per attempt)

Promotion to assets/final/character/ (only for the attempt that passes both
DL-21 criteria) is a separate, explicit step -- see
`promote_arm_a_attempt.py` -- so a discarded attempt's bytes never land in
assets/final/ even transiently.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "asset-gate" / "src"))

from asset_gate import art as asset_gate_art  # noqa: E402
from asset_gate import palette as asset_gate_palette  # noqa: E402

COMFYUI_HOST = "172.18.192.1"
COMFYUI_PORT = 8188
COMFYUI_BASE = f"http://{COMFYUI_HOST}:{COMFYUI_PORT}"

CHECKPOINT = "sd_xl_base_1.0.safetensors"
CHECKPOINT_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
CHECKPOINT_LICENSE = "CreativeML Open RAIL++-M"

LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_PATH = REPO_ROOT / "assets" / "final" / "lora" / LORA_NAME
LORA_LICENSE = "CreativeML OpenRAIL++-M"

CONTROLNET_NAME = "controlnet-openpose-sdxl-1.0_xinsir.safetensors"
IPADAPTER_NAME = "ip-adapter-plus_sdxl_vit-h.safetensors"
IPADAPTER_PRESET = "PLUS (high strength)"

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

PALETTE_PATH = REPO_ROOT / "assets" / "final" / "palette" / "home_palette.json"

CELL_PX = 336  # per-cell generation resolution (x7 of the 48px cell; 8GB VRAM fallback, §3.5)
GEN_PX = CELL_PX * 3  # 1008 -- full pose-grid / main-generation canvas
FINAL_PX = 144  # native sheet size (3x3 of 48px cells)

# Approved-license allowlist (`.claude/rules/assets.md`): the hook enforces this
# repo-wide; this script refuses to build a graph against anything else.
CHECKPOINT_LICENSE_ALLOWLIST = frozenset(
    {"CreativeML Open RAIL++-M", "CreativeML OpenRAIL++-M", "Apache-2.0", "CC0"}
)

POSE_PROMPT = (
    "anatomical skeleton diagram, single humanoid figure, standing upright, "
    "front facing, arms at sides, symmetrical idle pose, skull ribcage pelvis "
    "limbs visible, thin white lines on solid black background, medical "
    "illustration, centered, no cropping"
)
POSE_NEGATIVE = "multiple figures, grid, color, background clutter, text, blurry"

MAIN_PROMPT = (
    "pixel art idle animation sprite sheet, Soviet brutalist armored soldier "
    "standing idle, flat front-on orthographic view, one single unchanging "
    "soldier repeated in every panel, same uniform and same equipment loadout "
    "in every panel, nine animation frames arranged in a 3x3 grid, identical "
    "character identity and camera angle across all cells, subtle idle motion "
    "between frames, slight weight shift and natural breathing pose variation, "
    "both feet on ground, arms relaxed at sides, upright standing posture, "
    "institutional grey concrete background, muted olive-green and grey "
    "military palette, value-separated pixel art silhouette, clean readable "
    "pixel outline, no perspective, no vanishing point"
)
MAIN_NEGATIVE = (
    "perspective, three-quarter view, vanishing point, diagonal, depth of "
    "field, blurry, low quality, text, watermark, multiple different "
    "characters per panel, action pose, background clutter, bright colours, "
    "photorealistic, character sheet, multi-angle turnaround, different "
    "viewing angles, costume variants, different uniform, different "
    "equipment, costume change between panels, inconsistent identity, "
    "skeleton, wireframe"
)

POSE_SEED = 77777  # fixed: only the main seed varies across attempts (DL-21 attempt log)


# ── ComfyUI HTTP client ──────────────────────────────────────────────────────


def _http_get(path: str) -> bytes:
    with urllib.request.urlopen(f"{COMFYUI_BASE}{path}", timeout=60) as resp:
        return resp.read()


def _http_post_json(path: str, obj: dict) -> dict:
    body = json.dumps(obj).encode("utf-8")
    req = urllib.request.Request(
        f"{COMFYUI_BASE}{path}", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def upload_image(path: Path) -> str:
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{path.name}"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode()
    body += path.read_bytes()
    body += f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{COMFYUI_BASE}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())["name"]


def submit_prompt(graph: dict) -> str:
    client_id = f"T-0228-arm-a-{uuid.uuid4().hex[:8]}"
    result = _http_post_json("/prompt", {"prompt": graph, "client_id": client_id})
    if "error" in result:
        raise RuntimeError(f"ComfyUI rejected the graph: {json.dumps(result['error'])}")
    return result["prompt_id"]


def wait_for_completion(prompt_id: str, timeout_s: int = 300, poll_s: int = 3) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        time.sleep(poll_s)
        try:
            history = json.loads(_http_get(f"/history/{prompt_id}"))
        except urllib.error.URLError:
            continue
        if prompt_id not in history:
            continue
        info = history[prompt_id]
        status = info.get("status", {})
        if status.get("completed"):
            return info
        if status.get("status_str") == "error":
            raise RuntimeError(f"ComfyUI job errored: {json.dumps(status)}")
    raise TimeoutError(f"timed out waiting for prompt {prompt_id}")


def fetch_save_image(info: dict, node_id: str) -> bytes:
    img = info["outputs"][node_id]["images"][0]
    filename = urllib.parse.quote(img["filename"])
    subfolder = urllib.parse.quote(img.get("subfolder", ""))
    image_type = img.get("type", "output")
    qs = f"filename={filename}&subfolder={subfolder}&type={image_type}"
    return _http_get(f"/view?{qs}")


# ── Graph builder ─────────────────────────────────────────────────────────────


def build_graph(
    seed: int,
    concept_filename: str,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    lora_weight: float,
) -> dict:
    """One combined graph: pose-skeleton generation -> deterministic 3x3 tiling
    via ImageStitch -> ControlNet + IP-Adapter + LoRA main generation -> area
    descent to 144x144. Submitted whole so the tiled pose grid is wired
    directly into ControlNetApplyAdvanced -- no intermediate upload round-trip,
    and the tile is guaranteed pixel-identical across all 9 cells because it is
    the same upstream IMAGE reused 9 times, not 9 independent samples.
    """
    g: dict = {}

    g["1"] = {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CHECKPOINT}}

    # -- pose skeleton (single cell, base checkpoint, no LoRA) --
    g["2"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": POSE_PROMPT, "clip": ["1", 1]},
    }
    g["3"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": POSE_NEGATIVE, "clip": ["1", 1]},
    }
    g["4"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": CELL_PX, "height": CELL_PX, "batch_size": 1},
    }
    g["5"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0],
            "positive": ["2", 0],
            "negative": ["3", 0],
            "latent_image": ["4", 0],
            "seed": POSE_SEED,
            "steps": 20,
            "cfg": 3.5,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    g["6"] = {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}}

    # -- tile the single pose cell into a 3x3 canvas, bit-for-bit identical --
    g["7"] = {
        "class_type": "ImageStitch",
        "inputs": {
            "image1": ["6", 0],
            "image2": ["6", 0],
            "direction": "right",
            "match_image_size": False,
            "spacing_width": 0,
            "spacing_color": "black",
        },
    }
    g["8"] = {
        "class_type": "ImageStitch",
        "inputs": {
            "image1": ["7", 0],
            "image2": ["6", 0],
            "direction": "right",
            "match_image_size": False,
            "spacing_width": 0,
            "spacing_color": "black",
        },
    }  # row: P|P|P, 1008x336
    g["9"] = {
        "class_type": "ImageStitch",
        "inputs": {
            "image1": ["8", 0],
            "image2": ["8", 0],
            "direction": "down",
            "match_image_size": False,
            "spacing_width": 0,
            "spacing_color": "black",
        },
    }  # two rows, 1008x672
    g["10"] = {
        "class_type": "ImageStitch",
        "inputs": {
            "image1": ["9", 0],
            "image2": ["8", 0],
            "direction": "down",
            "match_image_size": False,
            "spacing_width": 0,
            "spacing_color": "black",
        },
    }  # full pose grid, 1008x1008
    g["11"] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "arm_a_T0228_pose_grid", "images": ["10", 0]},
    }

    # -- main generation: LoRA + ControlNet(pose grid) + IP-Adapter(concept) --
    g["12"] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["1", 0],
            "clip": ["1", 1],
            "lora_name": LORA_NAME,
            "strength_model": lora_weight,
            "strength_clip": lora_weight,
        },
    }
    g["13"] = {"class_type": "CLIPTextEncode", "inputs": {"text": MAIN_PROMPT, "clip": ["12", 1]}}
    g["14"] = {"class_type": "CLIPTextEncode", "inputs": {"text": MAIN_NEGATIVE, "clip": ["12", 1]}}
    g["15"] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": CONTROLNET_NAME}}
    g["16"] = {
        "class_type": "ControlNetApplyAdvanced",
        "inputs": {
            "positive": ["13", 0],
            "negative": ["14", 0],
            "control_net": ["15", 0],
            "image": ["10", 0],
            "strength": controlnet_strength,
            "start_percent": 0.0,
            "end_percent": controlnet_end,
        },
    }
    g["17"] = {"class_type": "LoadImage", "inputs": {"image": concept_filename}}
    g["18"] = {
        "class_type": "IPAdapterUnifiedLoader",
        "inputs": {"model": ["12", 0], "preset": IPADAPTER_PRESET},
    }
    g["19"] = {
        "class_type": "IPAdapterAdvanced",
        "inputs": {
            "model": ["18", 0],
            "ipadapter": ["18", 1],
            "image": ["17", 0],
            "weight": ipadapter_weight,
            "weight_type": "linear",
            "combine_embeds": "concat",
            "start_at": 0.0,
            "end_at": 1.0,
            "embeds_scaling": "V only",
        },
    }
    g["20"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": GEN_PX, "height": GEN_PX, "batch_size": 1},
    }
    g["21"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["19", 0],
            "positive": ["16", 0],
            "negative": ["16", 1],
            "latent_image": ["20", 0],
            "seed": seed,
            "steps": 30,
            "cfg": 7.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    g["22"] = {"class_type": "VAEDecode", "inputs": {"samples": ["21", 0], "vae": ["1", 2]}}
    g["23"] = {
        "class_type": "ImageScale",
        "inputs": {
            "image": ["22", 0],
            "upscale_method": "area",
            "width": FINAL_PX,
            "height": FINAL_PX,
            "crop": "disabled",
        },
    }
    g["24"] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "arm_a_T0228_sheet_144", "images": ["23", 0]},
    }
    g["25"] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "arm_a_T0228_main_1008", "images": ["22", 0]},
    }
    return g


# ── Descent: Oklab-nearest palette quantization, dithering off (§3.1) ────────


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    lin = _srgb_to_linear(np.asarray(rgb, dtype=np.float64))
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l_), np.cbrt(m_), np.cbrt(s_)
    lightness = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return np.stack([lightness, a, b2], axis=-1)


def quantize_to_palette(rgb_image: Image.Image, palette: asset_gate_palette.Palette) -> Image.Image:
    """Nearest-neighbour quantize in Oklab space, no dithering (§3.1)."""
    arr = np.array(rgb_image.convert("RGB"))
    h, w = arr.shape[:2]
    pixels_oklab = _srgb_to_oklab(arr.reshape(-1, 3))

    slots = sorted(palette.rgb_by_index.items())
    slot_indices = np.array([i for i, _ in slots])
    slot_rgb = np.array([rgb for _, rgb in slots], dtype=np.float64)
    slot_oklab = _srgb_to_oklab(slot_rgb)

    # (num_pixels, num_slots) squared Oklab distance
    diff = pixels_oklab[:, None, :] - slot_oklab[None, :, :]
    dist2 = np.einsum("pnc,pnc->pn", diff, diff)
    nearest = slot_indices[np.argmin(dist2, axis=1)]

    indexed = Image.new("P", (w, h))
    indexed.putdata(nearest.astype(np.uint8).tolist())
    flat_palette = [0] * (256 * 3)
    for i, rgb in palette.rgb_by_index.items():
        flat_palette[3 * i : 3 * i + 3] = list(rgb)
    indexed.putpalette(flat_palette)
    return indexed


def cleanup_orphans(
    indexed: Image.Image, background_index: int, size_threshold: int
) -> Image.Image:
    """Replace foreground blobs smaller than size_threshold with the background
    index -- downscale noise cleanup (§3.1)."""
    try:
        from scipy import ndimage
    except ImportError:
        return indexed  # best-effort; asset_gate.art.check_orphan_pixels also no-ops without scipy

    arr = np.array(indexed)
    fg = arr != background_index
    labeled, n = ndimage.label(fg)
    if n == 0:
        return indexed
    sizes = ndimage.sum(fg, labeled, index=range(1, n + 1))
    out = arr.copy()
    for label_id, size in enumerate(sizes, start=1):
        if size < size_threshold:
            out[labeled == label_id] = background_index
    cleaned = Image.fromarray(out, mode="P")
    cleaned.putpalette(indexed.getpalette())
    return cleaned


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ── Attempt log + promotion (DL-21: every attempt logged, first pass promoted) ─

ATTEMPT_LOG_PATH = REPO_ROOT / "assets" / "src" / "character" / "ARM_A_ATTEMPT_LOG_T0228.md"
FINAL_CHARACTER_DIR = REPO_ROOT / "assets" / "final" / "character"
FINAL_SHEET_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_arm_a_T0228.png"
FINAL_PROVENANCE_PATH = FINAL_CHARACTER_DIR / "player_idle_sheet_arm_a_T0228.provenance.json"

ATTEMPT_LOG_HEADER = (
    "# Arm A attempt log (T-0228, HANDOFF §23-d, DL-21)\n\n"
    "Every attempt is recorded here whether it passes the mechanical gate or not, so "
    "attempts-to-first-pass is a real, auditable number. `mechanical_gate` is the "
    "frame-silhouette delta check (DL-21 criterion 2's mechanical half); the human "
    "silhouette-read (criterion 1) and human drift verdict (criterion 2's other half) "
    "are judged later, in §23-g, against the promoted sheet.\n\n"
    "| Attempt | Seed | ControlNet strength/end | IP-Adapter weight | LoRA weight | "
    "GPU seconds | Mechanical gate | Promoted |\n"
    "|---|---|---|---|---|---|---|---|\n"
)


def append_attempt_log(provenance: dict) -> None:
    if not ATTEMPT_LOG_PATH.exists():
        ATTEMPT_LOG_PATH.write_text(ATTEMPT_LOG_HEADER)
    row = (
        f"| {provenance['attempt']} | {provenance['seed']} "
        f"| {provenance['controlnet_strength']}/{provenance['controlnet_end_percent']} "
        f"| {provenance['ip_adapter_weight']} | {provenance['lora_weight']} "
        f"| {provenance['gpu_seconds']} "
        f"| {'PASS' if provenance['mechanical_gate_passed'] else 'FAIL'} "
        f"| {'yes' if provenance.get('promoted') else 'no'} |\n"
    )
    with ATTEMPT_LOG_PATH.open("a") as f:
        f.write(row)


def promote_attempt(out_dir: Path, provenance: dict) -> None:
    """Copy this attempt's indexed sheet + provenance into assets/final/character/.

    Only called for the first attempt whose mechanical gate passes -- a discarded
    attempt's bytes never land in assets/final/, even transiently (module docstring).
    """
    FINAL_CHARACTER_DIR.mkdir(parents=True, exist_ok=True)
    FINAL_SHEET_PATH.write_bytes((out_dir / "sheet_144_indexed.png").read_bytes())
    FINAL_PROVENANCE_PATH.write_text(json.dumps(provenance, indent=2) + "\n")


# ── Attempt driver ────────────────────────────────────────────────────────────


def run_attempt(
    attempt: int,
    seed: int,
    controlnet_strength: float,
    controlnet_end: float,
    ipadapter_weight: float,
    lora_weight: float,
) -> dict:
    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        raise RuntimeError(f"checkpoint license {CHECKPOINT_LICENSE!r} is not on the allowlist")

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        raise RuntimeError(
            f"concept sheet hash mismatch: got {concept_hash}, expected {EXPECTED_CONCEPT_HASH} "
            "-- refusing to condition on a sheet that is not T-0209's approved concept sheet"
        )
    lora_hash = sha256_of(LORA_PATH)

    out_dir = REPO_ROOT / "assets" / "out" / "arm_a" / f"attempt_{attempt}"
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.monotonic()
    concept_filename = upload_image(CONCEPT_SHEET_PATH)
    graph = build_graph(
        seed=seed,
        concept_filename=concept_filename,
        controlnet_strength=controlnet_strength,
        controlnet_end=controlnet_end,
        ipadapter_weight=ipadapter_weight,
        lora_weight=lora_weight,
    )
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id)
    gpu_seconds = time.monotonic() - t0

    pose_grid_bytes = fetch_save_image(info, "11")
    main_1008_bytes = fetch_save_image(info, "25")
    sheet_144_bytes = fetch_save_image(info, "24")

    (out_dir / "pose_grid_1008.png").write_bytes(pose_grid_bytes)
    (out_dir / "main_1008.png").write_bytes(main_1008_bytes)
    (out_dir / "sheet_144_raw.png").write_bytes(sheet_144_bytes)

    palette = asset_gate_palette.load_palette(PALETTE_PATH)
    raw = Image.open(out_dir / "sheet_144_raw.png")
    indexed = quantize_to_palette(raw, palette)
    indexed = cleanup_orphans(indexed, background_index=0, size_threshold=4)
    indexed.save(out_dir / "sheet_144_indexed.png")

    # Mechanical criterion-2 gate (DL-21): silhouette delta across all 9 cells,
    # row-major reading order, including both cross-row transitions.
    cells = {}
    for r in range(3):
        for c in range(3):
            cells[(r, c)] = indexed.crop((c * 48, r * 48, c * 48 + 48, r * 48 + 48))
    order = [(r, c) for r in range(3) for c in range(3)]
    frame_deltas = []
    for a, b in zip(order, order[1:]):
        result = asset_gate_art.check_frame_consistency(
            cells[a], cells[b], background_index=0, max_delta_ratio=0.30
        )
        frame_deltas.append(
            {
                "pair": [list(a), list(b)],
                "ratio": float(result.details["ratio"]),
                "passed": bool(result.passed),
            }
        )
    mechanical_gate_passed = all(d["passed"] for d in frame_deltas)

    model_summary = (
        f"{CHECKPOINT} + LoRA {LORA_NAME} (weight {lora_weight}) "
        f"+ IP-Adapter {IPADAPTER_NAME} + ControlNet {CONTROLNET_NAME}"
    )
    provenance = {
        "model": model_summary,
        "model_license": CHECKPOINT_LICENSE,
        "model_hash": CHECKPOINT_HASH,
        "lora_name": LORA_NAME,
        "lora_hash": lora_hash,
        "lora_weight": lora_weight,
        "lora_license": LORA_LICENSE,
        "ip_adapter": IPADAPTER_NAME,
        "ip_adapter_preset": IPADAPTER_PRESET,
        "ip_adapter_weight": ipadapter_weight,
        "controlnet": CONTROLNET_NAME,
        "controlnet_strength": controlnet_strength,
        "controlnet_end_percent": controlnet_end,
        "prompt": MAIN_PROMPT,
        "negative_prompt": MAIN_NEGATIVE,
        "pose_prompt": POSE_PROMPT,
        "pose_seed": POSE_SEED,
        "seed": seed,
        "steps": 30,
        "cfg": 7.0,
        "width": GEN_PX,
        "height": GEN_PX,
        "concept_hash": concept_hash,
        "concept_source": "assets/src/concept/player_character_concept_sheet_v1.png",
        "concept_card": "T-0209",
        "method": (
            "Single combined ComfyUI graph: SDXL txt2img skeleton (336x336, no LoRA) tiled "
            "bit-for-bit identical into a 1008x1008 pose grid via ImageStitch (right x2, down x2) "
            "-> ControlNetApplyAdvanced (xinsir OpenPose) "
            "+ IPAdapterAdvanced (PLUS, T-0209 concept) "
            "+ LoraLoader (soviet_brutalism_style_v1) -> KSampler 1008x1008 -> area downscale to "
            "144x144 -> Oklab-nearest palette quantization (dithering off, §3.1) -> orphan cleanup."
        ),
        "generator": "assets/src/character/gen_arm_a_idle_T0228.py",
        "card": "T-0228",
        "bake_off_arm": "A (§23-d)",
        "spec": "docs/decision-log.md DL-21 + docs/design/13-asset-pipeline.md §3.5",
        "comfyui_prompt_id": prompt_id,
        "attempt": attempt,
        "gpu_seconds": round(gpu_seconds, 1),
        "mechanical_gate_passed": mechanical_gate_passed,
        "frame_deltas": frame_deltas,
        "layout": {
            "sheet_px": [FINAL_PX, FINAL_PX],
            "cell_px": 48,
            "cols": 3,
            "rows": 3,
            "frame_cells": [list(k) for k in order],
        },
        "palette_source": "assets/final/palette/home_palette.json",
    }
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")

    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--attempt", type=int, required=True, help="attempt number, 1..8 (DL-21 cap)"
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--controlnet-strength", type=float, default=0.55)
    parser.add_argument("--controlnet-end", type=float, default=0.75)
    parser.add_argument("--ipadapter-weight", type=float, default=0.75)
    parser.add_argument("--lora-weight", type=float, default=0.70)
    args = parser.parse_args()

    if not (1 <= args.attempt <= 8):
        raise SystemExit("attempt cap is 8 per arm (DL-21) -- refusing to run a 9th attempt")

    provenance = run_attempt(
        attempt=args.attempt,
        seed=args.seed,
        controlnet_strength=args.controlnet_strength,
        controlnet_end=args.controlnet_end,
        ipadapter_weight=args.ipadapter_weight,
        lora_weight=args.lora_weight,
    )

    already_promoted = FINAL_SHEET_PATH.exists()
    promote_now = provenance["mechanical_gate_passed"] and not already_promoted
    provenance["promoted"] = promote_now
    out_dir = REPO_ROOT / "assets" / "out" / "arm_a" / f"attempt_{args.attempt}"
    (out_dir / "provenance_candidate.json").write_text(json.dumps(provenance, indent=2) + "\n")
    if promote_now:
        promote_attempt(out_dir, provenance)

    append_attempt_log(provenance)
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
