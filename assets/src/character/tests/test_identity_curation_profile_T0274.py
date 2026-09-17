"""Profile-pose identity LoRA curation gate — T-0274.

Per the locked per-pose, per-character/monster LoRA decision (2026-08-31)
and T-0272's finding (four attempts, all front-facing -- `player_identity_v2`
has never seen the character in profile and cannot place one), this card
trains a SEPARATE profile-pose LoRA. Unlike T-0248/T-0229's identity LoRAs,
the training set is [T-0273](T-0273)'s direction-approved, human-sourced
profile reference set (anonymous pose/form reference -- explicitly NOT a
costume match; T-0209 remains the identity authority for costume). This
LoRA teaches the *side-on pose*, meant to be stacked with `player_identity_v2`
(which supplies the costume) at generation time via two distinct trigger
tokens.

RED state: assets/src/character/identity_refs_profile_v1/ absent, manifest
           absent, training_config_player_identity_profile_v1.toml absent ->
           every test ERRORs or fails its existence assertion.
GREEN state: 6 curated ref PNG+caption pairs exist (one per T-0273 kept
             source image), each traceable via a committed manifest back to
             its T-0273 source file and sha256, and a valid training_config
             loads via lora_train.config.load_config with dataset_dir
             pointing at the profile refs and output_dir under
             assets/final/lora/.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
CHARACTER_DIR = REPO_ROOT / "assets" / "src" / "character"
CONCEPT_DIR = REPO_ROOT / "assets" / "src" / "concept"
REFS_DIR = CHARACTER_DIR / "identity_refs_profile_v1"
MANIFEST_PATH = CHARACTER_DIR / "identity_curation_manifest_profile_T0274.json"
TRAINING_CONFIG_PATH = CHARACTER_DIR / "training_config_player_identity_profile_v1.toml"
SELECTION_DOC_PATH = CHARACTER_DIR / "PROFILE_POSE_SELECTION_T0274.md"

TRIGGER_TOKEN = "sbrutalistprofilepose"
EXPECTED_REF_COUNT = 6


@pytest.fixture(scope="module")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), (
        f"curation manifest not found: {MANIFEST_PATH}\n"
        "Run assets/src/character/prepare_profile_refs_T0274.py to produce it."
    )
    return json.loads(MANIFEST_PATH.read_text())


def test_selection_doc_committed() -> None:
    """Acceptance: the per-pose (not per-retrain) design choice, and why the
    training set is anonymous pose reference rather than costume material,
    is recorded -- not just implicit in which files happen to be present."""
    assert SELECTION_DOC_PATH.exists(), f"selection doc not found: {SELECTION_DOC_PATH}"
    text = SELECTION_DOC_PATH.read_text()
    assert "T-0273" in text
    assert "player_identity_v2" in text


def test_manifest_source_card_is_T0273(manifest: dict) -> None:
    assert manifest.get("source_card") == "T-0273"


def test_manifest_ref_count(manifest: dict) -> None:
    refs = manifest.get("refs", [])
    assert len(refs) == EXPECTED_REF_COUNT, (
        f"expected exactly {EXPECTED_REF_COUNT} curated refs "
        f"(T-0273's kept set), manifest lists {len(refs)}"
    )


def test_manifest_captions_carry_trigger_token(manifest: dict) -> None:
    for ref in manifest["refs"]:
        assert TRIGGER_TOKEN in ref["caption"], (
            f"{ref['id']}: caption missing trigger token {TRIGGER_TOKEN!r}: {ref['caption']!r}"
        )


def test_manifest_refs_trace_to_committed_T0273_source(manifest: dict) -> None:
    """Acceptance: trained on T-0273's committed, approved set -- not on
    generated pseudo-profiles. Every ref must resolve to a real committed
    source file under assets/src/concept/ whose sha256 matches T-0273's own
    provenance sidecar."""
    for ref in manifest["refs"]:
        source_file = ref.get("source_file")
        assert source_file, f"{ref['id']}: manifest entry missing 'source_file'"
        resolved = (REPO_ROOT / source_file).resolve()
        resolved.relative_to(REPO_ROOT.resolve())
        assert resolved.is_file(), f"{ref['id']}: source_file does not resolve: {source_file}"
        assert resolved.is_relative_to(CONCEPT_DIR.resolve()), (
            f"{ref['id']}: source_file must be under assets/src/concept/, got {source_file}"
        )

        got_hash = hashlib.sha256(resolved.read_bytes()).hexdigest()
        expected_hash = ref.get("source_sha256")
        assert expected_hash, f"{ref['id']}: manifest entry missing 'source_sha256'"
        assert got_hash == expected_hash, (
            f"{ref['id']}: source_sha256 mismatch:\n  got:      {got_hash}\n"
            f"  expected: {expected_hash}"
        )


def test_manifest_refs_not_front_facing_material(manifest: dict) -> None:
    """Acceptance: not on front-facing material. Every source file must be
    one of T-0273's six kept profile references, not e.g. T-0209's front
    concept sheet or any identity_refs_v2 view."""
    for ref in manifest["refs"]:
        assert Path(ref["source_file"]).name.startswith("player_profile_reference_"), (
            f"{ref['id']}: source_file is not a T-0273 profile reference: {ref['source_file']}"
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
    """sd-scripts' default (non-bucketed) dataset path (same as T-0248's)
    requires square input -- curated images are letterboxed to square so no
    real content is lost or distorted by that step."""
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
    assert TRAINING_CONFIG_PATH.exists(), f"training config not found: {TRAINING_CONFIG_PATH}"
    config = lora_train_config.load_config(TRAINING_CONFIG_PATH)
    assert config.output_name == "player_identity_profile_v1"
    assert config.output_dir == "assets/final/lora"
    assert config.dataset_dir == "assets/src/character/identity_refs_profile_v1"
    assert config.output_format == "safetensors"
    assert config.save_every_n_epochs == 1


def test_training_config_dataset_dir_matches_refs_dir() -> None:
    lora_train_config = pytest.importorskip("lora_train.config")
    config = lora_train_config.load_config(TRAINING_CONFIG_PATH)
    assert (REPO_ROOT / config.dataset_dir).resolve() == REFS_DIR.resolve()


def test_player_identity_v2_left_untouched() -> None:
    """Acceptance: this card is additive -- player_identity_v2 and its
    training set are not touched or regressed."""
    v2_weights = CHARACTER_DIR.parent.parent / "final" / "lora" / "player_identity_v2.safetensors"
    v2_refs_dir = CHARACTER_DIR / "identity_refs_v2"
    assert v2_weights.exists()
    assert v2_refs_dir.exists()
    assert len(list(v2_refs_dir.glob("*.png"))) == 29
