"""T-0221 — signal_tower prop provenance/reproducibility compliance gate.

Verifies that the 5 signal_tower prop sprites have been regenerated through
the committed T-0220 cutout recipe (comfy_client.cutout:generate_cutout /
sdxl_cutout_lora_v1.json) and that every provenance sidecar carries the
fields required by:

  - T-0219 generator-resolvability gate: `generator` must resolve to a
    committed repo file (not a free-text description like the T-0215 bug).
  - T-0151 model_hash gate: `model_hash` must be non-null (exact weights
    must be provable).
  - T-0221 recipe fields: seed, comfyui_version, torch_version, lora_name,
    lora_weight, solid_mask_value all recorded at generation time.
  - T-0201 prop_class: preserved from original acceptance criteria.

These tests are RED before regeneration (current sidecars are T-0201 synth
placeholders with model_hash=null and no generator field) and GREEN after
T-0221's ComfyUI generation run completes.

Design references:
  - docs/design/13-asset-pipeline.md §6.15 (HANDOFF §22-c)
  - tools/comfy-client/src/comfy_client/cutout.py (T-0220 committed recipe)
  - tools/comfy-client/src/comfy_client/templates/sdxl_cutout_lora_v1.json
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
REPO_ROOT = WORKTREE
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"

# Committed T-0220 cutout module path — T-0219 gate resolves this as a file
EXPECTED_GENERATOR = "tools/comfy-client/src/comfy_client/cutout.py"

PROP_FILES = [
    "crate_stack_v1.png",
    "locker_v1.png",
    "low_duct_v1.png",
    "relay_cabinet_v1.png",
    "server_rack_v1.png",
]

EXPECTED_PROP_CLASS = {
    "crate_stack_v1.png": "cover",
    "locker_v1.png": "hide",
    "low_duct_v1.png": "cover",
    "relay_cabinet_v1.png": "cover",
    "server_rack_v1.png": "hide",
}


def _prov(name: str) -> dict:
    """Load provenance sidecar for a prop by PNG filename."""
    sidecar = PROPS_DIR / name.replace(".png", ".provenance.json")
    return json.loads(sidecar.read_text())


# ── Generator resolvability (T-0219 P-7 gate) ────────────────────────────────


@pytest.mark.parametrize("name", PROP_FILES)
def test_generator_field_present(name):
    """Each provenance sidecar must carry a 'generator' field (T-0219 gate)."""
    prov = _prov(name)
    assert "generator" in prov, (
        f"{name}.provenance.json: missing 'generator' field. "
        "Regenerate via comfy_client.cutout:generate_cutout (T-0220)."
    )
    assert prov["generator"], (
        f"{name}.provenance.json: 'generator' is null/empty (T-0219 gate requires "
        "a non-empty repo-relative path)."
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_generator_resolves_to_committed_file(name):
    """generator must resolve to an existing committed file (T-0219 P-7 gate).

    T-0219's check_provenance_generator_resolvable resolves (repo_root / generator)
    and checks is_file(). A Python import path like 'comfy_client.cutout:generate_cutout'
    would FAIL this check; the correct value is a repo-relative file path like
    'tools/comfy-client/src/comfy_client/cutout.py'.
    """
    prov = _prov(name)
    generator = prov.get("generator", "")
    assert generator, f"{name}: generator field is missing or empty"

    resolved = (REPO_ROOT / generator).resolve()
    assert resolved.is_file(), (
        f"{name}.provenance.json: generator '{generator}' does not resolve to "
        f"a committed file under the repo root (T-0219 gate). "
        f"Expected a repo-relative path to T-0220's cutout module, e.g. "
        f"'{EXPECTED_GENERATOR}'."
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_generator_points_to_t0220_cutout_module(name):
    """generator must specifically point at T-0220's committed cutout.py."""
    prov = _prov(name)
    generator = prov.get("generator", "")
    assert generator == EXPECTED_GENERATOR, (
        f"{name}.provenance.json: generator is '{generator}', expected "
        f"'{EXPECTED_GENERATOR}' (T-0220's committed cutout recipe)."
    )


# ── Model hash (T-0151) ───────────────────────────────────────────────────────


@pytest.mark.parametrize("name", PROP_FILES)
def test_model_hash_non_null(name):
    """model_hash must be a non-null, non-empty string (T-0151 gate).

    Current sidecars have model_hash=null (synth placeholder). After
    regeneration via ComfyUI, the hash of sd_xl_base_1.0.safetensors must
    be recorded here.
    """
    prov = _prov(name)
    model_hash = prov.get("model_hash")
    assert model_hash, (
        f"{name}.provenance.json: model_hash is null or missing. "
        "Regenerate via generate_cutout() with checkpoint_dir= set so the "
        "SHA-256 of the checkpoint is computed and stored (T-0151)."
    )
    assert isinstance(model_hash, str) and len(model_hash) >= 16, (
        f"{name}: model_hash '{model_hash}' looks too short to be a real hash."
    )


# ── Recipe fields (seed, version, LoRA, cutout params) ───────────────────────


@pytest.mark.parametrize("name", PROP_FILES)
def test_seed_recorded_and_nonzero(name):
    """seed must be present and non-zero (zero == synth placeholder default).

    T-0201's synthetic sprites all have seed=0 (a sentinel for 'not real').
    A real ComfyUI generation must record the actual KSampler seed used.
    """
    prov = _prov(name)
    assert "seed" in prov, f"{name}.provenance.json: missing 'seed' field"
    seed = prov["seed"]
    assert isinstance(seed, int), f"{name}: seed must be an integer, got {type(seed)}"
    assert seed != 0, (
        f"{name}.provenance.json: seed is 0, which is the synth-placeholder sentinel. "
        "Record the actual seed used in ComfyUI."
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_comfyui_version_recorded(name):
    """comfyui_version must be present in provenance (T-0221 pinned-env requirement)."""
    prov = _prov(name)
    assert "comfyui_version" in prov, (
        f"{name}.provenance.json: missing 'comfyui_version' field. "
        "Record the ComfyUI version at generation time (e.g. '0.29.0')."
    )
    assert prov["comfyui_version"], (
        f"{name}: comfyui_version is null/empty."
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_torch_version_recorded(name):
    """torch_version must be present in provenance (T-0221 pinned-env requirement)."""
    prov = _prov(name)
    assert "torch_version" in prov, (
        f"{name}.provenance.json: missing 'torch_version' field. "
        "Record the PyTorch version at generation time (e.g. '2.5.1+cu121')."
    )
    assert prov["torch_version"], (
        f"{name}: torch_version is null/empty."
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_lora_fields_recorded(name):
    """LoRA name, weight, and license must be in provenance (T-0220 CutoutProvenanceRecord)."""
    prov = _prov(name)
    for field in ("lora_name", "lora_weight"):
        assert field in prov, (
            f"{name}.provenance.json: missing '{field}' field. "
            "generate_cutout() writes these as part of CutoutProvenanceRecord."
        )
    assert prov["lora_name"], f"{name}: lora_name is null/empty"
    assert isinstance(prov["lora_weight"], (int, float)), (
        f"{name}: lora_weight must be numeric"
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_solid_mask_value_recorded(name):
    """solid_mask_value must be recorded — it controls the alpha channel uniformity."""
    prov = _prov(name)
    assert "solid_mask_value" in prov, (
        f"{name}.provenance.json: missing 'solid_mask_value' field. "
        "This is the SolidMask node's value parameter (1.0 = fully opaque)."
    )
    assert prov["solid_mask_value"] == 1.0, (
        f"{name}: solid_mask_value should be 1.0 (fully opaque RGBA cutout)."
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_workflow_hash_recorded(name):
    """workflow_hash must be present (hash of the rendered ComfyUI graph)."""
    prov = _prov(name)
    assert prov.get("workflow_hash"), (
        f"{name}.provenance.json: missing or null 'workflow_hash'. "
        "generate_cutout() computes this from the rendered node graph."
    )


# ── Prop-class preservation (T-0201 requirement) ─────────────────────────────


@pytest.mark.parametrize("name", PROP_FILES)
def test_prop_class_preserved(name):
    """prop_class (cover/hide) must be preserved from T-0201's original design."""
    prov = _prov(name)
    assert "prop_class" in prov, f"{name}.provenance.json: missing 'prop_class'"
    expected = EXPECTED_PROP_CLASS[name]
    assert prov["prop_class"] == expected, (
        f"{name}: prop_class is '{prov['prop_class']}', expected '{expected}'."
    )


# ── Visibility (alpha correctness, no T-0215 alpha=0 regression) ─────────────


@pytest.mark.parametrize("name", PROP_FILES)
def test_png_exists_and_has_nonzero_alpha(name):
    """PNG must exist and not be fully transparent (no T-0215 alpha=0 regression).

    Uses PIL for alpha inspection so real ComfyUI PNGs (with various PNG
    filter types) are correctly decoded, unlike the stdlib parser used in
    the T-0201 test fixture which only handles filter_type=0.
    """
    from PIL import Image
    import numpy as np

    png_path = PROPS_DIR / name
    assert png_path.exists(), f"Missing: {png_path}"

    img = Image.open(png_path).convert("RGBA")
    alpha = np.array(img)[:, :, 3]
    assert int(alpha.max()) > 0, (
        f"{name}: fully transparent (alpha=0 on every pixel). "
        "Re-check that solid_mask_value=1.0 was used in the cutout workflow."
    )


@pytest.mark.parametrize("name", PROP_FILES)
def test_png_has_visible_content(name):
    """PNG must have >= 3 distinct visible colors (not blank/uniform, PR #231 gap)."""
    from PIL import Image
    import numpy as np

    png_path = PROPS_DIR / name
    assert png_path.exists(), f"Missing: {png_path}"

    img = Image.open(png_path).convert("RGBA")
    arr = np.array(img)
    alpha = arr[:, :, 3]
    rgb = arr[:, :, :3]
    visible = rgb[alpha > 0]
    unique_colors = len(np.unique(visible.reshape(-1, 3), axis=0))
    assert unique_colors >= 3, (
        f"{name}: only {unique_colors} distinct visible color(s) "
        "(need >= 3 — image reads as blank/uniform)."
    )
