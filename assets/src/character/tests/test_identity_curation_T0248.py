"""Round-2 identity curation gate — T-0248 (HANDOFF §24-a).

Round 1's `player_identity_v1` (T-0237/T-0229) trained on 12 refs cropped
directly from T-0209's sheet — already single-costume, but only two real
camera angles (front/back) before mirroring. This card retrains on a
larger, more view-diverse *generated* set of the same single canonical
costume (`CANONICAL_COSTUME_SELECTION_T0248.md`): 20-30 new SDXL renders,
IP-Adapter conditioned on one fixed anchor panel (`identity_refs/ref_002.png`),
varied by angle/pose prompt and seed, then curated hard for consistency.

RED state: assets/src/character/identity_refs_v2/ absent, manifest absent,
           training_config_player_identity_v2.toml absent -> every test
           ERRORs or fails its existence assertion.
GREEN state: 20-30 curated ref PNG+caption pairs exist, all traceable via a
             committed manifest back to T-0209's sheet and to the single
             fixed anchor panel, and a valid training_config loads via
             lora_train.config.load_config with dataset_dir pointing at the
             curated v2 set and output_dir under assets/final/lora/.

Install: pip install -e ".[dev]" -e ../../../../tools/asset-gate
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
CHARACTER_DIR = REPO_ROOT / "assets" / "src" / "character"
REFS_DIR = CHARACTER_DIR / "identity_refs_v2"
MANIFEST_PATH = CHARACTER_DIR / "identity_curation_manifest_T0248.json"
TRAINING_CONFIG_PATH = CHARACTER_DIR / "training_config_player_identity_v2.toml"
SELECTION_DOC_PATH = CHARACTER_DIR / "CANONICAL_COSTUME_SELECTION_T0248.md"
ANCHOR_REF_PATH = CHARACTER_DIR / "identity_refs" / "ref_002.png"

# SHA-256 of assets/src/concept/player_character_concept_sheet_v1.png (T-0209),
# the same shared reference DL-21 pins for every bake-off arm.
EXPECTED_CONCEPT_HASH = "4f82e3c42dbc0d4ba6960144f6507c5d6dbd7fb0945c54558532d922c9c0251b"
TRIGGER_TOKEN = "sbrutalistplayer"
MIN_REF_COUNT = 20
MAX_REF_COUNT = 30


@pytest.fixture(scope="module")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), (
        f"curation manifest not found: {MANIFEST_PATH}\n"
        "Run assets/src/character/gen_identity_views_T0248.py + curation to produce it."
    )
    return json.loads(MANIFEST_PATH.read_text())


def test_selection_doc_committed() -> None:
    """Acceptance: the canonical-design choice is recorded, not just implicit
    in which crops happened to get used."""
    assert SELECTION_DOC_PATH.exists(), f"selection doc not found: {SELECTION_DOC_PATH}"
    text = SELECTION_DOC_PATH.read_text()
    assert "Selected design" in text
    assert "ref_002" in text


def test_manifest_concept_hash(manifest: dict) -> None:
    """DL-21: every arm's curated/trained material must trace back to T-0209's
    exact approved sheet."""
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


def test_manifest_anchor_ref_is_single_fixed_panel(manifest: dict) -> None:
    """Round 2's hypothesis is that conditioning every new generation off a
    single fixed panel (not several) removes the drift-inducing degree of
    freedom -- exactly one anchor_ref, resolving to the committed v1 crop."""
    anchor = manifest.get("anchor_ref")
    assert anchor, "manifest missing 'anchor_ref'"
    resolved = (REPO_ROOT / anchor).resolve()
    assert resolved == ANCHOR_REF_PATH.resolve(), (
        f"anchor_ref should be the single committed ref_002.png panel, got {anchor!r}"
    )
    assert resolved.is_file()

    expected_hash = hashlib.sha256(ANCHOR_REF_PATH.read_bytes()).hexdigest()
    assert manifest.get("anchor_ref_hash") == expected_hash


def test_manifest_ref_count_in_range(manifest: dict) -> None:
    refs = manifest.get("refs", [])
    assert MIN_REF_COUNT <= len(refs) <= MAX_REF_COUNT, (
        f"expected {MIN_REF_COUNT}-{MAX_REF_COUNT} curated refs, manifest lists {len(refs)}"
    )


def test_manifest_records_dropped_candidates(manifest: dict) -> None:
    """Acceptance: 'what was dropped and why' is documented, not silently
    discarded -- a curation pass that keeps everything it generated hasn't
    curated at all."""
    dropped = manifest.get("dropped", [])
    assert isinstance(dropped, list) and len(dropped) > 0, (
        "manifest 'dropped' must list at least one rejected candidate with a reason "
        "-- curation is supposed to be hard, per the card's acceptance criteria"
    )
    for entry in dropped:
        assert entry.get("reason"), f"dropped candidate missing 'reason': {entry}"


def test_manifest_captions_carry_trigger_token(manifest: dict) -> None:
    for ref in manifest["refs"]:
        assert TRIGGER_TOKEN in ref["caption"], (
            f"{ref['id']}: caption missing trigger token {TRIGGER_TOKEN!r}: {ref['caption']!r}"
        )


def test_manifest_refs_share_one_costume_descriptor(manifest: dict) -> None:
    """Every kept ref must describe the same costume -- the whole point of
    this card. costume_id is a manifest-level field, not per-ref, so there is
    no way for two refs to silently disagree."""
    costume_id = manifest.get("costume_id")
    assert costume_id, "manifest missing top-level 'costume_id'"
    for ref in manifest["refs"]:
        assert ref.get("costume_id") == costume_id, (
            f"{ref['id']}: costume_id {ref.get('costume_id')!r} != manifest costume_id {costume_id!r}"
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
    square -- curated images are square so no real content is lost to that step."""
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
    assert config.output_name == "player_identity_v2"
    assert config.output_dir == "assets/final/lora"
    assert config.dataset_dir == "assets/src/character/identity_refs_v2"
    assert config.output_format == "safetensors"
    assert config.save_every_n_epochs == 1


def test_training_config_dataset_dir_matches_refs_dir() -> None:
    lora_train_config = pytest.importorskip("lora_train.config")
    config = lora_train_config.load_config(TRAINING_CONFIG_PATH)
    assert (REPO_ROOT / config.dataset_dir).resolve() == REFS_DIR.resolve()


def test_v1_dataset_and_manifest_left_intact() -> None:
    """Acceptance: v2 is an addition, not a replacement -- round 1 stays
    reproducible."""
    v1_manifest = CHARACTER_DIR / "identity_curation_manifest_T0229.json"
    v1_refs_dir = CHARACTER_DIR / "identity_refs"
    assert v1_manifest.exists()
    assert v1_refs_dir.exists()
    assert len(list(v1_refs_dir.glob("*.png"))) == 12
