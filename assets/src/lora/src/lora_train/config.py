"""Training configuration loader and validator.

The training_config.toml file is the reproducible specification for the
T-0072 SDXL style LoRA training run. Committing it alongside the corpus
manifest satisfies the "training config committed for reproducibility"
acceptance criterion.

Checked against: 13-asset-pipeline.md §3.2
  "Post-hoc quantization, palette-agnostic LoRA. The LoRA can be trained
   before the palette hex set is decided."

assets.md: "no CC-BY-NC weights" — enforced here via CHECKPOINT_ALLOWLIST.
"""

from __future__ import annotations

import math
import pathlib
from dataclasses import dataclass

# tomllib is stdlib from Python 3.11; tomli is the backport for ≤3.10.
try:
    import tomllib  # type: ignore[import]
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore[import,no-redef]


# Checkpoints that pass the Apache-2.0 / OpenRAIL / CC0 allowlist.
# SD XL 1.0 ships under "CreativeML Open RAIL++-M" which is the OpenRAIL
# family — unambiguously commercial-use-permitted, no NC clause.
CHECKPOINT_ALLOWLIST = frozenset({
    "CreativeML Open RAIL++-M",
    "Apache-2.0",
    "CC0",
})

# SDXL trains natively at 1024. Off-native buckets degrade output quality.
_SDXL_NATIVE_RESOLUTION = 1024


def _is_power_of_two(n: int) -> bool:
    return n > 0 and (n & (n - 1)) == 0


@dataclass(frozen=True)
class TrainingConfig:
    # Model
    base_checkpoint: str
    checkpoint_license: str
    # Output
    output_name: str
    output_dir: str
    output_format: str
    # Training hyperparameters
    resolution: int
    batch_size: int
    mixed_precision: str
    num_epochs: int
    learning_rate: float
    optimizer: str
    # Network
    network_rank: int
    network_alpha: int
    network_type: str
    # Dataset
    dataset_dir: str
    shuffle: bool
    cache_latents: bool

    def __post_init__(self) -> None:
        if not self.base_checkpoint.strip():
            raise ValueError("base_checkpoint must not be empty")
        if self.checkpoint_license not in CHECKPOINT_ALLOWLIST:
            raise ValueError(
                f"checkpoint_license {self.checkpoint_license!r} not in allowlist "
                f"{sorted(CHECKPOINT_ALLOWLIST)}"
            )
        if self.resolution != _SDXL_NATIVE_RESOLUTION:
            raise ValueError(
                f"resolution must be {_SDXL_NATIVE_RESOLUTION} (SDXL native), got {self.resolution}"
            )
        if not _is_power_of_two(self.resolution):
            raise ValueError(f"resolution must be a power of two, got {self.resolution}")
        if self.batch_size <= 0:
            raise ValueError(f"batch_size must be > 0, got {self.batch_size}")
        if self.num_epochs <= 0:
            raise ValueError(f"num_epochs must be > 0, got {self.num_epochs}")
        if self.learning_rate <= 0:
            raise ValueError(f"learning_rate must be > 0, got {self.learning_rate}")
        if self.network_rank <= 0:
            raise ValueError(f"network_rank must be > 0, got {self.network_rank}")
        if self.network_alpha <= 0:
            raise ValueError(f"network_alpha must be > 0, got {self.network_alpha}")
        if self.network_alpha > self.network_rank:
            raise ValueError(
                f"network_alpha ({self.network_alpha}) must not exceed "
                f"network_rank ({self.network_rank})"
            )
        if self.output_format != "safetensors":
            raise ValueError(
                f"output_format must be 'safetensors' (ckpt/pt have pickle risk), "
                f"got {self.output_format!r}"
            )
        if not self.output_dir.startswith("assets/final/"):
            raise ValueError(
                f"output_dir must be under assets/final/, got {self.output_dir!r}"
            )
        if not self.dataset_dir.startswith("assets/src/"):
            raise ValueError(
                f"dataset_dir must be under assets/src/, got {self.dataset_dir!r}"
            )
        if self.mixed_precision not in {"fp16", "bf16"}:
            raise ValueError(
                f"mixed_precision must be 'fp16' or 'bf16', got {self.mixed_precision!r}"
            )


def load_config(path: pathlib.Path | str) -> TrainingConfig:
    """Load and validate training_config.toml."""
    raw = pathlib.Path(path).read_bytes()
    data = tomllib.loads(raw.decode("utf-8"))
    return TrainingConfig(
        base_checkpoint=data["model"]["base_checkpoint"],
        checkpoint_license=data["model"]["checkpoint_license"],
        output_name=data["output"]["name"],
        output_dir=data["output"]["dir"],
        output_format=data["output"]["format"],
        resolution=data["train"]["resolution"],
        batch_size=data["train"]["batch_size"],
        mixed_precision=data["train"]["mixed_precision"],
        num_epochs=data["train"]["num_epochs"],
        learning_rate=data["train"]["learning_rate"],
        optimizer=data["train"]["optimizer"],
        network_rank=data["network"]["rank"],
        network_alpha=data["network"]["alpha"],
        network_type=data["network"]["type"],
        dataset_dir=data["dataset"]["dir"],
        shuffle=data["dataset"]["shuffle"],
        cache_latents=data["dataset"]["cache_latents"],
    )
