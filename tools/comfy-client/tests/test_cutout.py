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
from comfy_client.errors import BackgroundCutoutError, MissingModelHashError
from comfy_client.recipe import Recipe

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


class FakeClient(GenerationClient):
    def __init__(self, prompt_id: str = "fake123", image_bytes: bytes | None = None) -> None:
        self.prompt_id = prompt_id
        # A real, mattable RGBA PNG by default: generate_cutout() now decodes
        # what ComfyUI returned so it can cut the background out (P-6), so an
        # opaque placeholder like b"PNGDATA" is no longer a valid response.
        self.image_bytes = _make_cuttable_rgba_png() if image_bytes is None else image_bytes
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


def _make_cuttable_rgba_png(size: int = 12) -> bytes:
    """A valid RGBA PNG with a distinct subject on a flat background.

    What a real cutout generation returns: a subject the border-seeded matte
    can separate from the surround. `_make_rgba_png`'s uniform fill has no
    background/subject boundary at all, so the matte correctly refuses it.
    """
    img = Image.new("RGBA", (size, size), (18, 17, 14, 255))
    for y in range(size // 4, size - size // 4):
        for x in range(size // 4, size - size // 4):
            img.putpixel((x, y), (220, 60, 40, 255))
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
    """Plumbing only -- background_cutout=False keeps the response byte-exact."""
    client = FakeClient(image_bytes=b"PNGDATA")
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
        background_cutout=False,
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
    """The saved file has both opaque and transparent pixels.

    PR #231 shipped props that were transparent everywhere; T-0221 overcorrected
    to opaque everywhere. Neither is a cutout. The saved sprite must carry real
    subject pixels *and* a real hole where the background was.
    """
    client = FakeClient(image_bytes=_make_cuttable_rgba_png())
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
    alpha_values = list(saved.split()[3].getdata())
    assert any(v > 0 for v in alpha_values), "no opaque pixels -- nothing renders"
    assert any(v == 0 for v in alpha_values), "no transparent pixels -- background is opaque"


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
        background_cutout=False,
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
    # Resolve from this file's repo root (repo root = 3 dirs up from tests/)
    repo_root = Path(__file__).resolve().parents[3]
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
        background_cutout=False,
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["sprite_hash"] == hashlib.sha256(payload).hexdigest()


# ---------------------------------------------------------------------------
# concept_hash / concept_source (T-0233, HANDOFF §23-j, P-7 compliance)
#
# P-7-compliant provenance requires `generator` to resolve, `model_hash` to
# be non-null, AND `concept_hash` to resolve to the approved concept sheet
# that conditioned the asset (docs/decision-log.md DL entry on P-7). The
# cutout path had the first two but never threaded a concept_hash through --
# every T-0221/T-0223 signal_tower prop shipped without one. These tests
# cover the fix: generate_cutout() accepts optional concept_hash/
# concept_source and records both verbatim in the sidecar.
# ---------------------------------------------------------------------------


def test_generate_cutout_concept_hash_recorded_in_sidecar(tmp_path, cutout_recipe):
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
        concept_hash="da676d790f923bcb266225c96445b1be26bec56b0b651befd0c254415fbe87a4",
        concept_source="assets/src/concept/signal_tower_props_concept_sheet_v1.png",
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert (
        on_disk["concept_hash"]
        == "da676d790f923bcb266225c96445b1be26bec56b0b651befd0c254415fbe87a4"
    )
    assert on_disk["concept_source"] == "assets/src/concept/signal_tower_props_concept_sheet_v1.png"


def test_generate_cutout_provenance_object_carries_concept_hash(tmp_path, cutout_recipe):
    client = FakeClient()
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
        concept_hash="c" * 64,
        concept_source="assets/src/concept/some_sheet.png",
    )
    assert result.provenance.concept_hash == "c" * 64
    assert result.provenance.concept_source == "assets/src/concept/some_sheet.png"


def test_generate_cutout_concept_hash_defaults_to_none(tmp_path, cutout_recipe):
    """Callers that don't pass concept_hash still get a well-formed sidecar --
    the field defaults to None rather than being omitted, so downstream P-7
    checks can distinguish 'never wired' from 'not applicable'."""
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
    assert on_disk["concept_hash"] is None
    assert on_disk["concept_source"] is None


# ---------------------------------------------------------------------------
# extra (T-0233, HANDOFF §23-j): caller-supplied domain fields
#
# CutoutProvenanceRecord is deliberately generic -- cutout.py serves any
# RGBA-cutout sprite, not just Signal Tower props. A field like `prop_class`
# (cover vs hide) is domain-specific to one caller's recipe layer, so it has
# no place on the shared dataclass. `extra` lets a caller merge structured
# fields into the written sidecar without generate_cutout() knowing what
# they mean -- the same mechanism write_provenance_sidecar already exposes,
# just threaded through.
# ---------------------------------------------------------------------------


def test_generate_cutout_extra_fields_recorded_in_sidecar(tmp_path, cutout_recipe):
    client = FakeClient()
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=client,
        extra={"prop_class": "cover"},
    )

    sidecar = tmp_path / f"{cutout_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["prop_class"] == "cover"


def test_generate_cutout_extra_defaults_to_no_extra_fields(tmp_path, cutout_recipe):
    """Callers that don't pass extra= get a sidecar with no surprise keys."""
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
    assert "prop_class" not in on_disk


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


# ---------------------------------------------------------------------------
# P-6: the background matte (13-asset-pipeline.md §3.7)
#
# SolidMask is a constant, so the alpha channel the node graph produces is
# uniform and cannot cut anything out. Every T-0221 signal_tower prop shipped
# RGBA with alpha=255 on every pixel. generate_cutout() now mattes the returned
# image itself, on by default.
# ---------------------------------------------------------------------------


def test_matte_runs_by_default_and_clears_the_background(tmp_path, cutout_recipe):
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=FakeClient(),
    )
    saved = Image.open(result.path).convert("RGBA")
    assert saved.getpixel((0, 0))[3] == 0
    assert saved.getpixel((6, 6))[3] == 255


def test_matte_leaves_subject_rgb_untouched(tmp_path, cutout_recipe):
    raw = _make_cuttable_rgba_png()
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=FakeClient(image_bytes=raw),
    )
    before = Image.open(io.BytesIO(raw)).convert("RGBA")
    after = Image.open(result.path).convert("RGBA")
    assert [p[:3] for p in before.getdata()] == [p[:3] for p in after.getdata()]


def test_matte_is_recorded_in_the_sidecar(tmp_path, cutout_recipe):
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=FakeClient(),
    )
    on_disk = json.loads((tmp_path / f"{cutout_recipe.name}.provenance.json").read_text())
    assert on_disk["background_cutout"] is True
    assert on_disk["cutout_tolerance"] == pytest.approx(0.03)
    assert 0.0 < on_disk["cutout_opaque_fraction"] < 1.0
    assert on_disk["output_hash"] != on_disk["sprite_hash"]


def test_sprite_hash_still_fingerprints_the_raw_generation(tmp_path, cutout_recipe):
    """`sprite_hash` keeps its documented meaning; `output_hash` is the file."""
    raw = _make_cuttable_rgba_png()
    result = generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=FakeClient(image_bytes=raw),
    )
    assert result.provenance.sprite_hash == hashlib.sha256(raw).hexdigest()
    assert result.provenance.output_hash == hashlib.sha256(result.path.read_bytes()).hexdigest()


def test_opting_out_records_no_matte_in_the_sidecar(tmp_path, cutout_recipe):
    generate_cutout(
        cutout_recipe,
        lora_name=LORA_NAME,
        lora_weight=LORA_WEIGHT,
        lora_license=LORA_LICENSE,
        out_dir=tmp_path,
        client=FakeClient(),
        background_cutout=False,
    )
    on_disk = json.loads((tmp_path / f"{cutout_recipe.name}.provenance.json").read_text())
    assert on_disk["background_cutout"] is False
    assert on_disk["cutout_tolerance"] is None
    assert on_disk["cutout_opaque_fraction"] is None


def test_edge_to_edge_crop_raises_instead_of_erasing_the_subject(tmp_path, cutout_recipe):
    """The signal_tower prop shape: the subject fills the canvas, no background."""
    with pytest.raises(BackgroundCutoutError):
        generate_cutout(
            cutout_recipe,
            lora_name=LORA_NAME,
            lora_weight=LORA_WEIGHT,
            lora_license=LORA_LICENSE,
            out_dir=tmp_path,
            client=FakeClient(image_bytes=_make_rgba_png(width=8, height=8)),
        )


def test_failed_matte_preserves_the_raw_generation_on_disk(tmp_path, cutout_recipe):
    """A refused matte must not throw away two minutes of GPU time."""
    raw = _make_rgba_png(width=8, height=8)
    with pytest.raises(BackgroundCutoutError):
        generate_cutout(
            cutout_recipe,
            lora_name=LORA_NAME,
            lora_weight=LORA_WEIGHT,
            lora_license=LORA_LICENSE,
            out_dir=tmp_path,
            client=FakeClient(image_bytes=raw),
        )
    assert (tmp_path / f"{cutout_recipe.name}.raw.png").read_bytes() == raw
    assert not (tmp_path / f"{cutout_recipe.name}.png").exists()
