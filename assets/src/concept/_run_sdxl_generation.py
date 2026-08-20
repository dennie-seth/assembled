"""Standalone SDXL concept-sheet generator for T-0209.

Uses Python stdlib only (http.client, json, hashlib, time, pathlib).
Calls ComfyUI at COMFYUI_BASE_URL (default: http://172.18.192.1:8188).

Generates player_character_concept_sheet_v1.png via the txt2img+LoRA workflow
(CheckpointLoaderSimple -> LoraLoader -> CLIPTextEncode x2 -> EmptyLatentImage
-> KSampler -> VAEDecode -> SaveImage) using the parameters in the recipe JSON.

Run from the worktree root:
    python3 assets/src/concept/_run_sdxl_generation.py
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import time
import urllib.parse
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
WORKTREE     = Path(__file__).resolve().parents[3]
CONCEPT_DIR  = WORKTREE / "assets" / "src" / "concept"
RECIPE_PATH  = CONCEPT_DIR / "player_character_concept_sheet_v1.recipe.json"
OUT_PNG      = CONCEPT_DIR / "player_character_concept_sheet_v1.png"
OUT_PROV     = CONCEPT_DIR / "player_character_concept_sheet_v1.provenance.json"

# ── ComfyUI host ─────────────────────────────────────────────────────────────
BASE_URL     = os.environ.get("COMFYUI_BASE_URL", "http://172.18.192.1:8188").rstrip("/")

# ── License allowlist ─────────────────────────────────────────────────────────
# Mirrors gen_client_base.license_allowlist — only these checkpoints are allowed.
ALLOWED_CHECKPOINTS = {
    "sd_xl_base_1.0.safetensors",       # Stability AI SDXL — CreativeML OpenRAIL++-M
    "sd_xl_refiner_1.0.safetensors",
    "sdxl_vae.safetensors",
    "sd_xl_base_0.9.safetensors",
    "stabilityai--stable-diffusion-xl-base-1.0.safetensors",
}


def _assert_allowed(checkpoint: str) -> None:
    if checkpoint not in ALLOWED_CHECKPOINTS:
        raise RuntimeError(
            f"Checkpoint '{checkpoint}' is not on the license allowlist. "
            "Only Apache-2.0 / OpenRAIL / CC0-derived checkpoints are permitted. "
            "See .claude/rules/assets.md."
        )


# ── HTTP helpers ─────────────────────────────────────────────────────────────
def _parse_url(url: str):
    parsed = urllib.parse.urlparse(url)
    host   = parsed.hostname
    port   = parsed.port or (443 if parsed.scheme == "https" else 80)
    return host, port, parsed.path or "/"


def _get(path: str) -> bytes:
    host, port, _ = _parse_url(BASE_URL)
    conn = http.client.HTTPConnection(host, port, timeout=30)
    conn.request("GET", path)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    if resp.status != 200:
        raise RuntimeError(f"GET {path} -> {resp.status}: {body[:200]!r}")
    return body


def _post_json(path: str, payload: dict) -> dict:
    body    = json.dumps(payload).encode("utf-8")
    host, port, _ = _parse_url(BASE_URL)
    conn = http.client.HTTPConnection(host, port, timeout=30)
    conn.request("POST", path, body=body, headers={"Content-Type": "application/json"})
    resp    = conn.getresponse()
    data    = resp.read()
    conn.close()
    if resp.status not in (200, 201):
        raise RuntimeError(f"POST {path} -> {resp.status}: {data[:400]!r}")
    return json.loads(data)


# ── ComfyUI workflow builder ─────────────────────────────────────────────────
def build_workflow(recipe: dict) -> dict:
    """Build ComfyUI txt2img+LoRA graph from recipe dict.

    Node layout:
      4  CheckpointLoaderSimple
      12 LoraLoader  (model+clip from 4)
      5  EmptyLatentImage
      6  CLIPTextEncode positive  (clip from 12)
      7  CLIPTextEncode negative  (clip from 12)
      3  KSampler  (model from 12, latent from 5, pos/neg from 6/7)
      8  VAEDecode
      9  SaveImage
    """
    return {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": recipe["checkpoint"]},
        },
        "12": {
            "class_type": "LoraLoader",
            "inputs": {
                "model":          ["4", 0],
                "clip":           ["4", 1],
                "lora_name":      recipe["lora"],
                "strength_model": recipe["lora_weight"],
                "strength_clip":  recipe["lora_weight"],
            },
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "width":      recipe["width"],
                "height":     recipe["height"],
                "batch_size": 1,
            },
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": recipe["prompt"], "clip": ["12", 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": recipe["negative_prompt"], "clip": ["12", 1]},
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed":         recipe["seed"],
                "steps":        recipe["steps"],
                "cfg":          recipe["cfg"],
                "sampler_name": recipe["sampler"],
                "scheduler":    recipe["scheduler"],
                "denoise":      1.0,
                "model":        ["12", 0],
                "positive":     ["6", 0],
                "negative":     ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": recipe["name"],
                "images":          ["8", 0],
            },
        },
    }


def workflow_hash(graph: dict) -> str:
    canonical = json.dumps(graph, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ── Main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    recipe = json.loads(RECIPE_PATH.read_text())
    print(f"Recipe: {recipe['name']}  seed={recipe['seed']}")

    # License gate
    _assert_allowed(recipe["checkpoint"])
    print(f"Checkpoint allowed: {recipe['checkpoint']}")

    # Build workflow
    graph = build_workflow(recipe)
    wf_hash = workflow_hash(graph)
    print(f"Workflow hash: {wf_hash}")

    # Submit
    print(f"Submitting to {BASE_URL}/prompt …")
    resp = _post_json("/prompt", {"prompt": graph, "client_id": "T-0209-concept"})
    prompt_id = resp["prompt_id"]
    print(f"Queued: {prompt_id}")

    # Poll
    print("Polling …", end="", flush=True)
    deadline = time.time() + 600
    while time.time() < deadline:
        hist = json.loads(_get(f"/history/{prompt_id}"))
        if prompt_id in hist:
            entry = hist[prompt_id]
            if entry.get("status", {}).get("completed"):
                print(" done.")
                break
        print(".", end="", flush=True)
        time.sleep(3)
    else:
        raise TimeoutError(f"ComfyUI job {prompt_id} did not complete within 600s")

    # Find output image
    outputs = hist[prompt_id]["outputs"]
    images  = []
    for node_out in outputs.values():
        images.extend(node_out.get("images", []))
    if not images:
        raise RuntimeError(f"No images in job outputs: {json.dumps(outputs, indent=2)}")
    img_info = images[0]
    print(f"Output: {img_info}")

    # Fetch image bytes
    params   = urllib.parse.urlencode(
        {"filename": img_info["filename"], "type": img_info.get("type", "output")}
    )
    raw_bytes = _get(f"/view?{params}")
    print(f"Fetched {len(raw_bytes):,} bytes")

    # Verify it's a PNG
    if not raw_bytes.startswith(b"\x89PNG"):
        raise RuntimeError(f"Fetched file does not look like a PNG (first 8 bytes: {raw_bytes[:8]!r})")

    # Write PNG
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    OUT_PNG.write_bytes(raw_bytes)
    concept_hash = hashlib.sha256(raw_bytes).hexdigest()
    print(f"Wrote {OUT_PNG}  ({len(raw_bytes):,} bytes)")
    print(f"concept_hash: {concept_hash}")

    # Write provenance
    prov = {
        "model":          f"sd_xl_base_1.0.safetensors + LoRA {recipe['lora']} (weight {recipe['lora_weight']})",
        "model_license":  "CreativeML OpenRAIL++-M (SDXL base) / Apache-2.0 (LoRA — assembled project)",
        "model_hash":     None,
        "prompt":         recipe["prompt"],
        "negative_prompt": recipe["negative_prompt"],
        "seed":           recipe["seed"],
        "steps":          recipe["steps"],
        "cfg":            recipe["cfg"],
        "width":          recipe["width"],
        "height":         recipe["height"],
        "workflow_hash":  wf_hash,
        "prompt_id":      prompt_id,
        "concept_hash":   concept_hash,
        "comfyui_base_url": BASE_URL,
        "_lora_name":     recipe["lora"],
        "_lora_weight":   recipe["lora_weight"],
        "_sampler":       recipe["sampler"],
        "_scheduler":     recipe["scheduler"],
    }
    OUT_PROV.write_text(json.dumps(prov, indent=2))
    print(f"Wrote {OUT_PROV}")
    print("\nSDXL concept sheet generated successfully.")


if __name__ == "__main__":
    main()
