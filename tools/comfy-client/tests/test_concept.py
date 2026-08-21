"""Concept-generation path (T-0104, `docs/design/13-asset-pipeline.md` §6):
recipe -> generate -> commit, deliberately skipping the descend/validate
arm -- concept art is a full-colour, never-indexed SOURCE, not a
shippable asset. Mirrors `test_pipeline.py`'s shape; the differences are
the point (no descend, a concept_hash, and a provenance sidecar written
alongside the image since the output is committed, not gitignored)."""

from __future__ import annotations

import json

import pytest
from gen_client_base.client import GenerationClient
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from comfy_client.concept import (
    generate_concept,
    generate_concept_conditioned,
    generate_concept_conditioned_lora,
    generate_concept_lora,
)
from comfy_client.errors import MissingModelHashError
from comfy_client.recipe import Recipe


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


class FakeConditionedClient(FakeClient):
    """Adds `upload_image` -- not part of the `GenerationClient` ABC, only
    `ComfyUIClient` (and this test double) implement it."""

    def __init__(
        self,
        prompt_id: str = "fake123",
        image_bytes: bytes = b"PNGDATA",
        uploaded_name: str = "template_00001.png",
    ) -> None:
        super().__init__(prompt_id=prompt_id, image_bytes=image_bytes)
        self.uploaded_name = uploaded_name

    def upload_image(self, image_bytes, filename, image_type="input"):
        self.calls.append(("upload", image_bytes, filename, image_type))
        return {"name": self.uploaded_name, "subfolder": "", "type": image_type}


def test_generate_concept_writes_full_colour_image_and_returns_result(tmp_path, sample_recipe):
    client = FakeClient()
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)

    assert result.path.exists()
    assert result.path.read_bytes() == b"PNGDATA"
    assert result.path == tmp_path / f"{sample_recipe.name}.png"
    assert result.prompt_id == "fake123"
    assert [c[0] for c in client.calls] == ["submit", "wait", "fetch"]


def test_generate_concept_does_not_descend(tmp_path, sample_recipe):
    """No downscale/quantize -- the file on disk is exactly the raw SDXL
    output, byte for byte (contrast with `pipeline.generate()`'s descend
    seam)."""
    client = FakeClient(image_bytes=b"RAWFULLCOLOURPNG")
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)
    assert result.path.read_bytes() == b"RAWFULLCOLOURPNG"


def test_generate_concept_writes_provenance_sidecar_with_concept_hash(tmp_path, sample_recipe):
    client = FakeClient(image_bytes=b"PNGDATA")
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)

    sidecar = tmp_path / f"{sample_recipe.name}.provenance.json"
    assert sidecar.exists()
    on_disk = json.loads(sidecar.read_text())

    import hashlib

    expected_hash = hashlib.sha256(b"PNGDATA").hexdigest()
    assert on_disk["concept_hash"] == expected_hash
    assert result.provenance.concept_hash == expected_hash


def test_generate_concept_provenance_matches_recipe(tmp_path, sample_recipe):
    client = FakeClient(prompt_id="p42")
    result = generate_concept(sample_recipe, out_dir=tmp_path, client=client)

    prov = result.provenance
    assert prov.model == sample_recipe.checkpoint
    assert prov.prompt == sample_recipe.prompt
    assert prov.seed == sample_recipe.seed
    assert prov.prompt_id == "p42"
    assert prov.workflow_hash


def test_generate_concept_creates_out_dir_if_missing(tmp_path, sample_recipe):
    out_dir = tmp_path / "nested" / "concept"
    result = generate_concept(sample_recipe, out_dir=out_dir, client=FakeClient())
    assert result.path.exists()
    assert result.path.parent == out_dir


def test_generate_concept_refuses_disallowed_checkpoint_before_any_client_call(tmp_path):
    recipe = Recipe(prompt="x", seed=1, checkpoint="not_on_allowlist.safetensors")
    client = FakeClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate_concept(recipe, out_dir=tmp_path, client=client)
    assert client.calls == []


@pytest.fixture
def init_image_path(tmp_path):
    path = tmp_path / "template.png"
    path.write_bytes(b"TEMPLATEBYTES")
    return path


def test_generate_concept_conditioned_uploads_then_generates(
    tmp_path, sample_recipe, init_image_path
):
    client = FakeConditionedClient()
    result = generate_concept_conditioned(
        sample_recipe, init_image_path=init_image_path, out_dir=tmp_path, client=client
    )

    assert result.path.exists()
    assert result.path.read_bytes() == b"PNGDATA"
    assert [c[0] for c in client.calls] == ["upload", "submit", "wait", "fetch"]

    upload_call = client.calls[0]
    assert upload_call[1] == b"TEMPLATEBYTES"
    assert upload_call[2] == "template.png"


def test_generate_concept_conditioned_wires_uploaded_name_into_workflow(
    tmp_path, sample_recipe, init_image_path
):
    client = FakeConditionedClient(uploaded_name="template_00007.png")
    generate_concept_conditioned(
        sample_recipe, init_image_path=init_image_path, out_dir=tmp_path, client=client
    )

    submitted_graph = client.calls[1][1]
    assert submitted_graph["10"]["inputs"]["image"] == "template_00007.png"


def test_generate_concept_conditioned_concept_hash_is_the_init_image_hash(
    tmp_path, sample_recipe, init_image_path
):
    client = FakeConditionedClient()
    result = generate_concept_conditioned(
        sample_recipe, init_image_path=init_image_path, out_dir=tmp_path, client=client
    )

    import hashlib

    expected_hash = hashlib.sha256(b"TEMPLATEBYTES").hexdigest()
    assert result.provenance.concept_hash == expected_hash
    # Not the output's hash -- the output is different bytes ("PNGDATA").
    assert result.provenance.concept_hash != hashlib.sha256(b"PNGDATA").hexdigest()

    sidecar = tmp_path / f"{sample_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["concept_hash"] == expected_hash
    assert on_disk["conditioning_source"] == str(init_image_path)
    assert on_disk["denoise"] == sample_recipe.denoise


def test_generate_concept_conditioned_records_denoise_from_recipe(tmp_path, init_image_path):
    recipe = Recipe(
        prompt="brutalist concrete wall texture",
        seed=99,
        denoise=0.65,
        name="material_sheet",
        model_hash="b" * 64,
    )
    client = FakeConditionedClient()
    result = generate_concept_conditioned(
        recipe, init_image_path=init_image_path, out_dir=tmp_path, client=client
    )
    assert result.provenance.denoise == 0.65

    submitted_graph = client.calls[1][1]
    assert submitted_graph["3"]["inputs"]["denoise"] == 0.65


def test_generate_concept_conditioned_refuses_disallowed_checkpoint_before_any_client_call(
    tmp_path, init_image_path
):
    recipe = Recipe(prompt="x", seed=1, checkpoint="not_on_allowlist.safetensors")
    client = FakeConditionedClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate_concept_conditioned(
            recipe, init_image_path=init_image_path, out_dir=tmp_path, client=client
        )
    assert client.calls == []


# ---- LoRA-conditioned concept generation (T-0167) ---------------------------


def test_generate_concept_conditioned_lora_writes_png_and_provenance_sidecar(
    tmp_path, sample_recipe, init_image_path
):
    client = FakeConditionedClient()
    result = generate_concept_conditioned_lora(
        sample_recipe,
        init_image_path=init_image_path,
        lora_name="soviet_brutalism_style_v1",
        lora_weight=0.75,
        lora_license="CreativeML Open RAIL++-M",
        base_concept_path=init_image_path,
        out_dir=tmp_path,
        client=client,
    )
    assert result.path.exists()
    assert result.path.read_bytes() == b"PNGDATA"
    sidecar = tmp_path / f"{sample_recipe.name}.provenance.json"
    assert sidecar.exists()


def test_generate_concept_conditioned_lora_provenance_has_lora_keys(
    tmp_path, sample_recipe, init_image_path
):
    import hashlib
    import json

    client = FakeConditionedClient()
    result = generate_concept_conditioned_lora(
        sample_recipe,
        init_image_path=init_image_path,
        lora_name="soviet_brutalism_style_v1",
        lora_weight=0.75,
        lora_license="CreativeML Open RAIL++-M",
        base_concept_path=init_image_path,
        out_dir=tmp_path,
        client=client,
    )
    prov = result.provenance
    assert prov.lora_name == "soviet_brutalism_style_v1"
    assert prov.lora_weight == 0.75
    assert prov.lora_license == "CreativeML Open RAIL++-M"
    expected_base_hash = hashlib.sha256(b"TEMPLATEBYTES").hexdigest()
    assert prov.base_concept_hash == expected_base_hash

    sidecar = tmp_path / f"{sample_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["lora_name"] == "soviet_brutalism_style_v1"
    assert on_disk["lora_weight"] == 0.75
    assert on_disk["lora_license"] == "CreativeML Open RAIL++-M"
    assert on_disk["base_concept_hash"] == expected_base_hash


def test_generate_concept_conditioned_lora_uses_lora_workflow(
    tmp_path, sample_recipe, init_image_path
):
    client = FakeConditionedClient(uploaded_name="template_00001.png")
    generate_concept_conditioned_lora(
        sample_recipe,
        init_image_path=init_image_path,
        lora_name="soviet_brutalism_style_v1",
        lora_weight=0.75,
        lora_license="CreativeML Open RAIL++-M",
        base_concept_path=init_image_path,
        out_dir=tmp_path,
        client=client,
    )
    # The submitted workflow should include a LoraLoader node ("12")
    submitted_graph = client.calls[1][1]
    assert "12" in submitted_graph
    assert submitted_graph["12"]["class_type"] == "LoraLoader"
    assert submitted_graph["12"]["inputs"]["lora_name"] == "soviet_brutalism_style_v1"
    assert submitted_graph["12"]["inputs"]["strength_model"] == 0.75


def test_generate_concept_conditioned_lora_refuses_disallowed_checkpoint(tmp_path, init_image_path):
    recipe = Recipe(prompt="x", seed=1, checkpoint="not_on_allowlist.safetensors")
    client = FakeConditionedClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate_concept_conditioned_lora(
            recipe,
            init_image_path=init_image_path,
            lora_name="test_lora",
            lora_weight=0.75,
            lora_license="CreativeML Open RAIL++-M",
            base_concept_path=init_image_path,
            out_dir=tmp_path,
            client=client,
        )
    assert client.calls == []


# ---- LoRA txt2img concept generation (T-0209) --------------------------------


def test_generate_concept_lora_writes_png_and_provenance_sidecar(tmp_path, sample_recipe):
    client = FakeClient()
    result = generate_concept_lora(
        sample_recipe,
        lora_name="soviet_brutalism_style_v1.safetensors",
        lora_weight=0.70,
        lora_license="Apache-2.0",
        out_dir=tmp_path,
        client=client,
    )
    assert result.path.exists()
    assert result.path.read_bytes() == b"PNGDATA"
    sidecar = tmp_path / f"{sample_recipe.name}.provenance.json"
    assert sidecar.exists()


def test_generate_concept_lora_provenance_has_lora_and_concept_hash_keys(
    tmp_path, sample_recipe
):
    import hashlib

    client = FakeClient(image_bytes=b"PNGDATA")
    result = generate_concept_lora(
        sample_recipe,
        lora_name="soviet_brutalism_style_v1.safetensors",
        lora_weight=0.70,
        lora_license="Apache-2.0",
        out_dir=tmp_path,
        client=client,
    )
    prov = result.provenance
    assert prov.lora_name == "soviet_brutalism_style_v1.safetensors"
    assert prov.lora_weight == 0.70
    assert prov.lora_license == "Apache-2.0"
    expected_hash = hashlib.sha256(b"PNGDATA").hexdigest()
    assert prov.concept_hash == expected_hash

    sidecar = tmp_path / f"{sample_recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["lora_name"] == "soviet_brutalism_style_v1.safetensors"
    assert on_disk["lora_weight"] == 0.70
    assert on_disk["concept_hash"] == expected_hash


def test_generate_concept_lora_uses_lora_txt2img_workflow(tmp_path, sample_recipe):
    client = FakeClient()
    generate_concept_lora(
        sample_recipe,
        lora_name="my_lora.safetensors",
        lora_weight=0.5,
        lora_license="Apache-2.0",
        out_dir=tmp_path,
        client=client,
    )
    submitted_graph = client.calls[0][1]  # ("submit", workflow)
    assert "12" in submitted_graph
    assert submitted_graph["12"]["class_type"] == "LoraLoader"
    assert submitted_graph["12"]["inputs"]["lora_name"] == "my_lora.safetensors"
    assert submitted_graph["12"]["inputs"]["strength_model"] == 0.5
    # txt2img: must have EmptyLatentImage ("5"), must NOT have LoadImage ("10")
    assert "5" in submitted_graph
    assert "10" not in submitted_graph


def test_generate_concept_lora_refuses_disallowed_checkpoint(tmp_path):
    recipe = Recipe(prompt="x", seed=1, checkpoint="not_on_allowlist.safetensors")
    client = FakeClient()
    with pytest.raises(CheckpointNotAllowedError):
        generate_concept_lora(
            recipe,
            lora_name="test_lora",
            lora_weight=0.5,
            lora_license="Apache-2.0",
            out_dir=tmp_path,
            client=client,
        )
    assert client.calls == []


# ---- T-0151/HANDOFF §21: generate_concept_lora must not silently write a
# null model_hash. This is the exact defect T-0209 shipped: a real,
# successful generation whose recipe never had model_hash set (the caller
# built a bare Recipe from a JSON file with no model_hash field), and this
# function used to accept that and write model_hash: null to the sidecar. ----


def test_generate_concept_lora_raises_without_model_hash_or_checkpoint_dir(tmp_path):
    """Recipe with model_hash=None and no checkpoint_dir -- must refuse, not write null."""
    recipe = Recipe(prompt="x", seed=1)  # model_hash defaults to None
    client = FakeClient()
    with pytest.raises(MissingModelHashError):
        generate_concept_lora(
            recipe,
            lora_name="soviet_brutalism_style_v1.safetensors",
            lora_weight=0.70,
            lora_license="Apache-2.0",
            out_dir=tmp_path,
            client=client,
        )
    # The error must fire before any network call -- same guarantee as pipeline.generate().
    assert client.calls == []
    assert not (tmp_path / "assembled.provenance.json").exists()


def test_generate_concept_lora_with_checkpoint_dir_populates_model_hash(tmp_path):
    import hashlib

    ckpt_dir = tmp_path / "checkpoints"
    ckpt_dir.mkdir()
    ckpt_file = ckpt_dir / "sd_xl_base_1.0.safetensors"
    ckpt_file.write_bytes(b"FAKE_CHECKPOINT_BYTES")
    expected_hash = hashlib.sha256(b"FAKE_CHECKPOINT_BYTES").hexdigest()

    recipe = Recipe(prompt="x", seed=1)
    client = FakeClient()
    result = generate_concept_lora(
        recipe,
        lora_name="soviet_brutalism_style_v1.safetensors",
        lora_weight=0.70,
        lora_license="Apache-2.0",
        out_dir=tmp_path / "out",
        client=client,
        checkpoint_dir=ckpt_dir,
    )

    assert result.provenance.model_hash == expected_hash
    sidecar = (tmp_path / "out") / f"{recipe.name}.provenance.json"
    on_disk = json.loads(sidecar.read_text())
    assert on_disk["model_hash"] == expected_hash


def test_generate_concept_lora_with_pre_set_model_hash_uses_it(tmp_path):
    recipe = Recipe(prompt="x", seed=1, model_hash="c" * 64)
    client = FakeClient()
    result = generate_concept_lora(
        recipe,
        lora_name="soviet_brutalism_style_v1.safetensors",
        lora_weight=0.70,
        lora_license="Apache-2.0",
        out_dir=tmp_path,
        client=client,
    )
    assert result.provenance.model_hash == "c" * 64
