"""MusicRecipe: the reproducible generation unit (13-asset-pipeline.md §1, §4.2).

`recipe -> generate -> descend -> validate -> provenance`, mirroring
`comfy_client.recipe.Recipe`. A recipe is prompt/tags + seed + ACE-Step's
diffusion parameters + model, and nothing else -- deliberately excludes
anything not needed to reproduce the exact same output byte-for-byte
(P-1: output ships as-is, rejection means regenerate with an adjusted
recipe, never hand-edit).

Field defaults for `infer_step`, `scheduler_type`, and `cfg_type` are the
combo verified to fit this project's 8GB card in docs/ace-step-setup.md
(T-0080): 27 steps, euler, apg. The remaining diffusion knobs default to
ACE-Step's own stock values (`acestep/pipeline_ace_step.py`) -- tune per
recipe as needed, they are not independently VRAM-verified here.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from audio_agent.bus import Bus

# 13-asset-pipeline.md §4.2: no lyrics for a music cue in this design (no
# vocal content specified) -- ACE-Step's API requires the field regardless.
INSTRUMENTAL = "[instrumental]"


@dataclass(frozen=True)
class MusicRecipe:
    prompt: str
    seed: int
    duration: float = 30.0
    lyrics: str = INSTRUMENTAL
    infer_step: int = 27
    guidance_scale: float = 15.0
    scheduler_type: str = "euler"
    cfg_type: str = "apg"
    omega_scale: float = 10.0
    guidance_interval: float = 0.5
    guidance_interval_decay: float = 0.0
    min_guidance_scale: float = 3.0
    use_erg_tag: bool = True
    use_erg_lyric: bool = True
    use_erg_diffusion: bool = True
    oss_steps: list[int] = field(default_factory=list)
    guidance_scale_text: float = 0.0
    guidance_scale_lyric: float = 0.0
    checkpoint: str = "ACE-Step-v1-3.5B"
    bus: Bus = Bus.MUSIC
    name: str = "assembled"
    # TODO(T-0075-equivalent for audio): populate once a hashing step
    # exists for the checkpoint directory on the Windows ACE-Step host
    # (not reachable from WSL for hashing, same constraint comfy-client's
    # Recipe.model_hash documents).
    model_hash: str | None = None

    def __post_init__(self) -> None:
        if not self.prompt.strip():
            raise ValueError("recipe.prompt must not be empty")
        if self.duration <= 0:
            raise ValueError("recipe.duration must be positive")
        if self.infer_step <= 0:
            raise ValueError("recipe.infer_step must be positive")


def recipe_to_dict(recipe: MusicRecipe) -> dict:
    d = asdict(recipe)
    d["bus"] = recipe.bus.value
    return d


def load_recipe(path: str | Path) -> MusicRecipe:
    data = json.loads(Path(path).read_text())
    if "bus" in data:
        data["bus"] = Bus(data["bus"])
    return MusicRecipe(**data)
