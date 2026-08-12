"""Tests for the sd-scripts training glue (lora_train.train).

Covers the pure config-building functions only (dataset TOML rendering,
CLI arg construction) — actually invoking `accelerate launch
sdxl_train_network.py` requires a GPU and the WSL-native training stack
from setup-training-env.sh, so that path is exercised by a manual smoke
run, not this suite (same pattern as lora_train.fetch's network calls).
"""

from __future__ import annotations

import pathlib

from lora_train.config import TrainingConfig
from lora_train.train import (
    build_dataset_toml,
    build_train_args,
    resolve_checkpoint_path,
    resolve_sd_scripts_dir,
)


def _make_config(**overrides) -> TrainingConfig:
    defaults = dict(
        base_checkpoint="sd_xl_base_1.0.safetensors",
        checkpoint_license="CreativeML Open RAIL++-M",
        output_name="soviet_brutalism_style_v1",
        output_dir="assets/final/lora",
        output_format="safetensors",
        resolution=1024,
        batch_size=1,
        mixed_precision="fp16",
        num_epochs=10,
        learning_rate=1.0e-4,
        optimizer="AdamW8bit",
        network_rank=16,
        network_alpha=8,
        network_type="lora",
        dataset_dir="assets/src/lora/refs",
        shuffle=True,
        cache_latents=True,
    )
    defaults.update(overrides)
    return TrainingConfig(**defaults)


def test_dataset_toml_points_at_refs_dir():
    config = _make_config()
    refs_dir = pathlib.Path("/repo/assets/src/lora/refs")
    toml_text = build_dataset_toml(config, refs_dir)
    assert str(refs_dir) in toml_text
    assert 'caption_extension = ".txt"' in toml_text
    assert "resolution = 1024" in toml_text
    assert "batch_size = 1" in toml_text


def test_dataset_toml_shuffle_reflects_config():
    assert "shuffle_caption = true" in build_dataset_toml(
        _make_config(shuffle=True), pathlib.Path("/repo/refs")
    )
    assert "shuffle_caption = false" in build_dataset_toml(
        _make_config(shuffle=False), pathlib.Path("/repo/refs")
    )


def test_train_args_include_8gb_vram_flags():
    config = _make_config()
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
    )
    assert "--gradient_checkpointing" in args
    assert "--sdpa" in args
    assert "--cache_latents" in args
    assert "--optimizer_type=AdamW8bit" in args
    # deliberately NOT used: incompatible with shuffle_caption (see train.py)
    assert "--cache_text_encoder_outputs" not in args


def test_train_args_max_train_steps_overrides_epochs():
    config = _make_config(num_epochs=10)
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
        max_train_steps=10,
    )
    assert "--max_train_steps=10" in args
    assert not any(a.startswith("--max_train_epochs") for a in args)


def test_train_args_default_uses_num_epochs():
    config = _make_config(num_epochs=10)
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
    )
    assert "--max_train_epochs=10" in args
    assert not any(a.startswith("--max_train_steps") for a in args)


def test_train_args_network_settings_from_config():
    config = _make_config(network_rank=16, network_alpha=8)
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
    )
    assert "--network_dim=16" in args
    assert "--network_alpha=8" in args
    assert "--network_module=networks.lora" in args


def test_resolve_checkpoint_path_uses_default_root(monkeypatch):
    monkeypatch.delenv("LORA_CHECKPOINT_PATH", raising=False)
    config = _make_config()
    path = resolve_checkpoint_path(config)
    assert path.name == "sd_xl_base_1.0.safetensors"
    assert "ComfyUI" in str(path)


def test_resolve_checkpoint_path_honours_env_override(monkeypatch):
    monkeypatch.setenv("LORA_CHECKPOINT_PATH", "/custom/checkpoint.safetensors")
    config = _make_config()
    assert resolve_checkpoint_path(config) == pathlib.Path("/custom/checkpoint.safetensors")


def test_resolve_sd_scripts_dir_honours_env_override(monkeypatch):
    monkeypatch.setenv("LORA_SD_SCRIPTS_DIR", "/custom/sd-scripts")
    assert resolve_sd_scripts_dir() == pathlib.Path("/custom/sd-scripts")
