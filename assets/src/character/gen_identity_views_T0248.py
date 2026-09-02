#!/usr/bin/env python3
"""Round-2 identity-view generator — T-0248 (HANDOFF §24-a).

Round 1's `player_identity_v1` (T-0237/T-0229) trained on 12 refs cropped
directly out of T-0209's sheet -- already single-costume (only the
institutional-green-coat panels were curated), but only two real camera
angles (front, back) before horizontal mirroring, because the source sheet
itself has no more angle coverage than that to crop from.

This script generates real angle/pose diversity for the *same* costume
instead: SDXL + the T-0072 style LoRA (`soviet_brutalism_style_v1`) +
IP-Adapter conditioned on exactly one fixed anchor panel
(`identity_refs/ref_002.png`, T-0229's "front view, arms at sides" crop --
see CANONICAL_COSTUME_SELECTION_T0248.md for why this single panel and not
several). One fixed anchor, varied only by view/pose prompt and seed, is
the deliberate mechanism: round 1's diagnosis is that letting multiple
reference panels (spanning several designs) into the conditioning signal is
what let the trained/generated identity drift. No ControlNet is used here --
unlike the idle-sheet generation arms, this is dataset generation for
training, not a fixed pose-grid product, so pose variety across candidates
is exactly the point.

Usage (from the repo root, against the WSL2->Windows ComfyUI host):
    python3 assets/src/character/gen_identity_views_T0248.py

Writes (gitignored, for curation review -- not the committed deliverable):
    assets/out/identity_views_v2/<view_id>.png
    assets/out/identity_views_v2/<view_id>.provenance.json

Curation (a separate, explicit step -- see curate_identity_views_T0248.py)
copies the kept subset into the committed assets/src/character/identity_refs_v2/
and writes identity_curation_manifest_T0248.json recording what was kept and
what was dropped, per the card's acceptance criteria.
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

REPO_ROOT = Path(__file__).resolve().parents[3]

COMFYUI_HOST = "172.18.192.1"
COMFYUI_PORT = 8188
COMFYUI_BASE = f"http://{COMFYUI_HOST}:{COMFYUI_PORT}"

CHECKPOINT = "sd_xl_base_1.0.safetensors"
CHECKPOINT_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
CHECKPOINT_LICENSE = "CreativeML Open RAIL++-M"

LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_PATH = REPO_ROOT / "assets" / "final" / "lora" / LORA_NAME
LORA_LICENSE = "CreativeML OpenRAIL++-M"
LORA_WEIGHT = 0.70

IPADAPTER_NAME = "ip-adapter-plus_sdxl_vit-h.safetensors"
IPADAPTER_PRESET = "PLUS (high strength)"
IPADAPTER_WEIGHT = 0.62  # moderate: enough identity retention to survive angle changes
# without pinning composition/pose so hard that every view collapses to the anchor's own.

ANCHOR_REF_PATH = REPO_ROOT / "assets" / "src" / "character" / "identity_refs" / "ref_002.png"

CONCEPT_SHEET_PATH = (
    REPO_ROOT / "assets" / "src" / "concept" / "player_character_concept_sheet_v1.png"
)
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"

CHECKPOINT_LICENSE_ALLOWLIST = frozenset(
    {"CreativeML Open RAIL++-M", "CreativeML OpenRAIL++-M", "Apache-2.0", "CC0"}
)

TRIGGER_TOKEN = "sbrutalistplayer"
COSTUME_ID = "institutional_green_coat_v1"

GEN_PX = 1024

BASE_PROMPT = (
    "flat colour concept illustration, single figure, {view}, "
    "sbrutalistplayer character, Soviet brutalist institutional green hooded "
    "coat, white gloves, dark boots, one single unchanging costume, grey "
    "flat background, no props, no text, no watermark, no vignette, game "
    "asset reference pose"
)
NEGATIVE_PROMPT = (
    "multiple figures, two characters, group, different costume, different "
    "colour coat, tan coat, khaki coat, armour plating, different uniform, "
    "costume change, inconsistent identity, photorealistic, three "
    "dimensional render, blurry, low quality, text, watermark, signature, "
    "cropped head, cropped feet, extra limbs, deformed hands"
)

# Each candidate view: (id, prompt fragment, seed). Same fixed anchor/style
# LoRA/IP-Adapter weight for every one -- only the prompt text and seed vary,
# so any costume drift in a candidate is attributable to the view/pose ask,
# not to a moving conditioning target.
VIEWS: list[tuple[str, str, int]] = [
    ("v001", "front view, standing idle, arms at sides", 24801),
    ("v002", "front view, standing idle, arms at sides", 24802),
    ("v003", "front view, standing idle, arms at sides", 24803),
    ("v004", "three-quarter front-left view, standing idle", 24804),
    ("v005", "three-quarter front-right view, standing idle", 24805),
    ("v006", "profile view facing left, standing idle", 24806),
    ("v007", "profile view facing right, standing idle", 24807),
    ("v008", "three-quarter back-left view, standing idle", 24808),
    ("v009", "three-quarter back-right view, standing idle", 24809),
    ("v010", "back view, standing idle", 24810),
    ("v011", "back view, standing idle", 24811),
    ("v012", "front view, walking mid-stride, left leg forward", 24812),
    ("v013", "front view, walking mid-stride, right leg forward", 24813),
    ("v014", "profile view facing left, walking mid-stride", 24814),
    ("v015", "profile view facing right, walking mid-stride", 24815),
    ("v016", "front view, crouching low", 24816),
    ("v017", "three-quarter front-left view, crouching low", 24817),
    ("v018", "front view, right arm raised", 24818),
    ("v019", "front view, left arm raised", 24819),
    ("v020", "three-quarter front-right view, right arm raised", 24820),
    ("v021", "front view, hood up, arms at sides", 24821),
    ("v022", "front view, hood down, arms at sides", 24822),
    ("v023", "back view, hood up", 24823),
    ("v024", "profile view facing left, hood down", 24824),
    ("v025", "front view, slight weight shift left, arms at sides", 24825),
    ("v026", "front view, slight weight shift right, arms at sides", 24826),
    ("v027", "three-quarter front-left view, walking mid-stride", 24827),
    ("v028", "three-quarter back-left view, walking mid-stride", 24828),
    ("v029", "front view, both arms slightly forward, alert stance", 24829),
    ("v030", "profile view facing right, crouching low", 24830),
    ("v031", "back view, walking mid-stride", 24831),
    ("v032", "front view, close medium shot, waist-up, arms at sides", 24832),
    ("v033", "three-quarter front-right view, close medium shot, waist-up", 24833),
    ("v034", "front view, standing idle, arms at sides", 24834),
]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ── ComfyUI HTTP client (same pattern as gen_arm_a_idle_T0228.py) ────────────


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
    client_id = f"T-0248-identity-view-{uuid.uuid4().hex[:8]}"
    result = _http_post_json("/prompt", {"prompt": graph, "client_id": client_id})
    if "error" in result:
        raise RuntimeError(f"ComfyUI rejected the graph: {json.dumps(result['error'])}")
    return result["prompt_id"]


def wait_for_completion(prompt_id: str, timeout_s: int = 300, poll_s: int = 2) -> dict:
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


def build_graph(seed: int, anchor_filename: str, view_prompt: str) -> dict:
    """LoRA(style) + IP-Adapter(single fixed anchor panel) -> single 1024x1024
    render. No ControlNet -- pose/angle variety across candidates comes from
    the prompt text, which is exactly what this dataset needs."""
    g: dict = {}
    g["1"] = {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CHECKPOINT}}
    g["2"] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["1", 0],
            "clip": ["1", 1],
            "lora_name": LORA_NAME,
            "strength_model": LORA_WEIGHT,
            "strength_clip": LORA_WEIGHT,
        },
    }
    g["3"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": BASE_PROMPT.format(view=view_prompt), "clip": ["2", 1]},
    }
    g["4"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": NEGATIVE_PROMPT, "clip": ["2", 1]},
    }
    g["5"] = {"class_type": "LoadImage", "inputs": {"image": anchor_filename}}
    g["6"] = {
        "class_type": "IPAdapterUnifiedLoader",
        "inputs": {"model": ["2", 0], "preset": IPADAPTER_PRESET},
    }
    g["7"] = {
        "class_type": "IPAdapterAdvanced",
        "inputs": {
            "model": ["6", 0],
            "ipadapter": ["6", 1],
            "image": ["5", 0],
            "weight": IPADAPTER_WEIGHT,
            "weight_type": "linear",
            "combine_embeds": "concat",
            "start_at": 0.0,
            "end_at": 1.0,
            "embeds_scaling": "V only",
        },
    }
    g["8"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": GEN_PX, "height": GEN_PX, "batch_size": 1},
    }
    g["9"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["7", 0],
            "positive": ["3", 0],
            "negative": ["4", 0],
            "latent_image": ["8", 0],
            "seed": seed,
            "steps": 30,
            "cfg": 6.5,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
        },
    }
    g["10"] = {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["1", 2]}}
    g["11"] = {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "identity_view_T0248", "images": ["10", 0]},
    }
    return g


# ── Candidate driver ──────────────────────────────────────────────────────────

OUT_DIR = REPO_ROOT / "assets" / "out" / "identity_views_v2"


def generate_view(view_id: str, view_prompt: str, seed: int, anchor_filename: str) -> dict:
    graph = build_graph(seed=seed, anchor_filename=anchor_filename, view_prompt=view_prompt)
    t0 = time.monotonic()
    prompt_id = submit_prompt(graph)
    info = wait_for_completion(prompt_id)
    gpu_seconds = time.monotonic() - t0

    image_bytes = fetch_save_image(info, "11")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png_path = OUT_DIR / f"{view_id}.png"
    png_path.write_bytes(image_bytes)

    provenance = {
        "view_id": view_id,
        "view_prompt": view_prompt,
        "seed": seed,
        "prompt_id": prompt_id,
        "gpu_seconds": round(gpu_seconds, 1),
        "costume_id": COSTUME_ID,
        "trigger_token": TRIGGER_TOKEN,
        "model": CHECKPOINT,
        "model_hash": CHECKPOINT_HASH,
        "model_license": CHECKPOINT_LICENSE,
        "lora_name": LORA_NAME,
        "lora_weight": LORA_WEIGHT,
        "lora_license": LORA_LICENSE,
        "ip_adapter": IPADAPTER_NAME,
        "ip_adapter_preset": IPADAPTER_PRESET,
        "ip_adapter_weight": IPADAPTER_WEIGHT,
        "anchor_ref": "assets/src/character/identity_refs/ref_002.png",
        "concept_hash": EXPECTED_CONCEPT_HASH,
        "concept_card": "T-0209",
        "full_prompt": BASE_PROMPT.format(view=view_prompt),
        "negative_prompt": NEGATIVE_PROMPT,
        "steps": 30,
        "cfg": 6.5,
        "width": GEN_PX,
        "height": GEN_PX,
        "generator": "assets/src/character/gen_identity_views_T0248.py",
        "card": "T-0248",
    }
    (OUT_DIR / f"{view_id}.provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only", nargs="*", default=None, help="Generate only these view_ids (default: all)"
    )
    args = parser.parse_args()

    if CHECKPOINT_LICENSE not in CHECKPOINT_LICENSE_ALLOWLIST:
        print(f"ERROR: checkpoint license {CHECKPOINT_LICENSE!r} not on allowlist", file=sys.stderr)
        return 1

    concept_hash = sha256_of(CONCEPT_SHEET_PATH)
    if concept_hash != EXPECTED_CONCEPT_HASH:
        print(
            f"ERROR: concept sheet hash mismatch: got {concept_hash}, "
            f"expected {EXPECTED_CONCEPT_HASH}",
            file=sys.stderr,
        )
        return 1

    if not ANCHOR_REF_PATH.is_file():
        print(f"ERROR: anchor ref not found: {ANCHOR_REF_PATH}", file=sys.stderr)
        return 1

    anchor_filename = upload_image(ANCHOR_REF_PATH)

    views = VIEWS if not args.only else [v for v in VIEWS if v[0] in set(args.only)]
    for view_id, view_prompt, seed in views:
        out_png = OUT_DIR / f"{view_id}.png"
        if out_png.exists():
            print(f"skip {view_id} (already generated)")
            continue
        print(f"generating {view_id}: {view_prompt!r} (seed={seed})")
        provenance = generate_view(view_id, view_prompt, seed, anchor_filename)
        print(f"  -> {provenance['gpu_seconds']}s, prompt_id={provenance['prompt_id']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
