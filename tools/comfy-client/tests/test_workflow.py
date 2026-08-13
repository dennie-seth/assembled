"""Recipe -> workflow-graph rendering against the versioned SDXL txt2img
template (T-0071 / 13-asset-pipeline.md §1)."""

from __future__ import annotations

from comfy_client.recipe import Recipe
from comfy_client.workflow import (
    load_template,
    render_img2img_workflow,
    render_workflow,
    workflow_hash,
)


def test_load_template_has_the_expected_node_shape():
    tmpl = load_template()
    graph = tmpl["graph"]
    assert graph["4"]["class_type"] == "CheckpointLoaderSimple"
    assert graph["6"]["class_type"] == "CLIPTextEncode"
    assert graph["7"]["class_type"] == "CLIPTextEncode"
    assert graph["5"]["class_type"] == "EmptyLatentImage"
    assert graph["3"]["class_type"] == "KSampler"
    assert graph["8"]["class_type"] == "VAEDecode"
    assert graph["9"]["class_type"] == "SaveImage"


def test_render_workflow_substitutes_recipe_fields():
    r = Recipe(
        prompt="a derelict signal tower, brutalist concrete",
        negative_prompt="blurry, low quality",
        seed=1234,
        steps=25,
        cfg=8.0,
        width=1152,
        height=896,
        checkpoint="sd_xl_base_1.0.safetensors",
        sampler="dpmpp_2m",
        scheduler="karras",
        name="signal_tower",
    )
    graph = render_workflow(r)

    assert graph["4"]["inputs"]["ckpt_name"] == "sd_xl_base_1.0.safetensors"
    assert graph["6"]["inputs"]["text"] == r.prompt
    assert graph["7"]["inputs"]["text"] == r.negative_prompt
    assert graph["5"]["inputs"]["width"] == 1152
    assert graph["5"]["inputs"]["height"] == 896
    assert graph["3"]["inputs"]["seed"] == 1234
    assert graph["3"]["inputs"]["steps"] == 25
    assert graph["3"]["inputs"]["cfg"] == 8.0
    assert graph["3"]["inputs"]["sampler_name"] == "dpmpp_2m"
    assert graph["3"]["inputs"]["scheduler"] == "karras"
    assert graph["9"]["inputs"]["filename_prefix"] == "signal_tower"


def test_render_workflow_does_not_mutate_the_shared_template():
    r1 = Recipe(prompt="first", seed=1)
    r2 = Recipe(prompt="second", seed=2)
    graph1 = render_workflow(r1)
    graph2 = render_workflow(r2)
    assert graph1["6"]["inputs"]["text"] == "first"
    assert graph2["6"]["inputs"]["text"] == "second"


def test_workflow_hash_is_deterministic():
    r = Recipe(prompt="x", seed=1)
    graph = render_workflow(r)
    assert workflow_hash(graph) == workflow_hash(render_workflow(r))


def test_workflow_hash_differs_for_different_recipes():
    graph_a = render_workflow(Recipe(prompt="x", seed=1))
    graph_b = render_workflow(Recipe(prompt="x", seed=2))
    assert workflow_hash(graph_a) != workflow_hash(graph_b)


def test_load_img2img_template_has_the_expected_node_shape():
    tmpl = load_template("sdxl_img2img_v1")
    graph = tmpl["graph"]
    assert graph["4"]["class_type"] == "CheckpointLoaderSimple"
    assert graph["6"]["class_type"] == "CLIPTextEncode"
    assert graph["7"]["class_type"] == "CLIPTextEncode"
    assert graph["10"]["class_type"] == "LoadImage"
    assert graph["11"]["class_type"] == "VAEEncode"
    assert graph["3"]["class_type"] == "KSampler"
    assert graph["8"]["class_type"] == "VAEDecode"
    assert graph["9"]["class_type"] == "SaveImage"
    # No EmptyLatentImage -- the latent comes from the encoded init image.
    assert "5" not in graph


def test_render_img2img_workflow_substitutes_recipe_and_init_image():
    r = Recipe(
        prompt="brutalist concrete wall texture",
        negative_prompt="blurry, low quality",
        seed=2201,
        steps=25,
        cfg=8.0,
        checkpoint="sd_xl_base_1.0.safetensors",
        sampler="dpmpp_2m",
        scheduler="karras",
        denoise=0.65,
        name="signal_tower_material_sheet",
    )
    graph = render_img2img_workflow(r, init_image_name="template_00001.png")

    assert graph["4"]["inputs"]["ckpt_name"] == "sd_xl_base_1.0.safetensors"
    assert graph["6"]["inputs"]["text"] == r.prompt
    assert graph["7"]["inputs"]["text"] == r.negative_prompt
    assert graph["10"]["inputs"]["image"] == "template_00001.png"
    assert graph["11"]["inputs"]["pixels"] == ["10", 0]
    assert graph["3"]["inputs"]["seed"] == 2201
    assert graph["3"]["inputs"]["steps"] == 25
    assert graph["3"]["inputs"]["cfg"] == 8.0
    assert graph["3"]["inputs"]["sampler_name"] == "dpmpp_2m"
    assert graph["3"]["inputs"]["scheduler"] == "karras"
    assert graph["3"]["inputs"]["denoise"] == 0.65
    assert graph["3"]["inputs"]["latent_image"] == ["11", 0]
    assert graph["9"]["inputs"]["filename_prefix"] == "signal_tower_material_sheet"


def test_render_img2img_workflow_does_not_mutate_the_shared_template():
    r1 = Recipe(prompt="first", seed=1)
    r2 = Recipe(prompt="second", seed=2)
    graph1 = render_img2img_workflow(r1, init_image_name="a.png")
    graph2 = render_img2img_workflow(r2, init_image_name="b.png")
    assert graph1["6"]["inputs"]["text"] == "first"
    assert graph2["6"]["inputs"]["text"] == "second"
    assert graph1["10"]["inputs"]["image"] == "a.png"
    assert graph2["10"]["inputs"]["image"] == "b.png"


def test_img2img_workflow_hash_differs_from_txt2img_for_same_recipe():
    r = Recipe(prompt="x", seed=1)
    txt2img_graph = render_workflow(r)
    img2img_graph = render_img2img_workflow(r, init_image_name="a.png")
    assert workflow_hash(txt2img_graph) != workflow_hash(img2img_graph)


# ---- LoRA img2img workflow (T-0167) ----------------------------------------


def test_load_lora_img2img_template_has_expected_node_shape():
    from comfy_client.workflow import load_template

    tmpl = load_template("sdxl_img2img_lora_v1")
    graph = tmpl["graph"]
    assert graph["4"]["class_type"] == "CheckpointLoaderSimple"
    assert graph["12"]["class_type"] == "LoraLoader"
    assert graph["6"]["class_type"] == "CLIPTextEncode"
    assert graph["7"]["class_type"] == "CLIPTextEncode"
    assert graph["10"]["class_type"] == "LoadImage"
    assert graph["11"]["class_type"] == "VAEEncode"
    assert graph["3"]["class_type"] == "KSampler"
    assert graph["8"]["class_type"] == "VAEDecode"
    assert graph["9"]["class_type"] == "SaveImage"
    # LoraLoader outputs feed the downstream nodes
    assert graph["3"]["inputs"]["model"] == ["12", 0]
    assert graph["6"]["inputs"]["clip"] == ["12", 1]
    assert graph["7"]["inputs"]["clip"] == ["12", 1]


def test_render_img2img_lora_workflow_substitutes_recipe_and_lora_fields():
    from comfy_client.workflow import render_img2img_lora_workflow

    r = Recipe(
        prompt="brutalist concrete wall texture",
        negative_prompt="blurry, low quality",
        seed=3101,
        steps=30,
        cfg=7.0,
        checkpoint="sd_xl_base_1.0.safetensors",
        sampler="euler",
        scheduler="normal",
        denoise=0.9,
        name="signal_tower_material_sheet_lora",
    )
    graph = render_img2img_lora_workflow(
        r,
        init_image_name="signal_tower_material_template_00001.png",
        lora_name="soviet_brutalism_style_v1",
        lora_weight=0.75,
    )
    assert graph["4"]["inputs"]["ckpt_name"] == "sd_xl_base_1.0.safetensors"
    assert graph["6"]["inputs"]["text"] == r.prompt
    assert graph["7"]["inputs"]["text"] == r.negative_prompt
    assert graph["10"]["inputs"]["image"] == "signal_tower_material_template_00001.png"
    assert graph["12"]["inputs"]["lora_name"] == "soviet_brutalism_style_v1"
    assert graph["12"]["inputs"]["strength_model"] == 0.75
    assert graph["12"]["inputs"]["strength_clip"] == 0.75
    assert graph["3"]["inputs"]["seed"] == 3101
    assert graph["3"]["inputs"]["steps"] == 30
    assert graph["3"]["inputs"]["cfg"] == 7.0
    assert graph["3"]["inputs"]["denoise"] == 0.9
    assert graph["9"]["inputs"]["filename_prefix"] == "signal_tower_material_sheet_lora"


def test_render_img2img_lora_workflow_does_not_mutate_template():
    from comfy_client.workflow import render_img2img_lora_workflow

    r1 = Recipe(prompt="first", seed=1)
    r2 = Recipe(prompt="second", seed=2)
    g1 = render_img2img_lora_workflow(r1, "a.png", lora_name="l1", lora_weight=0.5)
    g2 = render_img2img_lora_workflow(r2, "b.png", lora_name="l2", lora_weight=0.8)
    assert g1["6"]["inputs"]["text"] == "first"
    assert g2["6"]["inputs"]["text"] == "second"
    assert g1["12"]["inputs"]["lora_name"] == "l1"
    assert g2["12"]["inputs"]["lora_name"] == "l2"


def test_lora_workflow_hash_differs_from_non_lora_img2img():
    from comfy_client.workflow import render_img2img_lora_workflow

    r = Recipe(prompt="x", seed=1)
    non_lora = render_img2img_workflow(r, init_image_name="a.png")
    lora = render_img2img_lora_workflow(r, "a.png", lora_name="test_lora", lora_weight=0.5)
    assert workflow_hash(non_lora) != workflow_hash(lora)
