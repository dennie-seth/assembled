"""Recipe -> workflow-graph rendering against the versioned SDXL txt2img
template (T-0071 / 13-asset-pipeline.md §1)."""

from __future__ import annotations

from comfy_client.recipe import Recipe
from comfy_client.workflow import load_template, render_workflow, workflow_hash


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
