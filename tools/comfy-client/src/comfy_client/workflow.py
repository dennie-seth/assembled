"""Recipe -> ComfyUI workflow-graph rendering (T-0071).

Templates are versioned JSON under `templates/` -- `render_workflow` loads
one, deep-copies its node graph, and substitutes the recipe's fields into
known node IDs. This is deliberately not a generic graph-templating engine:
node IDs are fixed per template version, and a graph-shape change means a
new template file (`sdxl_txt2img_v2.json`, ...), never editing node IDs in
an existing one -- see `templates/sdxl_txt2img_v1.json`'s `meta` block.
"""

from __future__ import annotations

import copy
import hashlib
import json
from importlib import resources
from typing import Any

from comfy_client.recipe import Recipe

DEFAULT_TEMPLATE_NAME = "sdxl_txt2img_v1"
IMG2IMG_TEMPLATE_NAME = "sdxl_img2img_v1"
LORA_IMG2IMG_TEMPLATE_NAME = "sdxl_img2img_lora_v1"


def load_template(name: str = DEFAULT_TEMPLATE_NAME) -> dict[str, Any]:
    template_path = resources.files("comfy_client.templates").joinpath(f"{name}.json")
    return json.loads(template_path.read_text())


def render_workflow(recipe: Recipe, template: dict[str, Any] | None = None) -> dict[str, Any]:
    """Render `recipe` into a ComfyUI `/prompt`-ready node graph.

    Returns a fresh dict each call -- the shared template is never mutated.
    """
    tmpl = load_template() if template is None else template
    graph = copy.deepcopy(tmpl["graph"])

    graph["4"]["inputs"]["ckpt_name"] = recipe.checkpoint
    graph["6"]["inputs"]["text"] = recipe.prompt
    graph["7"]["inputs"]["text"] = recipe.negative_prompt
    graph["5"]["inputs"]["width"] = recipe.width
    graph["5"]["inputs"]["height"] = recipe.height
    graph["3"]["inputs"]["seed"] = recipe.seed
    graph["3"]["inputs"]["steps"] = recipe.steps
    graph["3"]["inputs"]["cfg"] = recipe.cfg
    graph["3"]["inputs"]["sampler_name"] = recipe.sampler
    graph["3"]["inputs"]["scheduler"] = recipe.scheduler
    graph["9"]["inputs"]["filename_prefix"] = recipe.name

    return graph


def render_img2img_workflow(
    recipe: Recipe, init_image_name: str, template: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Render `recipe` + an already-uploaded ComfyUI input filename into an
    img2img `/prompt`-ready node graph (T-0106 layout conditioning). Unlike
    `render_workflow`, output dimensions follow `init_image_name`, not
    `recipe.width`/`height` -- there is no `EmptyLatentImage` node to size.
    """
    tmpl = load_template(IMG2IMG_TEMPLATE_NAME) if template is None else template
    graph = copy.deepcopy(tmpl["graph"])

    graph["4"]["inputs"]["ckpt_name"] = recipe.checkpoint
    graph["6"]["inputs"]["text"] = recipe.prompt
    graph["7"]["inputs"]["text"] = recipe.negative_prompt
    graph["10"]["inputs"]["image"] = init_image_name
    graph["3"]["inputs"]["seed"] = recipe.seed
    graph["3"]["inputs"]["steps"] = recipe.steps
    graph["3"]["inputs"]["cfg"] = recipe.cfg
    graph["3"]["inputs"]["sampler_name"] = recipe.sampler
    graph["3"]["inputs"]["scheduler"] = recipe.scheduler
    graph["3"]["inputs"]["denoise"] = recipe.denoise
    graph["9"]["inputs"]["filename_prefix"] = recipe.name

    return graph


def render_img2img_lora_workflow(
    recipe: Recipe,
    init_image_name: str,
    lora_name: str,
    lora_weight: float = 0.75,
    template: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Render `recipe` + LoRA name/weight + an already-uploaded init image
    into a LoRA-conditioned img2img `/prompt`-ready node graph (T-0167
    LoRA handshake, `13-asset-pipeline.md` §6.5).

    Node 12 (LoraLoader) sits between CheckpointLoader and the downstream
    KSampler / CLIPTextEncode nodes -- it patches both model and clip with
    the LoRA weights before conditioning or sampling.
    """
    tmpl = load_template(LORA_IMG2IMG_TEMPLATE_NAME) if template is None else template
    graph = copy.deepcopy(tmpl["graph"])

    graph["4"]["inputs"]["ckpt_name"] = recipe.checkpoint
    graph["12"]["inputs"]["lora_name"] = lora_name
    graph["12"]["inputs"]["strength_model"] = lora_weight
    graph["12"]["inputs"]["strength_clip"] = lora_weight
    graph["6"]["inputs"]["text"] = recipe.prompt
    graph["7"]["inputs"]["text"] = recipe.negative_prompt
    graph["10"]["inputs"]["image"] = init_image_name
    graph["3"]["inputs"]["seed"] = recipe.seed
    graph["3"]["inputs"]["steps"] = recipe.steps
    graph["3"]["inputs"]["cfg"] = recipe.cfg
    graph["3"]["inputs"]["sampler_name"] = recipe.sampler
    graph["3"]["inputs"]["scheduler"] = recipe.scheduler
    graph["3"]["inputs"]["denoise"] = recipe.denoise
    graph["9"]["inputs"]["filename_prefix"] = recipe.name

    return graph


def workflow_hash(graph: dict[str, Any]) -> str:
    """Deterministic sha256 of a rendered graph -- the provenance seam's workflow hash."""
    canonical = json.dumps(graph, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
