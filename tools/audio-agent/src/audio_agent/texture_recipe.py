"""TextureRecipe: the reproducible texture-SFX generation unit
(13-asset-pipeline.md §1, §4.5).

`recipe -> generate -> descend -> validate -> provenance`, the Stable
Audio Open sibling of `audio_agent.recipe.MusicRecipe` (ACE-Step). Scope
is **textures only** -- entity vocalizations, room events, drones
(tasks/T-0081.md); short percussive one-shots (~0.2s footsteps, switches,
doors, pickups) are explicitly out of scope here, since diffusion models
are weak at that duration -- see T-0101's deterministic synthesis script
instead.

Field defaults (`seconds=6.0`, `steps=100`, `cfg=7.0`,
`negative_prompt="music, melody, singing, low quality"`) are the exact
combo verified to fit this project's 8GB card in
`F:/StableAudioOpen/SETUP-NOTES.md` / docs/stable-audio-setup.md (T-0081):
peaked at 3441.7MB allocated / 5177.9MB reserved of 8192MB, ~3GB
headroom -- comfortably the easier of the two backends to run on this
card (vs. ACE-Step's ~243MB headroom).

**Bus defaults (D-20, §4.1):** `Bus.WORLD_SFX` is the default for a
generic "room event" texture. Callers should override explicitly per
§4.5's split: entity vocalizations are gameplay telegraph and must use
`Bus.GAMEPLAY_SFX` (P-5: never ducked); drones/room-tone beds read as
ambience and should use `Bus.AMBIENCE` (duckable). World SFX is the
sensible middle default, not a substitute for picking the right bus per
recipe.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from audio_agent.bus import Bus

# F:/StableAudioOpen/SETUP-NOTES.md's verified test generation used this
# negative prompt to keep texture output free of accidental melody/vocals.
DEFAULT_NEGATIVE_PROMPT = "music, melody, singing, low quality"


@dataclass(frozen=True)
class TextureRecipe:
    prompt: str
    seed: int
    seconds: float = 6.0
    steps: int = 100
    cfg: float = 7.0
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT
    checkpoint: str = "stabilityai/stable-audio-open-1.0"
    bus: Bus = Bus.WORLD_SFX
    name: str = "assembled"
    # TODO(T-0075-equivalent for audio): populate once a hashing step
    # exists for the weights cache on the Windows Stable Audio Open host
    # (not reachable from WSL for hashing, same constraint
    # audio_agent.recipe.MusicRecipe.model_hash documents).
    model_hash: str | None = None

    def __post_init__(self) -> None:
        if not self.prompt.strip():
            raise ValueError("recipe.prompt must not be empty")
        if self.seconds <= 0:
            raise ValueError("recipe.seconds must be positive")
        if self.steps <= 0:
            raise ValueError("recipe.steps must be positive")


def texture_recipe_to_dict(recipe: TextureRecipe) -> dict:
    d = asdict(recipe)
    d["bus"] = recipe.bus.value
    return d


def load_texture_recipe(path: str | Path) -> TextureRecipe:
    data = json.loads(Path(path).read_text())
    if "bus" in data:
        data["bus"] = Bus(data["bus"])
    return TextureRecipe(**data)
