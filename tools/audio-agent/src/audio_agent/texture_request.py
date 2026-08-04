"""TextureRecipe -> Stable Audio Open `/generate` request rendering (T-0081).

Mirrors `audio_agent.request`'s role for ACE-Step, but the Stable Audio
Open wrapper (`F:/StableAudioOpen/infer-api.py`, docs/stable-audio-setup.md)
takes a flat JSON body of its own shape (`{prompt, negative_prompt,
seconds, steps, seed, cfg, output_path}`) rather than ACE-Step's
`ACEStepInput` schema, so this is a separate straight field mapping
instead of reusing `audio_agent.request.render_request`.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from audio_agent.texture_recipe import TextureRecipe


def render_texture_request(recipe: TextureRecipe, output_filename: str) -> dict[str, Any]:
    """Render `recipe` into a Stable Audio Open `POST /generate`-ready JSON body."""
    return {
        "prompt": recipe.prompt,
        "negative_prompt": recipe.negative_prompt,
        "seconds": recipe.seconds,
        "steps": recipe.steps,
        "cfg": recipe.cfg,
        "seed": recipe.seed,
        "output_path": output_filename,
    }


def texture_request_hash(request: dict[str, Any]) -> str:
    """Deterministic sha256 of a rendered request -- the provenance seam's request
    hash, mirrors audio_agent.request.request_hash."""
    canonical = json.dumps(request, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
