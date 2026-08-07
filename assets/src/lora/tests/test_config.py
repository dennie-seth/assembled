"""Tests for the LoRA training configuration.

Implements T-0072 acceptance criteria:
  - SDXL style LoRA trained against the corpus
  - Training config committed for reproducibility

Checked against: 13-asset-pipeline.md §3.2
  "Post-hoc quantization, palette-agnostic LoRA.  The style LoRA (T-0072)
   trains on the reference corpus in its natural colour."
"""

from __future__ import annotations

import pathlib

import pytest

from lora_train.config import (
    CHECKPOINT_ALLOWLIST,
    TrainingConfig,
    load_config,
)

CONFIG_PATH = pathlib.Path(__file__).parent.parent / "training_config.toml"


# ---------------------------------------------------------------------------
# Unit tests — validate TrainingConfig dataclass constraints
# ---------------------------------------------------------------------------


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


def test_base_checkpoint_must_be_non_empty():
    with pytest.raises(ValueError):
        _make_config(base_checkpoint="")


def test_checkpoint_license_must_be_on_allowlist():
    with pytest.raises(ValueError):
        _make_config(checkpoint_license="CC-BY-NC-4.0")
    with pytest.raises(ValueError):
        _make_config(checkpoint_license="Unknown License")


def test_checkpoint_allowlist_excludes_nc():
    for lic in CHECKPOINT_ALLOWLIST:
        assert "NC" not in lic, f"NC license in allowlist: {lic}"


def test_resolution_must_be_sdxl_native():
    # SDXL native: 1024. Other values warn or raise.
    with pytest.raises(ValueError):
        _make_config(resolution=512)  # not SDXL-native


def test_resolution_must_be_power_of_two():
    with pytest.raises(ValueError):
        _make_config(resolution=1000)


def test_batch_size_must_be_positive():
    with pytest.raises(ValueError):
        _make_config(batch_size=0)


def test_num_epochs_must_be_positive():
    with pytest.raises(ValueError):
        _make_config(num_epochs=0)


def test_learning_rate_must_be_positive():
    with pytest.raises(ValueError):
        _make_config(learning_rate=0.0)
    with pytest.raises(ValueError):
        _make_config(learning_rate=-1.0e-4)


def test_network_rank_must_be_positive():
    with pytest.raises(ValueError):
        _make_config(network_rank=0)


def test_network_alpha_must_be_positive():
    with pytest.raises(ValueError):
        _make_config(network_alpha=0)


def test_network_alpha_must_not_exceed_rank():
    # alpha > rank is unusual and almost certainly a config error
    with pytest.raises(ValueError):
        _make_config(network_rank=8, network_alpha=16)


def test_output_format_must_be_safetensors():
    # Only safetensors is accepted — ckpt is a legacy format with
    # known deserialisation risks (arbitrary pickle execution).
    with pytest.raises(ValueError):
        _make_config(output_format="ckpt")
    with pytest.raises(ValueError):
        _make_config(output_format="pt")


def test_output_dir_must_be_under_assets_final():
    with pytest.raises(ValueError):
        _make_config(output_dir="/tmp/lora_output")
    with pytest.raises(ValueError):
        _make_config(output_dir="output")


def test_dataset_dir_must_be_under_assets_src():
    with pytest.raises(ValueError):
        _make_config(dataset_dir="/tmp/refs")


def test_mixed_precision_must_be_fp16_or_bf16():
    _make_config(mixed_precision="fp16")  # ok
    _make_config(mixed_precision="bf16")  # ok
    with pytest.raises(ValueError):
        _make_config(mixed_precision="fp32")


def test_config_is_frozen():
    cfg = _make_config()
    with pytest.raises(Exception):
        cfg.learning_rate = 999.0  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Integration tests — load the real training_config.toml
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def config() -> TrainingConfig:
    return load_config(CONFIG_PATH)


def test_config_loads_without_error(config: TrainingConfig):
    assert config is not None


def test_config_checkpoint_is_on_allowlist(config: TrainingConfig):
    assert config.checkpoint_license in CHECKPOINT_ALLOWLIST, (
        f"checkpoint_license {config.checkpoint_license!r} not in allowlist"
    )


def test_config_resolution_is_sdxl_native(config: TrainingConfig):
    assert config.resolution == 1024


def test_config_output_dir_correct(config: TrainingConfig):
    assert config.output_dir.startswith("assets/final/")


def test_config_dataset_dir_correct(config: TrainingConfig):
    assert config.dataset_dir.startswith("assets/src/lora/refs")


def test_config_output_format_is_safetensors(config: TrainingConfig):
    assert config.output_format == "safetensors"


def test_config_network_rank_reasonable(config: TrainingConfig):
    # For a style LoRA, ranks 8–64 are typical; outside that range is suspect.
    assert 8 <= config.network_rank <= 64


def test_config_learning_rate_in_reasonable_range(config: TrainingConfig):
    assert 1e-6 <= config.learning_rate <= 1e-2
