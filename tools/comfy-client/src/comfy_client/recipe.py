"""Recipe: the reproducible generation unit (13-asset-pipeline.md §1).

`recipe -> generate -> descend -> validate -> provenance`. This module is
the first arrow: a recipe is prompt + seed + steps + cfg + dimensions +
checkpoint + model hash, and nothing else -- deliberately excludes anything
that isn't needed to reproduce the exact same output byte-for-byte
(P-1: output ships as-is, rejection means regenerate with an adjusted
recipe, never hand-edit).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Recipe:
    prompt: str
    seed: int
    negative_prompt: str = ""
    steps: int = 20
    cfg: float = 7.0
    width: int = 1024
    height: int = 1024
    checkpoint: str = "sd_xl_base_1.0.safetensors"
    sampler: str = "euler"
    scheduler: str = "normal"
    name: str = "assembled"
    # img2img only (T-0106): KSampler denoise strength. 1.0 (txt2img default)
    # discards the init image's latent entirely; lower values preserve more
    # of its layout. Unused by the txt2img template.
    denoise: float = 1.0
    # SHA-256 of the checkpoint file, computed at generation time via
    # hash_checkpoint_file() (T-0151).  None is only permitted in the recipe
    # definition itself; generate() and build_provenance_record() both raise
    # MissingModelHashError if it is still None at call time.
    model_hash: str | None = None

    def __post_init__(self) -> None:
        if not self.prompt.strip():
            raise ValueError("recipe.prompt must not be empty")
        if self.steps <= 0:
            raise ValueError("recipe.steps must be positive")
        if self.width <= 0 or self.height <= 0:
            raise ValueError("recipe.width/height must be positive")
        if not (0.0 < self.denoise <= 1.0):
            raise ValueError("recipe.denoise must be in (0.0, 1.0]")


def recipe_to_dict(recipe: Recipe) -> dict:
    return asdict(recipe)


def load_recipe(path: str | Path) -> Recipe:
    data = json.loads(Path(path).read_text())
    return Recipe(**data)
