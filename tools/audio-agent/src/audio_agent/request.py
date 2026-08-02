"""MusicRecipe -> ACE-Step `/generate` request rendering (T-0082).

Mirrors `comfy_client.workflow`'s recipe->graph rendering, but ACE-Step's
patched `infer-api.py` (docs/ace-step-setup.md) takes a flat JSON body
(`ACEStepInput`) rather than a node graph, so this is a straight field
mapping instead of a template substitution.

`checkpoint_path` is carried in the payload for schema compatibility with
the patched server's `ACEStepInput` model, but the persistent-pipeline
patch loads the model once at startup and ignores it on a per-request
basis -- see docs/ace-step-setup.md's "Persistent server" section.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from audio_agent.recipe import MusicRecipe

DEFAULT_CHECKPOINT_PATH = "F:/ACE-Step/checkpoints"


def render_request(
    recipe: MusicRecipe,
    output_filename: str,
    checkpoint_path: str = DEFAULT_CHECKPOINT_PATH,
) -> dict[str, Any]:
    """Render `recipe` into an ACE-Step `POST /generate`-ready JSON body."""
    return {
        "checkpoint_path": checkpoint_path,
        "bf16": True,
        "torch_compile": False,
        "device_id": 0,
        "output_path": output_filename,
        "audio_duration": recipe.duration,
        "prompt": recipe.prompt,
        "lyrics": recipe.lyrics,
        "infer_step": recipe.infer_step,
        "guidance_scale": recipe.guidance_scale,
        "scheduler_type": recipe.scheduler_type,
        "cfg_type": recipe.cfg_type,
        "omega_scale": recipe.omega_scale,
        "actual_seeds": [recipe.seed],
        "guidance_interval": recipe.guidance_interval,
        "guidance_interval_decay": recipe.guidance_interval_decay,
        "min_guidance_scale": recipe.min_guidance_scale,
        "use_erg_tag": recipe.use_erg_tag,
        "use_erg_lyric": recipe.use_erg_lyric,
        "use_erg_diffusion": recipe.use_erg_diffusion,
        "oss_steps": recipe.oss_steps,
        "guidance_scale_text": recipe.guidance_scale_text,
        "guidance_scale_lyric": recipe.guidance_scale_lyric,
    }


def request_hash(request: dict[str, Any]) -> str:
    """Deterministic sha256 of a rendered request -- the provenance seam's request hash,
    the audio equivalent of comfy_client.workflow.workflow_hash."""
    canonical = json.dumps(request, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
