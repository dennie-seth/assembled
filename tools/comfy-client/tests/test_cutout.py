"""RGBA-cutout sprite generation path (T-0220, docs/design/13-asset-pipeline.md §6.15).

Tests for `comfy_client.cutout`, which provides the committed, reproducible
prop/entity sprite-cutout workflow. Mirrors the style of `test_pipeline.py`
and `test_concept.py` -- all tests use a mocked client; no live ComfyUI
required.
"""

from __future__ import annotations

import hashlib
import io
import json

import pytest
from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import CheckpointNotAllowedError
from PIL import Image

from comfy_client.cutout import (
    GENERATOR_ID,
    CutoutProvenanceRecord,
    CutoutResult,
    generate_cutout,
    render_cutout_workflow,
)
from comfy_client.errors import MissingModelHashError
from comfy_client.recipe import Recipe

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


class FakeClient(GenerationClient):
    def __init__(self, prompt_id: str = "fake123", image_bytes: bytes = b"PNGDATA") -> None:
        self.prompt_id = prompt_id
        self.image_bytes = image_bytes
        self.calls: list[tuple] = []

    def submit(self, workflow):
        self.calls.append(("submit", workflow))
        return self.prompt_id

    def wait_for_completion(self, job_id, timeout, poll_interval):
        self.calls.append(("wait", job_id, timeout, poll_interval))
        return {"job_id": job_id}

    def fetch_output(self, job_result):
        self.calls.append(("fetch", job_result))
        return self.image_bytes


def _make_rgba_png(width: int = 4, height: int = 4, alpha: int = 200) -> bytes:
    """Minimal valid RGBA PNG with a uniform, non-zero alpha channel."""
    img = Image.new("RGBA", (width, height), (100, 150, 200, alpha))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def cutout_recipe() -> Recipe:
    return Recipe(
        prompt="flat side-on locker sprite, signal tower interior, RGBA cutout",
        negative_prompt="background, scene, perspective, isometric, 3d render",
        seed=42,
        name="locker_cutout",
        width=512,
        height=512,
        model_hash="a" * 64,
    )


LORA_NAME = "soviet_brutalism_style_v1.safetensors"
LORA_WEIGHT = 0.70
LORA_LICENSE = "Apache-2.0"


# ---------------------------------------------------------------------------
# Basic generation
# ---------------------------------------------------------------------------


def test_generate_cutout_writes_output_and_returns_result(tmp_path, cutout_recipe):
    client = FakeClient()
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )

    assert isinstance(result, CutoutResult)
    assert result.path.exists()
    assert result.path.read_bytes() == b"PNGDATA"
    assert result.path == tmp_path / f"{cutout_recipe.name}.png"
    assert result.prompt_id == "fake123"
    assert [c[0] for c in client.calls] == ["submit", "wait", "fetch"]


def test_generate_cutout_creates_out_dir_if_missing(tmp_path, cutout_recipe):
    out_dir = tmp_path / "nested" / "cutout"
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=out_dir,
        client=FakeClient(),
    )
    assert result.path.exists()
    assert result.path.parent == out_dir


# ---------------------------------------------------------------------------
# Workflow node graph shape
# ---------------------------------------------------------------------------


def test_generate_cutout_submits_workflow_with_lora_node(tmp_path, cutout_recipe):
    """Submitted workflow must include LoraLoader (node '12')."""
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )
    graph = client.calls[0][1]
    assert "12" in graph
    assert graph["12"]["class_type"] == "LoraLoader"
    assert graph["12"]["inputs"]["lora_name"] == LORA_NAME
    assert graph["12"]["inputs"]["strength_model"] == LORA_WEIGHT


def test_generate_cutout_workflow_has_solid_mask_node(tmp_path, cutout_recipe):
    """Submitted workflow must include SolidMask (node '13') for the alpha channel.

    ComfyUI's JoinImageWithAlpha INVERTS the mask (value=0.0→opaque, 1.0→transparent).
    render_cutout_workflow compensates: solid_mask_value=1.0 (user-facing 'fully opaque')
    writes 1.0-1.0=0.0 to node 13's value field, producing alpha=255 in ComfyUI output.
    SolidMask dimensions match the SDXL generation dimensions (gen_width/gen_height),
    which for a recipe.width=512 are max(512,512)=512 each.
    """
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )
    graph = client.calls[0][1]
    assert "13" in graph
    assert graph["13"]["class_type"] == "SolidMask"
    # solid_mask_value=1.0 (fully opaque) → ComfyUI receives 1.0-1.0=0.0 (opaque after inversion)
    assert graph["13"]["inputs"]["value"] == 0.0
    # SolidMask uses gen dimensions (same as recipe.width/height here since both >=512)
    assert graph["13"]["inputs"]["width"] == cutout_recipe.width
    assert graph["13"]["inputs"]["height"] == cutout_recipe.height


def test_generate_cutout_workflow_has_join_image_with_alpha_node(tmp_path, cutout_recipe):
    """Submitted workflow must include JoinImageWithAlpha (node '14')."""
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )
    graph = client.calls[0][1]
    assert "14" in graph
    assert graph["14"]["class_type"] == "JoinImageWithAlpha"


def test_generate_cutout_workflow_feeds_mask_into_join_alpha(tmp_path, cutout_recipe):
    """JoinImageWithAlpha must receive image from VAEDecode and alpha from SolidMask."""
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )
    graph = client.calls[0][1]
    join_inputs = graph["14"]["inputs"]
    assert join_inputs["image"] == ["8", 0]   # VAEDecode output
    assert join_inputs["alpha"] == ["13", 0]  # SolidMask output


def test_generate_cutout_workflow_has_image_scale_node(tmp_path, cutout_recipe):
    """Submitted workflow must include ImageScale (node '15') to resize RGBA to game dims."""
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )
    graph = client.calls[0][1]
    assert "15" in graph
    assert graph["15"]["class_type"] == "ImageScale"
    assert graph["15"]["inputs"]["image"] == ["14", 0]   # input from JoinImageWithAlpha
    assert graph["15"]["inputs"]["upscale_method"] == "area"
    assert graph["15"]["inputs"]["width"] == cutout_recipe.width
    assert graph["15"]["inputs"]["height"] == cutout_recipe.height


def test_generate_cutout_workflow_save_image_reads_from_image_scale(tmp_path, cutout_recipe):
    """SaveImage (node 9) must read from ImageScale (15), not JoinImageWithAlpha (14)."""
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )
    graph = client.calls[0][1]
    assert graph["9"]["inputs"]["images"] == ["15", 0]


def test_render_cutout_workflow_deterministic(cutout_recipe):
    """Same recipe + same LoRA params -> identical graph on every call."""
    g1 = render_cutout_workflow(cutout_recipe, lora_name=LORA_NAME, lora_weight=LORA_WEIGHT)
    g2 = render_cutout_workflow(cutout_recipe, lora_name=LORA_NAME, lora_weight=LORA_WEIGHT)
    assert g1 == g2


def test_render_cutout_workflow_different_seed_gives_different_graph(cutout_recipe):
    recipe2 = Recipe(
        prompt=cutout_recipe.prompt,
        seed=99,
        name=cutout_recipe.name,
        model_hash="a" * 64,
    )
    g1 = render_cutout_workflow(cutout_recipe, lora_name=LORA_NAME, lora_weight=LORA_WEIGHT)
    g2 = render_cutout_workflow(recipe2, lora_name=LORA_NAME, lora_weight=LORA_WEIGHT)
    assert g1 != g2


def test_render_cutout_workflow_solid_mask_value_is_configurable(cutout_recipe):
    # solid_mask_value=0.8 → ComfyUI node 13 receives 1.0-0.8=0.2 (inversion for opaqueness)
    g = render_cutout_workflow(
        cutout_recipe, lora_name=LORA_NAME, lora_weight=LORA_WEIGHT, solid_mask_value=0.8
    )
    assert g["13"]["inputs"]["value"] == pytest.approx(0.2)


# ---------------------------------------------------------------------------
# Alpha coverage: non-zero alpha in the saved output
# ---------------------------------------------------------------------------


def test_generate_cutout_alpha_coverage_nonzero(tmp_path, cutout_recipe):
    """When ComfyUI returns RGBA PNG bytes, the saved file has non-zero alpha coverage.

    The alpha correctness in a live run comes from the SolidMask +
    JoinImageWithAlpha nodes baked into the submitted workflow. Here a
    synthetic RGBA PNG mock response confirms the generation path preserves
    the RGBA data from the client response unchanged.
    """
    rgba_bytes = _make_rgba_png(width=4, height=4, alpha=200)
    client = FakeClient(image_bytes=rgba_bytes)
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )

    saved = Image.open(result.path)
    assert saved.mode == "RGBA"
    _, _, _, alpha_channel = saved.split()
    alpha_values = list(alpha_channel.getdata())
    assert any(v > 0 for v in alpha_values), "all alpha values are zero -- expected non-zero"


# ---------------------------------------------------------------------------
# Provenance sidecar shape
# ---------------------------------------------------------------------------


def test_generate_cutout_writes_provenance_sidecar(tmp_path, cutout_recipe):
    client = FakeClient(image_bytes=b"PNGDATA")
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    assert sidecar.exists()
    on_disk = json.loads(sidecar.read_text())

    # Core fields -- model is the combined "checkpoint + LoRA ..." string
    assert cutout_recipe.checkpoint in on_disk["model"]
    assert LORA_NAME in on_disk["model"]
    assert on_disk["prompt"] == cutout_recipe.prompt
    assert on_disk["seed"] == cutout_recipe.seed
    assert on_disk["prompt_id"] == "fake123"
    assert on_disk["workflow_hash"]

    # LoRA fields
    assert on_disk["lora_name"] == LORA_NAME
    assert on_disk["lora_weight"] == LORA_WEIGHT
    assert on_disk["lora_license"] == LORA_LICENSE

    # Cutout-specific fields
    assert "solid_mask_value" in on_disk
    assert "generator" in on_disk
    assert "sprite_hash" in on_disk
    expected_sprite_hash = hashlib.sha256(b"PNGDATA").hexdigest()
    assert on_disk["sprite_hash"] == expected_sprite_hash

    # Env version fields (None when not supplied)
    assert "comfyui_version" in on_disk
    assert "torch_version" in on_disk


def test_generate_cutout_provenance_matches_result_object(tmp_path, cutout_recipe):
    client = FakeClient(prompt_id="p99")
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )

    prov = result.provenance
    assert isinstance(prov, CutoutProvenanceRecord)
    assert cutout_recipe.checkpoint in prov.model
    assert prov.seed == cutout_recipe.seed
    assert prov.prompt_id == "p99"
    assert prov.lora_name == LORA_NAME
    assert prov.lora_weight == LORA_WEIGHT
    assert prov.lora_license == LORA_LICENSE
    assert prov.generator == GENERATOR_ID


def test_generate_cutout_provenance_generator_field_resolves(tmp_path, cutout_recipe):
    """The 'generator' field in the sidecar must be a repo-relative file path
    that resolves to an existing committed file (T-0219 P-7 resolvability gate:
    check_provenance_generator_resolvable resolves (repo_root / generator) and
    calls is_file()).  GENERATOR_ID is 'tools/comfy-client/src/comfy_client/cutout.py'.
    """
    from pathlib import Path

    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    generator = on_disk["generator"]

    assert generator == GENERATOR_ID, (
        f"generator is {generator!r}, expected repo-relative path {GENERATOR_ID!r}"
    )
    # Resolve from this file's repo root (worktree root = 4 dirs up from tests/)
    repo_root = Path(__file__).resolve().parents[4]
    resolved = repo_root / generator
    assert resolved.is_file(), (
        f"generator '{generator}' does not resolve to a committed file under "
        f"repo root {repo_root} (T-0219 P-7 gate). Expected: {resolved}"
    )


def test_generate_cutout_with_env_versions(tmp_path, cutout_recipe):
    """comfyui_version and torch_version are recorded in the sidecar when passed."""
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
        comfyui_version="0.29.0",
        torch_version="2.4.1+cu124",
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["comfyui_version"] == "0.29.0"
    assert on_disk["torch_version"] == "2.4.1+cu124"


def test_generate_cutout_solid_mask_value_recorded_in_sidecar(tmp_path, cutout_recipe):
    """The solid_mask_value parameter is persisted in the provenance sidecar."""
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
        solid_mask_value=0.85,
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["solid_mask_value"] == 0.85


def test_generate_cutout_sprite_hash_is_sha256_of_output_bytes(tmp_path, cutout_recipe):
    payload = b"SOMERAWPNGBYTES"
    client = FakeClient(image_bytes=payload)
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["sprite_hash"] == hashlib.sha256(payload).hexdigest()


# ---------------------------------------------------------------------------
# License / model_hash guards
# ---------------------------------------------------------------------------


def test_generate_cutout_refuses_disallowed_checkpoint(tmp_path):
    recipe = Recipe(prompt="x", seed=1, checkpoint="not_on_allowlist.safetensors")
    client = FakeClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate_cutout(
            recipe,
            lora_name=LORA_NAME,
            lora_weight=LORA_WEIGHT,
            lora_license=LORA_LICENSE,
            out_dir=tmp_path,
            client=client,
        )
    assert client.calls == []


def test_generate_cutout_raises_missing_model_hash_without_checkpoint_dir(tmp_path):
    recipe = Recipe(prompt="x", seed=1)  # model_hash defaults to None
    client = FakeClient()
    with pytest.raises(MissingModelHashError):
        generate_cutout(
            recipe,
            lora_name=LORA_NAME,
            lora_weight=LORA_WEIGHT,
            lora_license=LORA_LICENSE,
            out_dir=tmp_path,
            client=client,
        )
    assert client.calls == []


def test_generate_cutout_with_checkpoint_dir_populates_model_hash(tmp_path):
    ckpt_dir = tmp_path / "checkpoints"
    ckpt_dir.mkdir()
    ckpt_file = ckpt_dir / "sd_xl_base_1.0.safetensors"
    ckpt_file.write_bytes(b"FAKE_CHECKPOINT_BYTES")
    expected_hash = hashlib.sha256(b"FAKE_CHECKPOINT_BYTES").hexdigest()

    recipe = Recipe(prompt="a locker sprite", seed=1)
    client = FakeClient()
    result = generate_cutout(
        recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path / "out",
        client=client,
        checkpoint_dir=ckpt_dir,
    )
    assert result.provenance.model_hash == expected_hash

    sidecar = (tmp_path / "out") / f"{recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["model_hash"] == expected_hash


def test_generate_cutout_with_pre_set_model_hash_uses_it(tmp_path, cutout_recipe):
    client = FakeClient()
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
    )
    assert result.provenance.model_hash == "a" * 64


def test_generate_cutout_checkpoint_dir_hash_overrides_recipe_model_hash(tmp_path):
    ckpt_dir = tmp_path / "checkpoints"
    ckpt_dir.mkdir()
    ckpt_file = ckpt_dir / "sd_xl_base_1.0.safetensors"
    ckpt_file.write_bytes(b"ACTUAL_BYTES")
    file_hash = hashlib.sha256(b"ACTUAL_BYTES").hexdigest()

    recipe = Recipe(prompt="a locker sprite", seed=1, model_hash="stale_hash" + "0" * 54)
    client = FakeClient()
    result = generate_cutout(
        recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path / "out",
        client=client,
        checkpoint_dir=ckpt_dir,
    )
    assert result.provenance.model_hash == file_hash
