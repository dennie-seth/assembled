"""Ties the whole T-0082/T-0081 arrow together: license gate -> generate
(under the GPU lock) -> save -> descend seam -> provenance
(13-asset-pipeline.md §1, §4.2, §4.5). `generate()` (ACE-Step music) and
`generate_texture()` (Stable Audio Open textures) are what the `audio`
agent and the CLI (`cli.py`) call. Mirrors `comfy_client.pipeline.generate`.

Deliberately stops short of the real descent chain (T-0083) and the
validation gate (T-0102, already built in `tools/asset-gate`) -- this
module only provides the seam those hand off through.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path

from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import assert_checkpoint_allowed

from audio_agent.audio_client import AudioClient
from audio_agent.base_url import resolve_base_url
from audio_agent.descend import descend_stub
from audio_agent.gpu_lock import DEFAULT_LOCK_PATH, gpu_lock
from audio_agent.provenance import (
    ProvenanceRecord,
    build_provenance_record,
    build_texture_provenance_record,
)
from audio_agent.recipe import MusicRecipe
from audio_agent.request import DEFAULT_CHECKPOINT_PATH, render_request
from audio_agent.request import request_hash as compute_request_hash
from audio_agent.stable_audio_base_url import resolve_base_url as resolve_stable_audio_base_url
from audio_agent.stable_audio_client import StableAudioClient
from audio_agent.texture_recipe import TextureRecipe
from audio_agent.texture_request import render_texture_request
from audio_agent.texture_request import texture_request_hash as compute_texture_request_hash

DEFAULT_OUT_DIR = Path("assets/out/audio")


@dataclass(frozen=True)
class GenerationResult:
    path: Path
    job_id: str
    provenance: ProvenanceRecord


def generate(
    recipe: MusicRecipe,
    out_dir: str | Path = DEFAULT_OUT_DIR,
    client: GenerationClient | None = None,
    checkpoint_path: str = DEFAULT_CHECKPOINT_PATH,
    timeout: float = 300.0,
    poll_interval: float = 1.0,
    lock_path: Path = DEFAULT_LOCK_PATH,
    lock_timeout: float | None = None,
) -> GenerationResult:
    """recipe -> generate(under gpu_lock) -> descend(stub) -> provenance.

    Raises `CheckpointNotAllowedError` before ever rendering a request or
    touching `client` if `recipe.checkpoint` isn't on the license allowlist
    -- the T-0082 guardrail is enforced here, not left to the caller.
    """
    assert_checkpoint_allowed(recipe.checkpoint)

    job_id = f"{recipe.name}_{uuid.uuid4().hex}.wav"
    request = render_request(recipe, output_filename=job_id, checkpoint_path=checkpoint_path)
    req_hash = compute_request_hash(request)

    gen_client = client or AudioClient(base_url=resolve_base_url())

    # docs/ace-step-setup.md: this 8GB card cannot fit ACE-Step and ComfyUI
    # at once -- serialize the actual generation call against any other
    # process that also acquires this lock (audio_agent.gpu_lock docstring).
    with gpu_lock(lock_path, timeout=lock_timeout):
        raw_bytes = gen_client.generate(request, timeout=timeout, poll_interval=poll_interval)

    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    raw_path = out_dir_path / job_id
    raw_path.write_bytes(raw_bytes)

    # TODO(T-0083): real descent chain (trim/loop-fold/normalize) replaces this seam.
    final_path = descend_stub(raw_path)

    provenance = build_provenance_record(recipe, request_hash=req_hash, job_id=job_id)

    return GenerationResult(path=final_path, job_id=job_id, provenance=provenance)


def generate_texture(
    recipe: TextureRecipe,
    out_dir: str | Path = DEFAULT_OUT_DIR,
    client: GenerationClient | None = None,
    timeout: float = 120.0,
    poll_interval: float = 1.0,
    lock_path: Path = DEFAULT_LOCK_PATH,
    lock_timeout: float | None = None,
) -> GenerationResult:
    """recipe -> generate(under gpu_lock) -> descend(stub) -> provenance, the
    Stable Audio Open (T-0081) sibling of `generate()` (ACE-Step, T-0082).

    Shares `DEFAULT_LOCK_PATH` with `generate()` -- this 8GB card fits only
    one of ComfyUI/ACE-Step/Stable Audio Open generating at a time
    (docs/stable-audio-setup.md), so both pipeline entry points serialize
    against the same advisory lock regardless of which kicks off first.

    Raises `CheckpointNotAllowedError` before ever rendering a request or
    touching `client` if `recipe.checkpoint` isn't on the license allowlist.
    """
    assert_checkpoint_allowed(recipe.checkpoint)

    job_id = f"{recipe.name}_{uuid.uuid4().hex}.wav"
    request = render_texture_request(recipe, output_filename=job_id)
    req_hash = compute_texture_request_hash(request)

    gen_client = client or StableAudioClient(base_url=resolve_stable_audio_base_url())

    with gpu_lock(lock_path, timeout=lock_timeout):
        raw_bytes = gen_client.generate(request, timeout=timeout, poll_interval=poll_interval)

    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    raw_path = out_dir_path / job_id
    raw_path.write_bytes(raw_bytes)

    # TODO(T-0083): real descent chain (trim/loop-fold/normalize) replaces this seam.
    final_path = descend_stub(raw_path)

    provenance = build_texture_provenance_record(recipe, request_hash=req_hash, job_id=job_id)

    return GenerationResult(path=final_path, job_id=job_id, provenance=provenance)
