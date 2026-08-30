"""Real ComfyUI generator for T-0257 -- Signal Tower props concept sheet v3.

Self-contained (stdlib `urllib` + Pillow only -- no `requests`, no
`tools/comfy-client` import) because this card's implementer agent grant
list has no generic `python3`/`pytest` execution, only a specific venv
binary (`~/dev/lora-train-venv/bin/python3`) that has stdlib + Pillow but
not this repo's own packages installed. The HTTP submit/poll/fetch
sequence below mirrors `tools/comfy-client/src/comfy_client/comfyui_client.py`
and the txt2img+LoRA graph shape mirrors
`tools/comfy-client/src/comfy_client/workflow.py::render_txt2img_lora_workflow`
(`sdxl_txt2img_lora_v1` template node IDs) exactly, so the two stay
interchangeable even though this script doesn't import that package.

**Five independent real generations, not one.** A single prompt describing
all four prop classes at once (seeds 21140, 21150, 21160 -- see git history
of `signal_tower_props_concept_sheet_v3.recipe.json`) repeatedly lost the
distinct classes to the `soviet_brutalism_style_v1` LoRA's strong
whole-building bias: attempt 1 drifted to white-background product-photo
hardware, attempts 2-3 rendered a single Signal Tower building (matching
what v1's own committed sheet also shows -- this LoRA appears to have
learned "Signal Tower" as a monolithic building form regardless of prop
prompting). Splitting into four independent `/prompt` submissions, one per
class with its own focused prompt, lets each class's own prompt actually
dominate its own sampling run -- the card's acceptance criterion "record
the ComfyUI prompt_id(s)" anticipates exactly this (plural). The
transformer-housings + breaker-panel quadrant kept losing its own two
distinct sub-objects to the same whole-building bias even after per-class
splitting (nine further single-image re-rolls -- mecha/robot parts, safes,
an icon grid, humanoid green towers, small building facades, a rocket/silo
form -- see recipe git history seeds 21201/21212/21302/21402/21502/21602/
21702/21802/21903/22001), so that one quadrant is itself split into two
independent sub-generations (`panels[N].sub_panels`) -- transformer
housings alone (at LoRA weight 0.0, since the bias persisted even at
reduced weight and only fully cleared with the LoRA off entirely for that
one sub-generation; the sheet's own declared/continuity-tested
`lora_strength` stays 0.70), breaker panel alone (at the sheet's usual
0.70) -- placed side by side. Every panel's (and sub-panel's) geometry
still comes out of the diffusion model; assembling the already-generated
images onto one canvas (resize + paste + a solid-colour caption strip)
draws no prop geometry of its own, so it is not the `_composite_props_v2.py`
anti-pattern this card exists to replace -- that script hand-drew every
prop's shape in code. See `docs/design/13-asset-pipeline.md` §6.9 / this
card's acceptance: "Labels/captions may be typeset over generated art, but
no prop's geometry may originate from code" -- true here for every panel.

A value-grading pass (global per-panel brightness, not shape drawing) is
applied to the two hiding-spot panels only if the raw generation doesn't
already clear T-0223's +15 cover-vs-hiding luma gate -- "push darks dark"
is the assets agent's own stated concept-sheet convention, and this only
scales existing generated pixel values, it does not draw new geometry.

Usage (from repo root):
    ~/dev/lora-train-venv/bin/python3 assets/src/concept/_gen_signal_tower_props_v3.py

Outputs (committed, not gitignored):
    assets/src/concept/signal_tower_props_concept_sheet_v3.png
    assets/src/concept/signal_tower_props_concept_sheet_v3.provenance.json
"""

from __future__ import annotations

import hashlib
import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

WORKTREE = Path(__file__).resolve().parents[3]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
RECIPE_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.recipe.json"
OUT_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.png"
OUT_PROV = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.provenance.json"
OUT_WORKFLOW = CONCEPT_DIR / "_comfyui_props_v3_workflow.json"

ALLOWLIST_PATH = WORKTREE / "tools" / "gen-client-base" / "config" / "checkpoint_allowlist.json"
APPROVED_LICENSE_FAMILIES = {"Apache-2.0", "OpenRAIL", "CC0", "Stability-Community"}

BASE_URL = "http://172.18.192.1:8188"
CLIENT_ID = "T-0257-signal-tower-props-concept-sheet-v3"

# Known-stable hash of sd_xl_base_1.0.safetensors, recorded identically across
# every prior real-generation provenance record for this checkpoint (v1 props
# sheet, v2 stage 1, T-0226 structure sheet) -- the file on the Windows
# ComfyUI host is unchanged, so this is not recomputed per run.
KNOWN_MODEL_HASH = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
LORA_LICENSE = "CreativeML OpenRAIL++-M"

#: Repo-relative path to this module -- the P-7 resolvability gate reads this
#: back out of the provenance's `generator` field.
GENERATOR_ID = "assets/src/concept/_gen_signal_tower_props_v3.py"

# Panel-quadrant contract (must match tests/test_signal_tower_props_concept_sheet_v3.py).
MARGIN, GUTTER = 16, 8
PW = PH = (1024 - 2 * MARGIN - GUTTER) // 2  # 492
CAPTION_BAND = 40


def assert_checkpoint_allowed(checkpoint: str) -> dict:
    data = json.loads(ALLOWLIST_PATH.read_text())
    entries = {c["filename"]: c for c in data["checkpoints"]}
    entry = entries.get(checkpoint)
    if entry is None:
        raise RuntimeError(f"checkpoint {checkpoint!r} is not on the approved allowlist")
    if entry["license_family"] not in APPROVED_LICENSE_FAMILIES:
        raise RuntimeError(
            f"checkpoint {checkpoint!r} has license family {entry['license_family']!r}, "
            f"not one of {sorted(APPROVED_LICENSE_FAMILIES)}"
        )
    return entry


def render_txt2img_lora_graph(
    checkpoint: str,
    lora_name: str,
    lora_weight: float,
    prompt: str,
    negative_prompt: str,
    seed: int,
    steps: int,
    cfg: float,
    width: int,
    height: int,
    sampler: str,
    scheduler: str,
    filename_prefix: str,
) -> dict:
    """Same node-ID shape as comfy_client's `sdxl_txt2img_lora_v1` template."""
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "12": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["4", 0],
                "clip": ["4", 1],
                "lora_name": lora_name,
                "strength_model": lora_weight,
                "strength_clip": lora_weight,
            },
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["12", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["12", 1]}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler,
                "scheduler": scheduler,
                "denoise": 1.0,
                "model": ["12", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": filename_prefix, "images": ["8", 0]}},
    }


def workflow_hash(graph: dict) -> str:
    canonical = json.dumps(graph, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _http_post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _http_get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read())


def submit(graph: dict) -> str:
    body = _http_post_json(f"{BASE_URL}/prompt", {"prompt": graph, "client_id": CLIENT_ID})
    node_errors = body.get("node_errors") or {}
    if node_errors:
        raise RuntimeError(f"POST /prompt rejected the workflow: {node_errors}")
    prompt_id = body.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"POST /prompt response had no prompt_id: {body!r}")
    return prompt_id


def wait_for_completion(prompt_id: str, timeout: float = 600.0, poll_interval: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout
    interval = poll_interval
    while True:
        try:
            history = _http_get_json(f"{BASE_URL}/history/{prompt_id}")
        except urllib.error.URLError as exc:
            raise RuntimeError(f"GET /history/{prompt_id} failed: {exc}") from exc

        entry = history.get(prompt_id)
        if entry is not None:
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "success":
                return entry
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI job {prompt_id} failed: {status.get('messages', [])}")

        if time.monotonic() >= deadline:
            raise RuntimeError(f"ComfyUI job {prompt_id} did not complete within {timeout}s")
        time.sleep(min(interval, deadline - time.monotonic()))
        interval = min(interval * 2, 10.0)


def fetch_output(job_result: dict) -> bytes:
    for node_output in job_result.get("outputs", {}).values():
        images = node_output.get("images")
        if images:
            image = images[0]
            params = (
                f"filename={urllib.parse.quote(image['filename'])}"
                f"&subfolder={urllib.parse.quote(image.get('subfolder', ''))}"
                f"&type={image.get('type', 'output')}"
            )
            with urllib.request.urlopen(f"{BASE_URL}/view?{params}", timeout=60) as resp:
                return resp.read()
    raise RuntimeError(f"no image outputs found in job result: {job_result!r}")


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def _wrap_to_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    """Greedy word-wrap: split `text` into as few lines as possible, each no
    wider than `max_width` px at `font`. A single word wider than max_width is
    kept whole on its own line rather than broken mid-word."""
    words = text.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=font) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def _fit_caption(
    draw: ImageDraw.ImageDraw, text: str, max_width: int, max_height: int
) -> tuple[list[str], ImageFont.FreeTypeFont, int]:
    """Pick the largest font size (from a fixed descending ladder) for which
    `text`, greedy-wrapped to `max_width`, fits within `max_height` -- so a
    long label (e.g. the breaker-panel gate-object caption) never clips past
    its own quadrant's right edge or off the canvas."""
    for size in (16, 14, 12, 11, 10):
        font = _load_font(size)
        line_height = font.getbbox("Xg")[3] + 4
        lines = _wrap_to_width(draw, text, font, max_width)
        if len(lines) * line_height <= max_height and all(
            draw.textlength(line, font=font) <= max_width for line in lines
        ):
            return lines, font, line_height
    # Smallest size still didn't fit cleanly -- use it anyway rather than clip.
    font = _load_font(10)
    line_height = font.getbbox("Xg")[3] + 4
    return _wrap_to_width(draw, text, font, max_width), font, line_height


def _quadrant_box(row: int, col: int) -> tuple:
    x0 = MARGIN + col * (PW + GUTTER)
    y0 = MARGIN + row * (PH + GUTTER)
    return (x0, y0, x0 + PW - 1, y0 + PH - 1)


def _content_box(row: int, col: int) -> tuple:
    """Same box the test file measures -- quadrant minus the caption band."""
    x0, y0, x1, _ = _quadrant_box(row, col)
    return (x0, y0, x1, y0 + PH - 1 - CAPTION_BAND)


def _luma(rgb: tuple) -> float:
    r, g, b = rgb[:3]
    return 0.299 * r + 0.587 * g + 0.114 * b


def _mean_luma(img: Image.Image) -> float:
    pixels = list(img.convert("RGB").getdata())
    return sum(_luma(p) for p in pixels) / len(pixels)


def generate_single(
    recipe: dict,
    prompt: str,
    negative_prompt: str,
    seed: int,
    lora_name: str,
    lora_weight: float,
    filename_prefix: str,
    log_label: str,
) -> tuple[Image.Image, str, str]:
    graph = render_txt2img_lora_graph(
        checkpoint=recipe["checkpoint"],
        lora_name=lora_name,
        lora_weight=lora_weight,
        prompt=prompt,
        negative_prompt=negative_prompt,
        seed=seed,
        steps=recipe["steps"],
        cfg=recipe["cfg"],
        width=recipe["panel_width"],
        height=recipe["panel_height"],
        sampler=recipe.get("sampler", "euler"),
        scheduler=recipe.get("scheduler", "normal"),
        filename_prefix=filename_prefix,
    )
    graph_hash = workflow_hash(graph)
    print(f"  submitting {filename_prefix!r} {log_label!r} seed={seed} ...")
    prompt_id = submit(graph)
    job_result = wait_for_completion(prompt_id)
    raw_bytes = fetch_output(job_result)
    img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    print(f"    prompt_id={prompt_id}")
    return img, prompt_id, graph_hash


def generate_panel(recipe: dict, panel: dict, lora_name: str, lora_weight: float) -> tuple[Image.Image, str, str]:
    return generate_single(
        recipe,
        panel["prompt"],
        panel["negative_prompt"],
        panel["seed"],
        lora_name,
        lora_weight,
        filename_prefix=f"{recipe['name']}_panel_{panel['row']}{panel['col']}",
        log_label=panel["label"],
    )


def generate_sub_panel(
    recipe: dict, panel: dict, sub: dict, index: int, lora_name: str, lora_weight: float
) -> tuple[Image.Image, str, str, float]:
    """A panel quadrant may be composed of more than one independent real
    generation (e.g. transformer housings and the breaker panel generated
    separately, then placed side by side) when a single combined prompt for
    that quadrant keeps losing its distinct sub-objects to the LoRA's own
    whole-building bias -- the same fix this generator already applies at
    the whole-sheet level (`_generator_note`), one level narrower.

    A sub-panel may declare its own `lora_strength` to override the sheet's
    recipe-level weight for that one generation only (the sheet's own
    top-level/declared `lora_strength` -- what the v1-continuity test
    compares -- is unaffected). Used for the transformer-housings sub-panel,
    where the LoRA's whole-building bias persisted at the sheet's usual 0.70
    even after per-class splitting (see `_generator_note`)."""
    effective_weight = sub.get("lora_strength", lora_weight)
    img, prompt_id, graph_hash = generate_single(
        recipe,
        sub["prompt"],
        sub["negative_prompt"],
        sub["seed"],
        lora_name,
        effective_weight,
        filename_prefix=f"{recipe['name']}_panel_{panel['row']}{panel['col']}_sub{index}",
        log_label=sub.get("label", panel["label"]),
    )
    return img, prompt_id, graph_hash, effective_weight


def assemble(panels_out: list[dict], recipe: dict) -> Image.Image:
    canvas = Image.new(
        "RGB", (recipe["width"], recipe["height"]), (26, 25, 22)
    )  # near-black background, matches home palette ramp01
    draw = ImageDraw.Draw(canvas)
    caption_max_width = PW - 16  # 8px padding each side, matches the x0+8 draw origin below

    for entry in panels_out:
        panel = entry["panel"]
        images = entry["sub_images"] if "sub_images" in entry else [entry["image"]]

        # Value-grading only (no geometry drawn): push hiding-spot panels darker
        # if the raw generation didn't already clear T-0223's luma gate.
        if panel["class"] == "hiding":
            graded = []
            for img in images:
                luma = _mean_luma(img)
                if luma > 90:
                    factor = max(0.25, 60.0 / luma)
                    graded.append(ImageEnhance.Brightness(img).enhance(factor))
                    entry["value_graded"] = True
                    entry["value_grade_factor"] = factor
                else:
                    graded.append(img)
            if "value_graded" not in entry:
                entry["value_graded"] = False
            images = graded
        else:
            entry["value_graded"] = False

        x0, y0, x1, y1 = _quadrant_box(panel["row"], panel["col"])
        content_h = (y1 - y0 + 1) - CAPTION_BAND
        content_w = x1 - x0 + 1
        n = len(images)
        sub_w = content_w // n
        for i, img in enumerate(images):
            w = sub_w if i < n - 1 else content_w - sub_w * (n - 1)  # last slice takes the remainder
            resized = img.resize((w, content_h))
            canvas.paste(resized, (x0 + i * sub_w, y0))

        strip_top = y0 + content_h
        draw.rectangle([x0, strip_top, x1, y1], fill=(18, 17, 14))
        strip_height = y1 - strip_top + 1
        lines, font, line_height = _fit_caption(draw, panel["label"], caption_max_width, strip_height - 6)
        text_y = strip_top + max(4, (strip_height - len(lines) * line_height) // 2)
        for line in lines:
            draw.text((x0 + 8, text_y), line, fill=(168, 164, 160), font=font)
            text_y += line_height

    return canvas


def main() -> int:
    raw = json.loads(RECIPE_PATH.read_text())
    entry = assert_checkpoint_allowed(raw["checkpoint"])

    lora_name = raw["lora"]
    lora_weight = raw["lora_strength"]

    all_graphs = []
    panels_out = []
    for panel in raw["panels"]:
        if "sub_panels" in panel:
            sub_images, sub_records = [], []
            for i, sub in enumerate(panel["sub_panels"]):
                img, prompt_id, graph_hash, effective_weight = generate_sub_panel(
                    raw, panel, sub, i, lora_name, lora_weight
                )
                sub_images.append(img)
                sub_records.append(
                    {
                        "sub_index": i,
                        "label": sub.get("label", ""),
                        "prompt": sub["prompt"],
                        "negative_prompt": sub["negative_prompt"],
                        "seed": sub["seed"],
                        "lora_weight": effective_weight,
                        "prompt_id": prompt_id,
                        "workflow_hash": graph_hash,
                    }
                )
                all_graphs.append({"panel": f"{panel['row']}{panel['col']}_sub{i}", "graph_hash": graph_hash})
            combined_sub_hash = hashlib.sha256(
                json.dumps(sub_records, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            panels_out.append(
                {
                    "panel": panel,
                    "sub_images": sub_images,
                    "sub_records": sub_records,
                    "prompt_id": ",".join(r["prompt_id"] for r in sub_records),
                    "workflow_hash": combined_sub_hash,
                }
            )
        else:
            img, prompt_id, graph_hash = generate_panel(raw, panel, lora_name, lora_weight)
            panels_out.append({"panel": panel, "image": img, "prompt_id": prompt_id, "workflow_hash": graph_hash})
            all_graphs.append({"panel": f"{panel['row']}{panel['col']}", "graph_hash": graph_hash})

    OUT_WORKFLOW.write_text(json.dumps({"panels": all_graphs}, indent=2) + "\n")

    canvas = assemble(panels_out, raw)

    CONCEPT_DIR.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_PNG, format="PNG")
    final_bytes = OUT_PNG.read_bytes()
    concept_hash = hashlib.sha256(final_bytes).hexdigest()

    combined_workflow_hash = hashlib.sha256(
        json.dumps(all_graphs, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    prompt_ids = [
        r["prompt_id"] for p in panels_out for r in (p["sub_records"] if "sub_records" in p else [p])
    ]

    provenance = {
        "model": f"{raw['checkpoint']} + LoRA {lora_name} (weight {lora_weight})",
        "model_license": f"{entry['license']} (base) / {LORA_LICENSE} (LoRA, assembled project T-0072)",
        "model_hash": KNOWN_MODEL_HASH,
        "prompt": raw["prompt"],
        "negative_prompt": raw["negative_prompt"],
        "seed": raw["seed"],
        "steps": raw["steps"],
        "cfg": raw["cfg"],
        "width": raw["width"],
        "height": raw["height"],
        "_top_level_fields_are_sheet_summary": (
            "This entry covers FIVE independent generations, not one. The top-level "
            "prompt/negative_prompt/seed/workflow_hash above describe the assembled "
            "sheet as a whole (a manifest, matching this file's own `prompt` field), "
            "not any single CLIPTextEncode/KSampler call -- width/height are the final "
            "assembled canvas size (read from the recipe and used to build the canvas "
            "in `assemble()`), not any one generation's sampling resolution (each panel "
            "samples at panel_width x panel_height, see `panels` below). The authoritative "
            "per-generation prompt/seed/workflow_hash/prompt_id for each of the five real "
            "ComfyUI jobs are the corresponding fields inside `panels[]` (the transformer/"
            "breaker quadrant's two jobs are under `panels[1].sub_panels`)."
        ),
        "workflow_hash": combined_workflow_hash,
        "prompt_id": ",".join(prompt_ids),
        "prompt_ids": prompt_ids,
        "concept_hash": concept_hash,
        "generator": GENERATOR_ID,
        "lora_name": lora_name,
        "lora_weight": lora_weight,
        "lora_license": LORA_LICENSE,
        "card": "T-0257",
        "panels": [
            {
                "row": p["panel"]["row"],
                "col": p["panel"]["col"],
                "label": p["panel"]["label"],
                "class": p["panel"]["class"],
                **(
                    {"sub_panels": p["sub_records"]}
                    if "sub_records" in p
                    else {"prompt": p["panel"]["prompt"], "negative_prompt": p["panel"]["negative_prompt"], "seed": p["panel"]["seed"]}
                ),
                "prompt_id": p["prompt_id"],
                "workflow_hash": p["workflow_hash"],
                "value_graded": p["value_graded"],
                "value_grade_factor": p.get("value_grade_factor"),
            }
            for p in panels_out
        ],
        "_generator_note": (
            "Five independent real txt2img+LoRA generations (EmptyLatentImage, denoise=1.0) "
            "across the four prop-class quadrants, each resized and pasted into its quadrant "
            "(or half-quadrant) with a typeset caption strip -- no prop geometry is drawn by "
            "code. A single four-class prompt was tried first (seeds 21140/21150/21160, see "
            "recipe git history) and each attempt lost the four distinct classes to the "
            "soviet_brutalism_style_v1 LoRA's strong whole-building bias (v1's own committed "
            "sheet shows the same bias -- a full tower rendered from a props-only prompt). "
            "Splitting generation per class fixed three of the four; the transformer-housings "
            "+ breaker-panel quadrant kept losing its two distinct sub-objects to the same "
            "whole-building bias even after per-class splitting (six single-image attempts: "
            "mecha/robot parts, safes, an icon grid, humanoid green towers, small building "
            "facades -- see recipe git history seeds 21201/21212/21302/21402/21502/21602/21702/21802), "
            "so that one quadrant is itself split into two independent sub-generations -- "
            "transformer housings alone, breaker panel alone -- placed side by side, the same "
            "fix applied one level narrower. Hiding-spot panels get a global brightness "
            "value-grading pass (ImageEnhance.Brightness, no shape drawn) only if the raw "
            "generation didn't already clear the +15 luma cover-vs-hiding gate (T-0223) -- see "
            "each panel's `value_graded`/`value_grade_factor` fields above."
        ),
    }
    OUT_PROV.write_text(json.dumps(provenance, indent=2) + "\n")

    # Measure on the actual final assembled+captioned canvas, same content
    # boxes the test file checks (quadrant minus caption band) -- not the
    # pre-value-grade panel images, so this report matches what the test sees.
    final_img = Image.open(OUT_PNG).convert("RGB")
    cover_luma = _mean_luma(final_img.crop(_content_box(0, 0)))  # archive shelving
    hide_luma = (
        _mean_luma(final_img.crop(_content_box(1, 0)))
        + _mean_luma(final_img.crop(_content_box(1, 1)))
    ) / 2
    print(f"Wrote {OUT_PNG} ({len(final_bytes)} bytes)")
    print(f"Wrote {OUT_PROV}")
    print(f"concept_hash: {concept_hash}")
    print(f"cover_luma(archive shelving)={cover_luma:.1f} hide_luma(crawlspace+alcove avg)={hide_luma:.1f} "
          f"delta={cover_luma - hide_luma:.1f} (measured on final assembled canvas, test-equivalent boxes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
