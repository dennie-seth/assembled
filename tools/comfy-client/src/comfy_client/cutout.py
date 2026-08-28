"""RGBA-cutout sprite generation path (T-0220, docs/design/13-asset-pipeline.md §6.15).

Implements the committed, reproducible prop/entity sprite-cutout workflow:
recipe -> generate (LoRA + SolidMask + JoinImageWithAlpha + ImageScale chain) ->
RGBA PNG at game-pixel dimensions + provenance sidecar.

This is the committed recipe that T-0215's signal_tower prop generation
claimed to use but never committed. The ComfyUI node graph is
`templates/sdxl_cutout_lora_v1.json`; `generate_cutout()` here is the single
committed entrypoint that builds and submits it.

Node graph summary (sdxl_cutout_lora_v1.json):
  4  CheckpointLoaderSimple
  12 LoraLoader          <- 4 model+clip
  5  EmptyLatentImage    (gen_width x gen_height -- SDXL generation dimensions)
  6  CLIPTextEncode      (positive) <- 12 clip
  7  CLIPTextEncode      (negative) <- 12 clip
  3  KSampler            <- 12 model, 6, 7, 5
  8  VAEDecode           <- 3, 4 vae
  13 SolidMask           (gen_width x gen_height, ComfyUI-value=1.0-solid_mask_value)
  14 JoinImageWithAlpha  <- 8 image, 13 alpha
  15 ImageScale          <- 14, area method, recipe.width x recipe.height (game dims)
  9  SaveImage           <- 15

IMPORTANT: ComfyUI's JoinImageWithAlpha INVERTS the mask convention:
  SolidMask value=0.0 → alpha=255 (fully opaque) in the output
  SolidMask value=1.0 → alpha=0 (fully transparent) in the output
render_cutout_workflow() compensates by writing `1.0 - solid_mask_value` to
node 13, so solid_mask_value=1.0 (user-facing "fully opaque") correctly
produces alpha=255 in the saved PNG.

`provenance.generator` is set to `"tools/comfy-client/src/comfy_client/cutout.py"`
(repo-relative file path) so the T-0219 resolvability gate can verify this
recipe exists in the repo as a committed file.
"""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import asdict, dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import assert_checkpoint_allowed

from comfy_client.base_url import resolve_base_url
from comfy_client.checkpoint_hash import hash_checkpoint_file
from comfy_client.comfyui_client import ComfyUIClient
from comfy_client.errors import MissingModelHashError
from comfy_client.provenance_sidecar import package_repo_root, write_provenance_sidecar
from comfy_client.recipe import Recipe
from comfy_client.workflow import workflow_hash

CUTOUT_TEMPLATE_NAME = "sdxl_cutout_lora_v1"
DEFAULT_CUTOUT_DIR = Path("assets/out/cutout")

#: Repo-relative file path written to every provenance sidecar.  The T-0219
#: resolvability gate resolves (repo_root / generator) and checks is_file().
GENERATOR_ID = "tools/comfy-client/src/comfy_client/cutout.py"

#: Minimum SDXL-safe generation dimension (must be multiple of 8).
#: Tiny game sprites need to be generated at this minimum size and then
#: scaled down via the ImageScale node to their target game-pixel dimensions.
_SDXL_MIN_DIM = 512


@dataclass(frozen=True)
class CutoutProvenanceRecord:
    """Provenance record for a prop/entity RGBA-cutout sprite (T-0220).

    Extends the base ProvenanceRecord shape with LoRA fields, cutout
    parameters, pinned environment versions (for documentation, not
    enforcement), a `generator` back-reference (T-0219 resolvability),
    and a `sprite_hash` (sha256 of the raw PNG bytes).
    """

    model: str
    model_license: str
    model_hash: str | None
    prompt: str
    negative_prompt: str
    seed: int
    steps: int
    cfg: float
    width: int
    height: int
    workflow_hash: str
    prompt_id: str
    # LoRA
    lora_name: str
    lora_weight: float
    lora_license: str
    # Cutout chain parameters
    solid_mask_value: float
    # Pinned environment at generation time (caller-supplied; not enforced)
    comfyui_version: str | None
    torch_version: str | None
    # Back-reference to this committed module (T-0219 resolvability gate)
    generator: str
    # sha256 of the raw PNG bytes returned by ComfyUI
    sprite_hash: str
    # sha256 of the approved concept sheet this recipe was directionally
    # conditioned on, and its repo-relative path (T-0233, P-7 compliance:
    # generator resolvable + model_hash non-null + concept_hash resolves).
    # None for a cutout with no concept-sheet dependency.
    concept_hash: str | None = None
    concept_source: str | None = None


@dataclass(frozen=True)
class CutoutResult:
    path: Path
    prompt_id: str
    provenance: CutoutProvenanceRecord


def _load_cutout_template() -> dict[str, Any]:
    template_path = resources.files("comfy_client.templates").joinpath(
        f"{CUTOUT_TEMPLATE_NAME}.json"
    )
    return json.loads(template_path.read_text())


def render_cutout_workflow(
    recipe: Recipe,
    lora_name: str,
    lora_weight: float = 0.70,
    solid_mask_value: float = 1.0,
    template: dict[str, Any] | None = None,
    gen_width: int | None = None,
    gen_height: int | None = None,
) -> dict[str, Any]:
    """Render `recipe` + LoRA params into a cutout `/prompt`-ready node graph.

    Uses `sdxl_cutout_lora_v1.json` which adds SolidMask (node 13) +
    JoinImageWithAlpha (node 14) + ImageScale (node 15, area method) after
    VAEDecode to produce RGBA output at game-pixel dimensions.

    `gen_width`/`gen_height` set the SDXL generation dimensions (EmptyLatentImage
    and SolidMask); they default to `recipe.width`/`recipe.height` if not
    provided. For tiny game sprites, pass SDXL-safe generation dimensions
    (e.g., 512×512) and let ImageScale (node 15) resize to `recipe.width`/`height`.

    `solid_mask_value` is the user-facing alpha value (1.0 = fully opaque).
    ComfyUI's JoinImageWithAlpha INVERTS the mask (0.0=opaque, 1.0=transparent),
    so this function writes `1.0 - solid_mask_value` to node 13.

    Returns a fresh dict each call -- the shared template is never mutated.
    """
    tmpl = _load_cutout_template() if template is None else template
    graph = copy.deepcopy(tmpl["graph"])

    # SDXL generation dimensions (may differ from game-pixel output dimensions)
    actual_gen_w = gen_width if gen_width is not None else recipe.width
    actual_gen_h = gen_height if gen_height is not None else recipe.height

    # Checkpoint + LoRA
    graph["4"]["inputs"]["ckpt_name"] = recipe.checkpoint
    graph["12"]["inputs"]["lora_name"] = lora_name
    graph["12"]["inputs"]["strength_model"] = lora_weight
    graph["12"]["inputs"]["strength_clip"] = lora_weight

    # EmptyLatentImage and SolidMask use generation dimensions
    graph["5"]["inputs"]["width"] = actual_gen_w
    graph["5"]["inputs"]["height"] = actual_gen_h
    graph["13"]["inputs"]["width"] = actual_gen_w
    graph["13"]["inputs"]["height"] = actual_gen_h

    # ComfyUI JoinImageWithAlpha inverts the mask: value=0.0→opaque, 1.0→transparent.
    # Invert here so solid_mask_value=1.0 (user-facing "fully opaque") → alpha=255.
    graph["13"]["inputs"]["value"] = 1.0 - solid_mask_value

    # Prompts
    graph["6"]["inputs"]["text"] = recipe.prompt
    graph["7"]["inputs"]["text"] = recipe.negative_prompt

    # Sampler
    graph["3"]["inputs"]["seed"] = recipe.seed
    graph["3"]["inputs"]["steps"] = recipe.steps
    graph["3"]["inputs"]["cfg"] = recipe.cfg
    graph["3"]["inputs"]["sampler_name"] = recipe.sampler
    graph["3"]["inputs"]["scheduler"] = recipe.scheduler

    # ImageScale (node 15) resizes RGBA output to game-pixel dimensions
    graph["15"]["inputs"]["width"] = recipe.width
    graph["15"]["inputs"]["height"] = recipe.height

    # Output filename prefix
    graph["9"]["inputs"]["filename_prefix"] = recipe.name

    return graph


def generate_cutout(
    recipe: Recipe,
    lora_name: str,
    lora_weight: float = 0.70,
    lora_license: str = "Apache-2.0",
    out_dir: str | Path = DEFAULT_CUTOUT_DIR,
    client: GenerationClient | None = None,
    timeout: float = 300.0,
    poll_interval: float = 1.0,
    checkpoint_dir: Path | str | None = None,
    solid_mask_value: float = 1.0,
    comfyui_version: str | None = None,
    torch_version: str | None = None,
    gen_width: int | None = None,
    gen_height: int | None = None,
    concept_hash: str | None = None,
    concept_source: str | None = None,
    extra: dict[str, Any] | None = None,
) -> CutoutResult:
    """recipe + LoRA -> RGBA-cutout PNG at game-pixel dimensions + provenance sidecar.

    The submitted ComfyUI workflow (`sdxl_cutout_lora_v1.json`) generates at
    SDXL-compatible dimensions (`gen_width`×`gen_height`) and then ImageScale
    (node 15, area method) resizes to `recipe.width`×`recipe.height` (game pixels).
    JoinImageWithAlpha (node 14) merges the VAEDecode output with a SolidMask
    so the final PNG is RGBA.

    `gen_width`/`gen_height`: SDXL generation dimensions. Default to
    `max(_SDXL_MIN_DIM, recipe.width)` × `max(_SDXL_MIN_DIM, recipe.height)`,
    rounded to the nearest multiple of 8. Pass explicitly to override.

    `solid_mask_value=1.0` means fully opaque. ComfyUI's JoinImageWithAlpha
    inverts the mask, so this function compensates internally; the provenance
    records the user-facing value (1.0 = fully opaque).

    Raises `CheckpointNotAllowedError` before any network call if
    `recipe.checkpoint` is not on the license allowlist.
    Raises `MissingModelHashError` if neither `checkpoint_dir` nor
    `recipe.model_hash` is provided (T-0151 / HANDOFF §21).

    `comfyui_version` and `torch_version` are recorded in the provenance
    sidecar as documentation of the rig this recipe was proven against;
    they are not enforced at generation time.

    `concept_hash`/`concept_source` record the approved concept sheet this
    recipe was directionally conditioned on (T-0233, P-7 compliance). Not
    enforced at generation time -- callers pass the sheet's own
    `concept_hash` from its `.provenance.json`.

    `extra` merges caller-supplied structured fields (e.g. a recipe layer's
    `prop_class`) into the written sidecar. `CutoutProvenanceRecord` stays
    generic on purpose -- this is the escape hatch for domain-specific
    metadata that has no business on the shared dataclass (T-0233).
    """
    entry = assert_checkpoint_allowed(recipe.checkpoint)

    # Resolve model_hash before any network call (T-0151 / HANDOFF §21).
    if checkpoint_dir is not None:
        ckpt_path = Path(checkpoint_dir) / recipe.checkpoint
        computed_hash = hash_checkpoint_file(ckpt_path)
        recipe = Recipe(**{**asdict(recipe), "model_hash": computed_hash})
    elif recipe.model_hash is None:
        raise MissingModelHashError(
            f"recipe.model_hash is None and checkpoint_dir was not supplied "
            f"(checkpoint: {recipe.checkpoint!r}). "
            "Pass checkpoint_dir= so the file can be hashed, or set "
            "recipe.model_hash to the known SHA-256 of the checkpoint."
        )

    # Compute SDXL-safe generation dimensions if not supplied.
    # SDXL requires at least _SDXL_MIN_DIM in each dimension; dimensions
    # must be multiples of 8 (latent space is 8× downsampled).
    if gen_width is None:
        raw = max(_SDXL_MIN_DIM, recipe.width)
        gen_width = (raw + 7) // 8 * 8
    if gen_height is None:
        raw = max(_SDXL_MIN_DIM, recipe.height)
        gen_height = (raw + 7) // 8 * 8

    graph = render_cutout_workflow(
        recipe,
        lora_name=lora_name,
        lora_weight=lora_weight,
        solid_mask_value=solid_mask_value,
        gen_width=gen_width,
        gen_height=gen_height,
    )
    graph_hash = workflow_hash(graph)

    gen_client = client or ComfyUIClient(base_url=resolve_base_url())

    job_id = gen_client.submit(graph)
    job_result = gen_client.wait_for_completion(
        job_id, timeout=timeout, poll_interval=poll_interval
    )
    raw_bytes = gen_client.fetch_output(job_result)

    sprite_hash = hashlib.sha256(raw_bytes).hexdigest()

    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    image_path = out_dir_path / f"{recipe.name}.png"
    image_path.write_bytes(raw_bytes)

    provenance = CutoutProvenanceRecord(
        model=f"{recipe.checkpoint} + LoRA {lora_name} (weight {lora_weight})",
        model_license=f"{entry.license} (base) / {lora_license} (LoRA)",
        model_hash=recipe.model_hash,
        prompt=recipe.prompt,
        negative_prompt=recipe.negative_prompt,
        seed=recipe.seed,
        steps=recipe.steps,
        cfg=recipe.cfg,
        width=recipe.width,
        height=recipe.height,
        workflow_hash=graph_hash,
        prompt_id=job_id,
        lora_name=lora_name,
        lora_weight=lora_weight,
        lora_license=lora_license,
        solid_mask_value=solid_mask_value,
        comfyui_version=comfyui_version,
        torch_version=torch_version,
        generator=GENERATOR_ID,
        sprite_hash=sprite_hash,
        concept_hash=concept_hash,
        concept_source=concept_source,
    )

    provenance_path = out_dir_path / f"{recipe.name}.provenance.json"
    write_provenance_sidecar(
        provenance_path,
        provenance,
        generator=provenance.generator,
        repo_root=package_repo_root(),
        extra=extra,
    )

    return CutoutResult(path=image_path, prompt_id=job_id, provenance=provenance)
