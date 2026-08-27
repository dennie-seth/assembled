"""Arm B curation gate — T-0229 (HANDOFF §23-e, DL-21).

`docs/design/13-asset-pipeline.md` §6.14 stage 2: instead of conditioning a
general model per generation, train the identity into weights. The first
step of that is curating figure panels out of T-0209's approved player
concept sheet -- this gate validates that curated set and the training
config that will consume it.

RED state: assets/src/character/identity_refs/ absent, manifest absent,
           training_config_player_identity_T0229.toml absent -> every test
           ERRORs or fails its existence assertion.
GREEN state: 12 curated ref PNG+caption pairs exist, all traceable via a
             committed manifest back to T-0209's exact concept sheet
             (concept_hash pinned), and a valid training_config loads via
             lora_train.config.load_config with dataset_dir pointing at the
             curated set and output_dir under assets/final/lora/.

Install: pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
CHARACTER_DIR = REPO_ROOT / "assets" / "src" / "character"
REFS_DIR = CHARACTER_DIR / "identity_refs"
MANIFEST_PATH = CHARACTER_DIR / "identity_curation_manifest_T0229.json"
TRAINING_CONFIG_PATH = CHARACTER_DIR / "training_config_player_identity_T0229.toml"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the same shared reference DL-21 pins for every bake-off arm.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"
TRIGGER_TOKEN = "sbrutalistplayer"
EXPECTED_REF_COUNT = 12


@pytest.fixture(scope="module")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), (
        f"curation manifest not found: {MANIFEST_PATH}\n"
        "Run assets/src/character/curate_identity_panels_T0229.py to produce it."
    )
    return json.loads(MANIFEST_PATH.read_text())


def test_manifest_concept_hash(manifest: dict) -> None:
    """DL-21: every arm's curated/trained material must trace back to T-0209's
    exact approved sheet -- no arm substitutes its own reference."""
    assert manifest.get("concept_hash") == EXPECTED_CONCEPT_HASH, (
        f"manifest concept_hash mismatch:\n  got:      {manifest.get('concept_hash')}\n"
        f"  expected: {EXPECTED_CONCEPT_HASH}"
    )


def test_manifest_source_sheet_resolves(manifest: dict) -> None:
    source = manifest.get("source_sheet")
    assert source, "manifest missing 'source_sheet'"
    resolved = (REPO_ROOT / source).resolve()
    resolved.relative_to(REPO_ROOT.resolve())
    assert resolved.is_file(), f"source_sheet {source!r} does not resolve to a committed file"


def test_manifest_ref_count(manifest: dict) -> None:
    refs = manifest.get("refs", [])
    assert len(refs) == EXPECTED_REF_COUNT, (
        f"expected {EXPECTED_REF_COUNT} curated refs, manifest lists {len(refs)}"
    )


def test_manifest_crop_boxes_within_sheet_bounds(manifest: dict) -> None:
    for ref in manifest["refs"]:
        x0, y0, x1, y1 = ref["crop_box"]
        assert 0 <= x0 < x1 <= 1024, f"{ref['id']}: crop_box x out of [0,1024]: {ref['crop_box']}"
        assert 0 <= y0 < y1 <= 1024, f"{ref['id']}: crop_box y out of [0,1024]: {ref['crop_box']}"


def test_manifest_captions_carry_trigger_token(manifest: dict) -> None:
    for ref in manifest["refs"]:
        assert TRIGGER_TOKEN in ref["caption"], (
            f"{ref['id']}: caption missing trigger token {TRIGGER_TOKEN!r}: {ref['caption']!r}"
        )


def test_ref_files_committed_and_match_manifest(manifest: dict) -> None:
    assert REFS_DIR.exists(), f"curated refs dir not found: {REFS_DIR}"
    for ref in manifest["refs"]:
        png_path = REFS_DIR / f"{ref['id']}.png"
        txt_path = REFS_DIR / f"{ref['id']}.txt"
        assert png_path.exists(), f"missing curated image: {png_path}"
        assert txt_path.exists(), f"missing caption file: {txt_path}"
        assert txt_path.read_text().strip() == ref["caption"], (
            f"{ref['id']}: caption file content does not match manifest caption"
        )


def test_ref_images_are_square() -> None:
    """sd-scripts' default (non-bucketed) dataset path resizes/centre-crops to a
    square -- curated panels are pre-padded to square so the full figure survives
    that step instead of being cropped away."""
    PIL_Image = pytest.importorskip("PIL.Image")
    assert REFS_DIR.exists(), f"curated refs dir not found: {REFS_DIR}"
    pngs = sorted(REFS_DIR.glob("*.png"))
    assert pngs, f"no curated PNGs found under {REFS_DIR}"
    for png_path in pngs:
        with PIL_Image.open(png_path) as img:
            w, h = img.size
        assert w == h, f"{png_path.name}: expected square, got {w}x{h}"


def test_training_config_loads() -> None:
    lora_train_config = pytest.importorskip("lora_train.config")
    assert TRAINING_CONFIG_PATH.exists(), (
        f"training config not found: {TRAINING_CONFIG_PATH}"
    )
    config = lora_train_config.load_config(TRAINING_CONFIG_PATH)
    assert config.output_name == "player_identity_v1"
    assert config.output_dir == "assets/final/lora"
    assert config.dataset_dir == "assets/src/character/identity_refs"
    assert config.output_format == "safetensors"


def test_training_config_dataset_dir_matches_refs_dir() -> None:
    lora_train_config = pytest.importorskip("lora_train.config")
    config = lora_train_config.load_config(TRAINING_CONFIG_PATH)
    assert (REPO_ROOT / config.dataset_dir).resolve() == REFS_DIR.resolve()
