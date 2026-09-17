"""Enemy redesign concept art -- T-0275 (docs/design/13-asset-pipeline.md §6.9).

Generates three concept sheets realizing @DennieSeth's decided designs for
the GDD's three sensor-role enemies, replacing the abstract orb/field/presence
forms of the superseded art:

  - watcher   (sight cone)    -> humanoid with an OWL HEAD (acute vision)
  - sound     (sound radius)  -> a ROBOT, non-human, no face (hunts by sound alone)
  - still_air (proximity)     -> an EYELESS SPIDER (senses by proximity/vibration)

This card is DESIGN + CONCEPT ART ONLY: pure SDXL txt2img + the locked
`soviet_brutalism_style_v1` style LoRA, no img2img conditioning, no
ControlNet, no descent/quantization -- concept sheets are full-colour,
full-res pipeline *sources* (comfy_client.concept's module docstring),
committed to assets/src/concept/, not assets/final/.

Supersedes:
  - v1 (T-0200) -- synthetic (model "N/A -- procedurally generated",
    model_hash None), drawn by tests/conftest.py's _ensure_entity_sheets.
  - v2 (T-0214) -- real SDXL, but of the abstract orb/field/presence forms
    this redesign replaces.

Requires:
  - ComfyUI reachable at http://172.18.192.1:8188
  - sd_xl_base_1.0.safetensors + soviet_brutalism_style_v1.safetensors

Usage:
    cd /path/to/repo
    python3 assets/src/character/gen_enemy_concept_T0275.py
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CONCEPT_OUT = REPO_ROOT / "assets" / "src" / "concept"

COMFYUI_URL = "http://172.18.192.1:8188"
CHECKPOINT = "sd_xl_base_1.0.safetensors"
CHECKPOINT_LICENSE = "CreativeML Open RAIL++-M"
LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_WEIGHT = 0.70
LORA_LICENSE = "CreativeML OpenRAIL++-M"
# Known hashes -- same checkpoint/LoRA pair as T-0210/T-0214 (see their
# provenance sidecars in assets/src/concept/ and assets/final/entity/).
MODEL_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
LORA_HASH = "2dab82287f6d36a98a142dae5199df47e001d86d4c9507a0524742b4d34f2b9f"

WIDTH = 1024
HEIGHT = 1024
STEPS = 30
CFG = 7.0
SAMPLER = "euler"
SCHEDULER = "normal"

# Repo-relative path to this module, written to every sidecar's `generator`
# field so the P-7 resolvability gate can verify each sheet is regenerable
# from a bare repo path (same convention as comfy_client.concept.GENERATOR_ID
# and assets/src/character/gen_entities_v2.py).
GENERATOR_ID = "assets/src/character/gen_enemy_concept_T0275.py"

# ComfyUI graph node ids (shared across all three enemies).
CHECKPOINT_NODE_ID = "4"
LORA_NODE_ID = "12"
LATENT_NODE_ID = "5"
POSITIVE_PROMPT_NODE_ID = "6"
NEGATIVE_PROMPT_NODE_ID = "7"
SAMPLER_NODE_ID = "3"
VAE_DECODE_NODE_ID = "8"
SAVE_IMAGE_NODE_ID = "9"

_STEALTH_OBSTACLE = (
    "hands empty, unarmed, standing in a neutral relaxed posture, "
    "a passive stealth obstacle to route around, not a combatant"
)
_STEALTH_NEGATIVE = (
    "weapon, gun, sword, blade, knife, rifle, armor, armour, "
    "aggressive combat pose, battle stance, fighting stance"
)
_SHEET_FRAMING = (
    "flat side-on concept sheet, orthographic full-body elevation, no perspective, "
    "no vanishing point, single figure centred on a plain background, "
    "Soviet brutalist institutional aesthetic, muted desaturated home palette, "
    "hard value separation, dark darks and light lights, flat even lighting, "
    "no atmospheric haze, no depth of field, no scene composition, "
    "pixel art game asset reference sheet style, silhouette study"
)
_SHEET_NEGATIVE = (
    "perspective, vanishing point, three-quarter view, isometric, receding walls, "
    "atmospheric haze, depth of field, sky, clouds, foliage, scene, composed illustration, "
    "photorealistic, 3d render, soft gradient lighting, painterly, bright saturated colors, "
    "cartoon, cheerful, text, watermark, signature, blurry, low quality, multiple figures"
)

ENEMY_SPECS: dict[str, dict] = {
    "watcher": {
        "sensor_role": "sight cone",
        "seed": 27501,
        "prompt": (
            f"{_SHEET_FRAMING}. A humanoid figure with an owl head: large forward-facing "
            "owl eyes, a pronounced owl facial disc, and feathered head plumage on an "
            "otherwise ordinary upright humanoid body wearing a plain utilitarian "
            f"institutional coverall, {_STEALTH_OBSTACLE}. Concrete grey and institutional "
            "green muted colour palette. The head is unmistakably an owl's, dominated by "
            "eyes, telegraphing acute vision at a glance."
        ),
        "negative_prompt": (
            f"{_SHEET_NEGATIVE}, {_STEALTH_NEGATIVE}, human face without owl features, "
            "small or hidden eyes, animal body, non-humanoid body, robot, mechanical parts, "
            "multiple eyes clusters, insect features"
        ),
    },
    "sound": {
        "sensor_role": "sound radius",
        "seed": 27502,
        "prompt": (
            f"{_SHEET_FRAMING}. A non-human robot construction: boxy industrial chassis, "
            "no face and no eyes, an array of microphone dish and antenna sensors mounted "
            "where a head would be, exposed conduit and rivets, rusted institutional green "
            f"and concrete grey plating, {_STEALTH_OBSTACLE}. It hunts by sound alone and "
            "has nothing resembling a face to read."
        ),
        "negative_prompt": (
            f"{_SHEET_NEGATIVE}, {_STEALTH_NEGATIVE}, face, eyes, humanoid head, human "
            "features, readable facial expression, organic skin, fur, feathers"
        ),
    },
    "still_air": {
        "sensor_role": "proximity / patrol",
        "seed": 27510,
        "prompt": (
            "a single giant spider creature, arachnid monster concept art, eight long "
            "segmented legs, a smooth rounded blank head with absolutely no eyes and no "
            "eye clusters anywhere on its body, long thin sensory pedipalps built for "
            f"sensing vibration and proximity, a low wide crouching stance. {_SHEET_FRAMING}. "
            "Dark utilitarian concrete grey and near-black chitinous exoskeleton, "
            f"{_STEALTH_OBSTACLE}. It is completely eyeless -- it never spots you, you are "
            "simply within reach when it arrives."
        ),
        "negative_prompt": (
            f"{_SHEET_NEGATIVE}, {_STEALTH_NEGATIVE}, eyes, eye cluster, pupils, glowing "
            "eyes, face, fangs bared aggressively, venom drip, humanoid body, robot, "
            "vehicle, truck, bus, van, car, trailer, blueprint, technical drawing, "
            "engineering schematic, wheels"
        ),
    },
}


def build_graph(spec: dict) -> dict:
    """Pure txt2img + style-LoRA ComfyUI graph -- no img2img, no ControlNet."""
    return {
        CHECKPOINT_NODE_ID: {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": CHECKPOINT},
        },
        LORA_NODE_ID: {
            "class_type": "LoraLoader",
            "inputs": {
                "model": [CHECKPOINT_NODE_ID, 0],
                "clip": [CHECKPOINT_NODE_ID, 1],
                "lora_name": LORA_NAME,
                "strength_model": LORA_WEIGHT,
                "strength_clip": LORA_WEIGHT,
            },
        },
        LATENT_NODE_ID: {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": WIDTH, "height": HEIGHT, "batch_size": 1},
        },
        POSITIVE_PROMPT_NODE_ID: {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": spec["prompt"], "clip": [LORA_NODE_ID, 1]},
        },
        NEGATIVE_PROMPT_NODE_ID: {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": spec["negative_prompt"], "clip": [LORA_NODE_ID, 1]},
        },
        SAMPLER_NODE_ID: {
            "class_type": "KSampler",
            "inputs": {
                "seed": spec["seed"],
                "steps": STEPS,
                "cfg": CFG,
                "sampler_name": SAMPLER,
                "scheduler": SCHEDULER,
                "denoise": 1.0,
                "model": [LORA_NODE_ID, 0],
                "positive": [POSITIVE_PROMPT_NODE_ID, 0],
                "negative": [NEGATIVE_PROMPT_NODE_ID, 0],
                "latent_image": [LATENT_NODE_ID, 0],
            },
        },
        VAE_DECODE_NODE_ID: {
            "class_type": "VAEDecode",
            "inputs": {"samples": [SAMPLER_NODE_ID, 0], "vae": [CHECKPOINT_NODE_ID, 2]},
        },
        SAVE_IMAGE_NODE_ID: {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": "T-0275", "images": [VAE_DECODE_NODE_ID, 0]},
        },
    }


def workflow_hash(graph: dict) -> str:
    canonical = json.dumps(graph, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_provenance(
    spec: dict,
    model_hash: str,
    workflow_hash_value: str,
    prompt_id: str,
    concept_hash_value: str,
) -> dict:
    return {
        "model": f"{CHECKPOINT} + LoRA {LORA_NAME} (weight {LORA_WEIGHT})",
        "model_license": f"{CHECKPOINT_LICENSE} (base) / {LORA_LICENSE} (LoRA)",
        "model_hash": model_hash,
        "lora_name": LORA_NAME,
        "lora_weight": LORA_WEIGHT,
        "lora_license": LORA_LICENSE,
        "lora_hash": LORA_HASH,
        "prompt": spec["prompt"],
        "negative_prompt": spec["negative_prompt"],
        "seed": spec["seed"],
        "steps": STEPS,
        "cfg": CFG,
        "sampler": SAMPLER,
        "scheduler": SCHEDULER,
        "width": WIDTH,
        "height": HEIGHT,
        "workflow_hash": workflow_hash_value,
        "prompt_id": prompt_id,
        "concept_hash": concept_hash_value,
        "generator": GENERATOR_ID,
        "card": "T-0275",
        "sensor_role": spec["sensor_role"],
        "supersedes": [
            "T-0200 (v1, synthetic -- model N/A, model_hash None)",
            "T-0214 (v2, real SDXL abstract orb/field/presence forms)",
        ],
    }


def build_recipe(name: str, spec: dict) -> dict:
    return {
        "name": name,
        "checkpoint": CHECKPOINT,
        "lora": LORA_NAME,
        "lora_weight": LORA_WEIGHT,
        "prompt": spec["prompt"],
        "negative_prompt": spec["negative_prompt"],
        "seed": spec["seed"],
        "steps": STEPS,
        "cfg": CFG,
        "sampler": SAMPLER,
        "scheduler": SCHEDULER,
        "width": WIDTH,
        "height": HEIGHT,
        "generator": GENERATOR_ID,
    }


# ---------------------------------------------------------------------------
# ComfyUI HTTP API (stdlib urllib only -- same convention as gen_entities_v2.py)
# ---------------------------------------------------------------------------

CLIENT_ID = f"T-0275-enemy-concept-{uuid.uuid4().hex[:8]}"


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


def generate_enemy_concept(name: str, spec: dict) -> None:
    sheet_name = f"{name}_concept_sheet_v1"
    out_png = CONCEPT_OUT / f"{sheet_name}.png"
    out_prov = CONCEPT_OUT / f"{sheet_name}.provenance.json"
    out_recipe = CONCEPT_OUT / f"{sheet_name}.recipe.json"

    print(f"\n=== Generating {sheet_name} (sensor role: {spec['sensor_role']}) ===")

    graph = build_graph(spec)
    graph_hash = workflow_hash(graph)
    payload = {"prompt": graph, "client_id": CLIENT_ID}
    print(f"  Submitting to ComfyUI (seed={spec['seed']})...")
    result = _comfyui_post_json("/prompt", payload)
    prompt_id = result["prompt_id"]
    print(f"  prompt_id: {prompt_id}")

    job_result = _poll_until_done(prompt_id)
    print("  Generation complete.")

    raw_bytes = _comfyui_fetch_output(job_result)
    print(f"  Fetched output: {len(raw_bytes)} bytes")

    CONCEPT_OUT.mkdir(parents=True, exist_ok=True)
    out_png.write_bytes(raw_bytes)
    concept_hash_value = hashlib.sha256(raw_bytes).hexdigest()

    provenance = build_provenance(
        spec,
        model_hash=MODEL_HASH,
        workflow_hash_value=graph_hash,
        prompt_id=prompt_id,
        concept_hash_value=concept_hash_value,
    )
    out_prov.write_text(json.dumps(provenance, indent=2))
    out_recipe.write_text(json.dumps(build_recipe(sheet_name, spec), indent=2))

    print(f"  Saved: {out_png}")
    print(f"  Saved: {out_prov}")
    print(f"  concept_hash: {concept_hash_value}")


def main() -> None:
    print("T-0275 Enemy Redesign Concept Art Generation")
    print(f"ComfyUI: {COMFYUI_URL}")

    try:
        sys_stats = _comfyui_get_json("/system_stats")
        comfyui_ver = sys_stats["system"]["comfyui_version"]
        print(f"ComfyUI version: {comfyui_ver} (reachable)")
    except (urllib.error.URLError, OSError, KeyError) as exc:
        print(f"ERROR: ComfyUI not reachable at {COMFYUI_URL}: {exc}")
        raise SystemExit(1) from exc

    CONCEPT_OUT.mkdir(parents=True, exist_ok=True)

    for name, spec in ENEMY_SPECS.items():
        generate_enemy_concept(name, spec)

    print("\nAll 3 enemy concept sheets generated.")
    print("Next: attach to card T-0275 via the attachments API, run the")
    print("asset-provenance skill, and commit.")


if __name__ == "__main__":
    main()
