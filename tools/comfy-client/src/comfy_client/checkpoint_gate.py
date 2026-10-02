"""T-0418: closes the hand-built-graph bypass around the checkpoint license
allowlist. `comfy_client.pipeline.generate()` already calls
`assert_checkpoint_allowed(recipe.checkpoint)` before rendering a workflow --
but that is the only call site. `ComfyUIClient.submit()` took an
already-built graph and posted it, unchecked, so any caller that builds its
own workflow dict (e.g.
`assets/src/character/gen_master_sheet_cutout_compare_T0337.py`'s hand-built
SAM3 graph) reached ComfyUI with whatever checkpoint it named -- T-0337's own
`sam3.1_multiplex_fp16.safetensors` reached the GPU this way before its
licence family was registered.

This module inspects a raw ComfyUI graph dict for checkpoint-bearing nodes
and asserts each one against the same allowlist, so `ComfyUIClient.submit()`
(see `comfyui_client.py`) can enforce the gate on every caller, not only
`pipeline.generate()`.
"""

from __future__ import annotations

from typing import Any

from gen_client_base.license_allowlist import CheckpointNotAllowedError, assert_checkpoint_allowed

#: class_type -> the `inputs` key naming a checkpoint/diffusion-model file for
#: that node type. Adding a loader is one entry here, not a hunt through
#: conditionals. Deliberately excludes LoRA/VAE/ControlNet/upscaler loader
#: node types (`LoraLoader`, `VAELoader`, `ControlNetLoader`,
#: `UpscaleModelLoader`, ...) -- those name a different kind of model, not a
#: checkpoint, and forcing them through the checkpoint allowlist would refuse
#: working graphs that never claimed to load a checkpoint at all.
CHECKPOINT_BEARING_NODE_TYPES: dict[str, str] = {
    "CheckpointLoaderSimple": "ckpt_name",
    "UNETLoader": "unet_name",
}


def _basename(checkpoint_name: str) -> str:
    """Matching policy: compare the final path segment only, on either
    separator. The allowlist keys bare filenames
    (`sd_xl_base_1.0.safetensors`); a ComfyUI model-folder widget may carry a
    subdirectory prefix from its own folder layout
    (`SDXL/sd_xl_base_1.0.safetensors`) naming the very same checkpoint file.
    Matching the full string would wrongly refuse that legitimate case;
    getting the direction wrong the other way (e.g. matching any prefix
    substring) would be its own bypass, which is why this is exactly the
    final path segment and nothing looser."""
    return checkpoint_name.replace("\\", "/").rsplit("/", 1)[-1]


def assert_graph_checkpoints_allowed(graph: Any) -> None:
    """Raise `CheckpointNotAllowedError` if any checkpoint-bearing node in
    `graph` names a checkpoint that is not on the license allowlist.

    Every node in `CHECKPOINT_BEARING_NODE_TYPES` is checked, not just the
    first one found. A graph naming no checkpoint at all (e.g. a
    segmentation-only graph with no `CheckpointLoaderSimple`/`UNETLoader`
    node) passes silently -- the gate refuses unregistered checkpoints, it
    does not require every graph to have one.

    Fails closed: a missing/unreadable allowlist file, a malformed graph (not
    a dict of nodes), or a checkpoint-bearing node whose widget value is
    absent, empty, or not a string are all refused rather than silently
    treated as allowed. No exception this raises is swallowed here --
    `assert_checkpoint_allowed`'s own errors (including a missing allowlist
    file) propagate untouched.
    """
    if not isinstance(graph, dict):
        raise CheckpointNotAllowedError(
            f"workflow graph must be a dict of node_id -> node, got {type(graph).__name__}"
        )

    for node_id, node in graph.items():
        if not isinstance(node, dict):
            raise CheckpointNotAllowedError(f"node {node_id!r} is not a dict: {node!r}")

        widget_key = CHECKPOINT_BEARING_NODE_TYPES.get(node.get("class_type"))
        if widget_key is None:
            continue

        checkpoint_name = node.get("inputs", {}).get(widget_key)
        if not isinstance(checkpoint_name, str) or not checkpoint_name:
            raise CheckpointNotAllowedError(
                f"node {node_id!r} ({node.get('class_type')!r}) has no usable "
                f"{widget_key!r} value ({checkpoint_name!r}) -- refusing rather than "
                "silently treating it as allowed"
            )

        assert_checkpoint_allowed(_basename(checkpoint_name))
