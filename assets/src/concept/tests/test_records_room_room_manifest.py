"""T-0243 — Signal Tower / Records Room prop manifest gate (HANDOFF §23-j-b).

Records Room (`signal_tower.records_room`) needs exactly two prop slots per
`docs/design/14-vertical-slice.md` §10: dense archive shelving rows (primary
dressing) and incidental crates. Unlike Ground Relay/Storage Cache/Broadcast
Deck (T-0240/T-0241/T-0242), this room's shelving slot has **no coverage on
the v1 sheet** — T-0239's v2 sheet (`signal_tower_props_concept_sheet_v2.png`)
adds it as PANEL 1's "archive shelving row" (class 1, cover). This card
generates that one new prop (`archive_shelving_v1`) through the committed
cutout path (`tools/comfy-client/src/comfy_client/cutout.py`) against the v2
sheet, and reuses the already-committed `crate_stack_v1` for the second slot.

Gate references:
  - DL-5 / P-6 — concept art precedes generation. The new prop's provenance
    `concept_hash` must resolve to the v2 sheet's own committed concept_hash.
  - P-3 — 16px legibility: >= 15.0 luma16 gap between any cover/hiding pair
    co-located in a room. Both of this room's slots are cover-class, so (like
    Broadcast Deck, T-0242) this room places zero cover/hiding pairs — the
    gate is vacuously satisfied, not skipped.
  - P-7 (amended 2026-08-29) — provenance is required only for props a card
    *newly generates*. `archive_shelving_v1` is new and must carry a full
    cutout-path sidecar (generator resolvable, model_hash non-null, concept_hash
    resolving to the v2 sheet); `crate_stack_v1` is reused as-is.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

from PIL import Image
import pytest

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
MANIFEST_PATH = PROPS_DIR / "records_room.manifest.json"

V2_SHEET_PROV_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.provenance.json"

EXPECTED_GENERATOR = "tools/comfy-client/src/comfy_client/cutout.py"

NEW_PROP_NAME = "archive_shelving_v1"


def _downscale_to_game_16px(data: bytes) -> list[tuple[int, int, int]]:
    """Same game-scale rule as test_signal_tower_prop_pack.py: longest side -> 16px."""
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    w, h = img.size
    max_dim = max(w, h)
    new_w = max(1, round(w * 16 / max_dim))
    new_h = max(1, round(h * 16 / max_dim))
    img_small = img.resize((new_w, new_h), Image.LANCZOS)
    return [(r, g, b) for r, g, b, a in img_small.getdata() if a > 0]


def _mean_luma(pixels: list[tuple[int, int, int]]) -> float:
    if not pixels:
        return 0.0
    return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in pixels) / len(pixels)


@pytest.fixture(scope="session")
def manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"Missing room manifest: {MANIFEST_PATH}"
    return json.loads(MANIFEST_PATH.read_text())


@pytest.fixture(scope="session")
def v2_sheet_concept_hash() -> str:
    assert V2_SHEET_PROV_PATH.exists(), f"Missing v2 sheet provenance: {V2_SHEET_PROV_PATH}"
    return json.loads(V2_SHEET_PROV_PATH.read_text())["concept_hash"]


@pytest.fixture(scope="session")
def new_prop_provenance() -> dict:
    prov_path = PROPS_DIR / f"{NEW_PROP_NAME}.provenance.json"
    assert prov_path.exists(), f"Missing new prop provenance: {prov_path}"
    return json.loads(prov_path.read_text())


# ── Manifest shape ──────────────────────────────────────────────────────────


def test_manifest_identifies_room(manifest):
    assert manifest["room"] == "signal_tower.records_room"


def test_manifest_declares_new_geometry(manifest):
    """Unlike Ground Relay/Storage Cache/Broadcast Deck, this card DOES
    generate new prop geometry (the archive shelving row, DL-5 gated on
    the v2 sheet's class 1 panel)."""
    assert manifest["generated_new_props"] is True


def test_manifest_has_exactly_the_two_slots(manifest):
    slot_names = {s["slot"] for s in manifest["slots"]}
    assert slot_names == {
        "Archive shelving rows (primary dressing)",
        "Incidental crates",
    }


def test_manifest_slots_resolve_to_committed_props(manifest):
    """Every slot -> prop mapping must point at a prop committed under
    assets/final/props/signal_tower/ (new or reused)."""
    for slot in manifest["slots"]:
        assert slot["status"] == "committed"
        prop_png = PROPS_DIR / f"{slot['prop']}.png"
        prop_prov = PROPS_DIR / f"{slot['prop']}.provenance.json"
        assert prop_png.exists(), f"{slot['slot']}: {prop_png} does not exist"
        assert prop_prov.exists(), f"{slot['slot']}: {prop_prov} does not exist"


def test_manifest_slot_classes_match_expected_props(manifest):
    expected = {
        "Archive shelving rows (primary dressing)": ("cover", NEW_PROP_NAME, False),
        "Incidental crates": ("cover", "crate_stack_v1", True),
    }
    for slot in manifest["slots"]:
        exp_class, exp_prop, exp_reused = expected[slot["slot"]]
        assert slot["class"] == exp_class
        assert slot["prop"] == exp_prop
        assert slot["reused"] is exp_reused


def test_manifest_has_no_hiding_class_slots(manifest):
    """This room places no hiding-class prop -- confirms the P-3 cover/hiding
    gate has no pair to check (vacuous, not skipped)."""
    classes = {s["class"] for s in manifest["slots"]}
    assert classes == {"cover"}


def test_manifest_gate_section_records_vacuous_pairing(manifest):
    """The manifest must explicitly record that zero cover/hiding pairs
    exist in this room, rather than silently omitting the gate section or
    fabricating a measurement against a prop this room doesn't place."""
    gate = manifest["gate_16px_separation"]
    assert gate["cover_hide_pairs_in_room"] == []
    assert gate["applicable"] is False


def test_manifest_non_regression_note_present(manifest):
    assert "non_regression" in manifest
    assert manifest["non_regression"]


def test_manifest_concept_coverage_note_present(manifest):
    """DL-5: the manifest must record which sheet/class the new geometry
    was generated against."""
    assert manifest.get("new_prop_concept_sheet") == (
        "assets/src/concept/signal_tower_props_concept_sheet_v2.png"
    )


# ── New prop: DL-5 concept coverage + P-7 provenance ────────────────────────


def test_new_prop_generator_resolves_to_committed_cutout_module(new_prop_provenance):
    generator = new_prop_provenance.get("generator", "")
    resolved = (WORKTREE / generator).resolve()
    assert resolved.is_file(), (
        f"{NEW_PROP_NAME}: generator '{generator}' does not resolve to a "
        f"committed file (expected '{EXPECTED_GENERATOR}')."
    )
    assert generator == EXPECTED_GENERATOR


def test_new_prop_model_hash_non_null(new_prop_provenance):
    model_hash = new_prop_provenance.get("model_hash")
    assert model_hash, f"{NEW_PROP_NAME}: model_hash is null/missing (P-7)."
    assert isinstance(model_hash, str) and len(model_hash) >= 16


def test_new_prop_seed_recorded_and_nonzero(new_prop_provenance):
    seed = new_prop_provenance.get("seed")
    assert isinstance(seed, int) and seed != 0


def test_new_prop_lora_and_env_fields_recorded(new_prop_provenance):
    for field in ("lora_name", "lora_weight", "comfyui_version", "torch_version", "workflow_hash"):
        assert new_prop_provenance.get(field), f"{NEW_PROP_NAME}: missing '{field}'"


def test_new_prop_solid_mask_value_is_opaque(new_prop_provenance):
    assert new_prop_provenance.get("solid_mask_value") == 1.0


def test_new_prop_class_is_cover(new_prop_provenance):
    assert new_prop_provenance.get("prop_class") == "cover"


def test_new_prop_concept_hash_resolves_to_v2_sheet(new_prop_provenance, v2_sheet_concept_hash):
    """DL-5: the new prop's concept_hash must resolve to the approved v2
    sheet's own committed concept_hash -- the sheet that depicts the
    archive shelving row (PANEL 1, class 1)."""
    assert new_prop_provenance.get("concept_hash") == v2_sheet_concept_hash


def test_new_prop_concept_source_points_at_v2_sheet(new_prop_provenance):
    assert new_prop_provenance.get("concept_source") == (
        "assets/src/concept/signal_tower_props_concept_sheet_v2.png"
    )


# ── New prop: sprite format ─────────────────────────────────────────────────


def test_new_prop_png_is_rgba_with_opaque_content(manifest):
    slot = next(s for s in manifest["slots"] if s["prop"] == NEW_PROP_NAME)
    png_path = PROPS_DIR / f"{slot['prop']}.png"
    data = png_path.read_bytes()
    img = Image.open(io.BytesIO(data))
    assert img.mode == "RGBA"
    arr = list(img.convert("RGBA").getdata())
    opaque = [(r, g, b) for r, g, b, a in arr if a > 0]
    assert opaque, f"{NEW_PROP_NAME}: no opaque pixels found."
    unique_colors = len({(r, g, b) for r, g, b in opaque})
    assert unique_colors >= 3, (
        f"{NEW_PROP_NAME}: only {unique_colors} distinct visible colour(s), "
        "image reads as blank/uniform."
    )


# ── Gate measurement re-derivation ──────────────────────────────────────────


def test_manifest_records_no_gate_measurement_fabrication(manifest):
    """With zero cover/hiding pairs, gate_measurements must not be present
    (or must be empty) -- there is nothing real to measure."""
    assert manifest.get("gate_measurements") in (None, {}, [])
