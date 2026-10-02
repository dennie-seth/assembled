"""T-0418: closes the bypass where a hand-built graph submitted directly to
`ComfyUIClient.submit()` (skipping `comfy_client.pipeline.generate()`
entirely) never had its checkpoint checked against the license allowlist --
exactly the route `assets/src/character/gen_master_sheet_cutout_compare_T0337.py`
uses. These are pure unit tests of `assert_graph_checkpoints_allowed` itself
(no HTTP); `test_comfyui_client.py` covers the integration into `submit()`.

RED state: `comfy_client.checkpoint_gate` does not exist yet -> ImportError.
"""

from __future__ import annotations

import pytest
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from comfy_client import checkpoint_gate
from comfy_client.checkpoint_gate import (
    CHECKPOINT_BEARING_NODE_TYPES,
    assert_graph_checkpoints_allowed,
)

ALLOWED_SDXL = "sd_xl_base_1.0.safetensors"
ALLOWED_SAM3 = "sam3.1_multiplex_fp16.safetensors"
UNREGISTERED = "totally_unregistered_checkpoint.safetensors"


def _node(class_type: str, inputs: dict) -> dict:
    return {"class_type": class_type, "inputs": inputs}


def test_named_constant_covers_checkpoint_loader_simple_and_unet_loader():
    assert CHECKPOINT_BEARING_NODE_TYPES["CheckpointLoaderSimple"] == "ckpt_name"
    assert CHECKPOINT_BEARING_NODE_TYPES["UNETLoader"] == "unet_name"


def test_allows_graph_with_no_checkpoint_bearing_nodes_at_all():
    graph = {
        "1": _node("LoadImage", {"image": "panel.png"}),
        "2": _node("SaveImage", {"images": ["1", 0], "filename_prefix": "x"}),
    }
    assert_graph_checkpoints_allowed(graph)  # must not raise


def test_allows_checkpoint_loader_simple_naming_an_allowed_checkpoint():
    graph = {"4": _node("CheckpointLoaderSimple", {"ckpt_name": ALLOWED_SDXL})}
    assert_graph_checkpoints_allowed(graph)  # must not raise


def test_allows_unet_loader_naming_an_allowed_checkpoint():
    graph = {"2": _node("UNETLoader", {"unet_name": ALLOWED_SAM3, "weight_dtype": "default"})}
    assert_graph_checkpoints_allowed(graph)  # must not raise


def test_refuses_checkpoint_loader_simple_naming_an_unregistered_checkpoint():
    graph = {"4": _node("CheckpointLoaderSimple", {"ckpt_name": UNREGISTERED})}
    with pytest.raises(CheckpointNotAllowedError, match="not on the approved allowlist"):
        assert_graph_checkpoints_allowed(graph)


def test_refuses_unet_loader_naming_an_unregistered_checkpoint():
    """This is the exact node type the hand-built SAM3 graph in
    gen_master_sheet_cutout_compare_T0337.py uses."""
    graph = {"2": _node("UNETLoader", {"unet_name": UNREGISTERED, "weight_dtype": "default"})}
    with pytest.raises(CheckpointNotAllowedError, match="not on the approved allowlist"):
        assert_graph_checkpoints_allowed(graph)


def test_checks_every_checkpoint_bearing_node_not_just_the_first():
    """First node names an allowed checkpoint, second an unregistered one --
    if the gate short-circuited after the first match this would wrongly pass."""
    graph = {
        "4": _node("CheckpointLoaderSimple", {"ckpt_name": ALLOWED_SDXL}),
        "2": _node("UNETLoader", {"unet_name": UNREGISTERED, "weight_dtype": "default"}),
    }
    with pytest.raises(CheckpointNotAllowedError):
        assert_graph_checkpoints_allowed(graph)


def test_matches_a_checkpoint_named_with_a_subdirectory_prefix_against_the_bare_allowlist_entry():
    graph = {"4": _node("CheckpointLoaderSimple", {"ckpt_name": f"SDXL/{ALLOWED_SDXL}"})}
    assert_graph_checkpoints_allowed(graph)  # must not raise -- basename match policy


def test_subdirectory_prefix_does_not_hide_an_unregistered_checkpoint():
    graph = {"4": _node("CheckpointLoaderSimple", {"ckpt_name": f"SDXL/{UNREGISTERED}"})}
    with pytest.raises(CheckpointNotAllowedError):
        assert_graph_checkpoints_allowed(graph)


@pytest.mark.parametrize("bad_value", [None, "", 42, [], {}])
def test_refuses_a_checkpoint_bearing_node_whose_widget_value_is_absent_or_not_a_usable_string(
    bad_value,
):
    graph = {"4": _node("CheckpointLoaderSimple", {"ckpt_name": bad_value})}
    with pytest.raises(CheckpointNotAllowedError):
        assert_graph_checkpoints_allowed(graph)


def test_refuses_a_checkpoint_bearing_node_missing_the_widget_key_entirely():
    graph = {"4": _node("CheckpointLoaderSimple", {})}
    with pytest.raises(CheckpointNotAllowedError):
        assert_graph_checkpoints_allowed(graph)


def test_does_not_force_lora_vae_controlnet_or_upscaler_nodes_through_the_checkpoint_allowlist():
    """These name a different kind of model entirely -- forcing them through
    the checkpoint allowlist would refuse working graphs that don't even
    load a checkpoint by that name."""
    graph = {
        "12": _node(
            "LoraLoader",
            {
                "lora_name": "not_a_checkpoint_and_not_registered.safetensors",
                "strength_model": 0.7,
            },
        ),
        "13": _node("VAELoader", {"vae_name": "also_not_registered.safetensors"}),
        "14": _node(
            "ControlNetLoader", {"control_net_name": "unregistered_controlnet.safetensors"}
        ),
        "15": _node("UpscaleModelLoader", {"model_name": "unregistered_upscaler.safetensors"}),
    }
    assert_graph_checkpoints_allowed(graph)  # must not raise


def test_rejects_a_graph_that_is_not_a_dict_of_nodes():
    with pytest.raises(CheckpointNotAllowedError):
        assert_graph_checkpoints_allowed(["not", "a", "dict"])


def test_rejects_a_node_entry_that_is_not_a_dict():
    graph = {"4": "not a node dict"}
    with pytest.raises(CheckpointNotAllowedError):
        assert_graph_checkpoints_allowed(graph)


def test_propagates_underlying_allowlist_errors_without_swallowing_them(monkeypatch):
    """Proves fail-closed: if the allowlist itself can't be loaded (missing/
    unreadable file), the gate must not silently treat that as 'allowed' --
    the underlying error must propagate untouched."""

    def _boom(checkpoint, allowlist=None):
        raise FileNotFoundError("allowlist file missing")

    monkeypatch.setattr(checkpoint_gate, "assert_checkpoint_allowed", _boom)
    graph = {"4": _node("CheckpointLoaderSimple", {"ckpt_name": ALLOWED_SDXL})}
    with pytest.raises(FileNotFoundError):
        assert_graph_checkpoints_allowed(graph)
