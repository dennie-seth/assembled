#!/usr/bin/env python3
"""Stdlib-only LoRA handshake generation — T-0167.

Uploads signal_tower_material_template.png to ComfyUI, submits the
LoRA-conditioned img2img workflow (node graph from comfyui_workflow_ready.json),
polls until complete, fetches the output, and writes:
  assets/src/concept/signal_tower_material_sheet_lora.png
  assets/src/concept/signal_tower_material_sheet_lora.provenance.json

Requires only Python stdlib + ComfyUI reachable at COMFYUI_BASE_URL.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import time
import urllib.parse
import urllib.request

REPO = pathlib.Path(__file__).parents[3]
WORKFLOW_PATH = REPO / "assets/src/lora_handshake/comfyui_workflow_ready.json"
TEMPLATE_PATH = REPO / "assets/src/concept/signal_tower_material_template.png"
BASE_CONCEPT_PATH = REPO / "assets/src/concept/signal_tower_material_sheet.png"
OUT_PNG = REPO / "assets/src/concept/signal_tower_material_sheet_lora.png"
OUT_PROVENANCE = REPO / "assets/src/concept/signal_tower_material_sheet_lora.provenance.json"

BASE_URL = os.environ.get("COMFYUI_BASE_URL", "http://172.18.192.1:8188").rstrip("/")
CLIENT_ID = f"t0167-handshake-{int(time.time())}"

SEED = 3101
LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_WEIGHT = 0.75
LORA_LICENSE = "CreativeML Open RAIL++-M"
CHECKPOINT = "sd_xl_base_1.0.safetensors"
MODEL_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
MODEL_LICENSE = "CreativeML Open RAIL++-M"
PROMPT = (
    "brutalist concrete wall texture, worn concrete floor surface, wall-to-floor trim, "
    "muted concrete grey and oxide and institutional green, flat side-on reference sheet, "
    "no perspective, value-separated material panels, interior, "
    "weathered surface detail, rough stained concrete"
)
NEGATIVE_PROMPT = (
    "equipment, control panel, machinery, switches, buttons, sky, perspective, "
    "three-quarter view, isometric, vanishing point, text, watermark, glow, blurry, "
    "low quality, character, creature, smooth, flat colour, solid colour"
)


def upload_image(image_bytes: bytes, filename: str) -> str:
    """Upload image to ComfyUI /upload/image. Returns the stored name."""
    boundary = "----T0167Boundary"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode() + image_bytes + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{BASE_URL}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["name"]


def submit_workflow(workflow: dict, uploaded_image_name: str) -> str:
    """Patch workflow with uploaded image, submit to ComfyUI. Returns prompt_id."""
    # Strip the _note key — ComfyUI doesn't know that node type
    graph = {k: v for k, v in workflow.items() if not k.startswith("_")}

    # Patch LoadImage node ("10") to use the uploaded name
    graph["10"]["inputs"]["image"] = uploaded_image_name

    payload = json.dumps({"prompt": graph, "client_id": CLIENT_ID}).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["prompt_id"]


def poll_until_done(prompt_id: str, timeout: float = 600.0, interval: float = 3.0) -> dict:
    """Poll /history/{prompt_id} until complete. Returns the history entry."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(interval)
        url = f"{BASE_URL}/history/{urllib.parse.quote(prompt_id)}"
        with urllib.request.urlopen(url, timeout=15) as resp:
            history = json.loads(resp.read())
        entry = history.get(prompt_id)
        if entry and entry.get("status", {}).get("completed"):
            return entry
        if entry and entry.get("status", {}).get("status_str") == "error":
            raise RuntimeError(f"ComfyUI reported error for {prompt_id}: {entry['status']}")
        elapsed = int(time.time() - (deadline - timeout))
        if elapsed % 30 < interval:
            print(f"  ...waiting ({elapsed}s elapsed)...")
    raise TimeoutError(f"Timed out after {timeout}s waiting for {prompt_id}")


def fetch_output_image(entry: dict) -> tuple[bytes, str, str]:
    """Fetch the first output image from a completed history entry.
    Returns (image_bytes, filename, subfolder).
    """
    for node_id, node_out in entry.get("outputs", {}).items():
        images = node_out.get("images", [])
        if images:
            img = images[0]
            fname = img["filename"]
            subfolder = img.get("subfolder", "")
            img_type = img.get("type", "output")
            url = (
                f"{BASE_URL}/view"
                f"?filename={urllib.parse.quote(fname)}"
                f"&subfolder={urllib.parse.quote(subfolder)}"
                f"&type={urllib.parse.quote(img_type)}"
            )
            with urllib.request.urlopen(url, timeout=60) as resp:
                return resp.read(), fname, subfolder
    raise RuntimeError("No output images found in history entry")


def write_provenance(
    prompt_id: str,
    concept_hash: str,
    conditioning_hash: str,
    base_concept_hash: str,
    workflow_hash: str,
) -> None:
    record = {
        "model": CHECKPOINT,
        "model_license": MODEL_LICENSE,
        "model_hash": MODEL_HASH,
        "prompt": PROMPT,
        "negative_prompt": NEGATIVE_PROMPT,
        "seed": SEED,
        "steps": 30,
        "cfg": 7.0,
        "width": 1024,
        "height": 1024,
        "workflow_hash": workflow_hash,
        "prompt_id": prompt_id,
        "concept_hash": conditioning_hash,
        "denoise": 0.9,
        "conditioning_source": str(TEMPLATE_PATH),
        "lora_name": LORA_NAME,
        "lora_weight": LORA_WEIGHT,
        "lora_license": LORA_LICENSE,
        "base_concept_hash": base_concept_hash,
        "output_sha256": concept_hash,
    }
    OUT_PROVENANCE.write_text(json.dumps(record, indent=2))
    print(f"Provenance written: {OUT_PROVENANCE}")


def main() -> int:
    print("=== T-0167 LoRA Handshake Generation ===")
    print(f"ComfyUI URL: {BASE_URL}")
    print(f"Template:    {TEMPLATE_PATH}")
    print(f"LoRA:        {LORA_NAME} (weight={LORA_WEIGHT})")
    print(f"Seed:        {SEED}")
    print()

    # Verify prerequisites
    for p in [WORKFLOW_PATH, TEMPLATE_PATH, BASE_CONCEPT_PATH]:
        if not p.exists():
            print(f"ERROR: missing {p}")
            return 1

    # Compute hashes before generation
    template_bytes = TEMPLATE_PATH.read_bytes()
    conditioning_hash = hashlib.sha256(template_bytes).hexdigest()
    base_concept_hash = hashlib.sha256(BASE_CONCEPT_PATH.read_bytes()).hexdigest()
    workflow_raw = WORKFLOW_PATH.read_text()
    workflow_hash = hashlib.sha256(workflow_raw.encode()).hexdigest()[:16]
    workflow = json.loads(workflow_raw)
    print(f"Conditioning template sha256: {conditioning_hash[:16]}...")
    print(f"Base concept sha256:          {base_concept_hash[:16]}...")

    # 1. Upload template image
    print("Uploading template image to ComfyUI...")
    uploaded_name = upload_image(template_bytes, TEMPLATE_PATH.name)
    print(f"Uploaded as: {uploaded_name}")

    # 2. Submit workflow
    print("Submitting LoRA img2img workflow...")
    prompt_id = submit_workflow(workflow, uploaded_name)
    print(f"Queued. prompt_id: {prompt_id}")

    # 3. Poll until done
    print("Waiting for generation (SDXL 1024x1024 @ 30 steps with LoRA ~60-120s)...")
    entry = poll_until_done(prompt_id, timeout=600.0)
    print("Generation complete!")

    # 4. Fetch output
    print("Fetching output image...")
    raw_bytes, fname, subfolder = fetch_output_image(entry)
    concept_hash = hashlib.sha256(raw_bytes).hexdigest()
    print(f"Output size:  {len(raw_bytes)} bytes")
    print(f"Output sha256: {concept_hash[:16]}...")

    # Verify not identical to the original (sanity check)
    if base_concept_hash == concept_hash:
        print("WARNING: output is byte-identical to the base concept sheet!")
        print("The LoRA may not have been applied correctly.")

    # 5. Write output
    OUT_PNG.write_bytes(raw_bytes)
    print(f"Saved: {OUT_PNG}")

    # 6. Write provenance
    write_provenance(
        prompt_id=prompt_id,
        concept_hash=concept_hash,
        conditioning_hash=conditioning_hash,
        base_concept_hash=base_concept_hash,
        workflow_hash=workflow_hash,
    )

    print()
    print("=== Generation complete ===")
    print(f"prompt_id:         {prompt_id}")
    print(f"output sha256:     {concept_hash}")
    print(f"base sha256:       {base_concept_hash}")
    identical = concept_hash == base_concept_hash
    print(f"Identical to base: {identical}")
    print()
    print("Next: visually compare the two images, then update ASSET_PROVENANCE.md and DL-15.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
