"""T-0244 — Signal Tower / Power Substation room prop manifest gate (HANDOFF §23-j-c).

Power Substation (`signal_tower.power_substation`) needs three prop slots per
`docs/design/14-vertical-slice.md` §10's row for this room: "Rectangular,
breaker panel along the back wall, 2-3 transformer housings as cover" plus
"one dedicated hiding spot near the panel as a fallback". Unlike Ground
Relay/Storage Cache/Records Room/Broadcast Deck (T-0240/T-0241/T-0243/T-0242),
two of this room's three slots have no coverage on the original approved v1
concept sheet and are genuinely new geometry — the transformer housings and
the breaker panel are load-bearing gameplay objects (14 §4: an explicit
switch-locked gate; DL-18 M4: no safe Watcher crossing without mid-zone
cover), not decoration, and can only be generated once approved concept
coverage exists.

`signal_tower_props_concept_sheet_v3.png` (T-0257) is that coverage: its
`ASSET_PROVENANCE.md` row reads "APPROVED 2026-08-30" (PR #307 propagated
T-0257's board approval verdict), clearing DL-5's human direction-approval
gate for this room's two new-geometry slots. This card generates
`transformer_housing_a_v1`, `transformer_housing_b_v1` (cover) and
`breaker_panel_v1` (gate object, not cover, not hiding — a switch-locked
interactive plate, not something a player can take cover behind) through the
committed cutout path (`tools/comfy-client/src/comfy_client/cutout.py`),
reusing the approved sheet's own reviewed "TRANSFORMER HOUSING A/B" and
"BREAKER PANEL" sub-panel prompts verbatim. The third slot (hiding spot)
reuses the already-committed, already-provenanced `locker_v1` (T-0201/T-0221)
as-is — no regeneration.

Gate references:
  - DL-5 / P-6 — concept art precedes generation. Verified here by resolving
    each new prop's `concept_hash` against the approved v3 sheet's own sha256.
  - P-3 — 16px legibility: >= 15.0 luma16 gap between any cover/hiding pair
    co-located in this room. This room places TWO cover props (both
    transformer housings) alongside ONE hiding prop (locker_v1), so there are
    two pairs to clear — the card's own story calls this "the hardest 16px
    case in the tower" since the housings and the locker share the same
    room. The breaker panel is neither cover nor hiding class and is not
    part of this gate.
  - P-7 (amended 2026-08-29) — provenance `concept_hash`/`generator`
    resolvability is required only for props this card *newly generates*
    (the three above). `locker_v1` is reused as-is, already provenanced by
    T-0201/T-0221.
"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

from PIL import Image
import pytest

WORKTREE = Path(__file__).resolve().parents[4]
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"
MANIFEST_PATH = PROPS_DIR / "power_substation.manifest.json"
ASSET_PROVENANCE_PATH = WORKTREE / "ASSET_PROVENANCE.md"
V3_SHEET_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.png"

_MIN_COVER_HIDE_GAP = 15.0

NEW_PROPS = ["transformer_housing_a_v1", "transformer_housing_b_v1", "breaker_panel_v1"]
COVER_PROPS = ["transformer_housing_a_v1", "transformer_housing_b_v1"]
GATE_PROPS = ["breaker_panel_v1"]
HIDING_PROP = "locker_v1"


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
def v3_sheet_hash() -> str:
    assert V3_SHEET_PATH.exists(), f"Missing approved concept sheet: {V3_SHEET_PATH}"
    return hashlib.sha256(V3_SHEET_PATH.read_bytes()).hexdigest()


# ── Manifest shape ──────────────────────────────────────────────────────────

def test_manifest_identifies_room(manifest):
    assert manifest["room"] == "signal_tower.power_substation"


def test_manifest_declares_new_geometry(manifest):
    """This card DOES generate new props (transformer housings + breaker panel)."""
    assert manifest["generated_new_props"] is True


def test_manifest_has_exactly_the_three_slots(manifest):
    slot_names = {s["slot"] for s in manifest["slots"]}
    assert slot_names == {
        "Transformer housings (x2-3)",
        "Breaker panel (switch-locked gate object)",
        "Dedicated hiding spot near the panel",
    }


def _slot(manifest: dict, name: str) -> dict:
    return next(s for s in manifest["slots"] if s["slot"] == name)


# ── DL-5 concept coverage: the approved sheet exists and is approved ────────

def test_t0257_concept_sheet_is_approved():
    row = next(
        line
        for line in ASSET_PROVENANCE_PATH.read_text().splitlines()
        if line.startswith("| `assets/src/concept/signal_tower_props_concept_sheet_v3.png`")
    )
    assert "APPROVED" in row, (
        "signal_tower_props_concept_sheet_v3.png's ASSET_PROVENANCE.md row "
        "must record a human APPROVED verdict before this room's new-geometry "
        "slots (transformer housings, breaker panel) may be generated (DL-5)."
    )


# ── Slot -> prop resolution ──────────────────────────────────────────────────

def test_transformer_housing_slot_resolves_to_two_new_cover_props(manifest):
    slot = _slot(manifest, "Transformer housings (x2-3)")
    assert slot["class"] == "cover"
    assert slot["status"] == "committed"
    assert slot["reused"] is False
    assert slot["props"] == ["transformer_housing_a_v1", "transformer_housing_b_v1"]
    for name in slot["props"]:
        assert (PROPS_DIR / f"{name}.png").exists()
        assert (PROPS_DIR / f"{name}.provenance.json").exists()


def test_breaker_panel_slot_resolves_to_one_new_gate_prop(manifest):
    slot = _slot(manifest, "Breaker panel (switch-locked gate object)")
    assert slot["class"] == "gate"
    assert slot["status"] == "committed"
    assert slot["reused"] is False
    assert slot["prop"] == "breaker_panel_v1"
    assert (PROPS_DIR / "breaker_panel_v1.png").exists()
    assert (PROPS_DIR / "breaker_panel_v1.provenance.json").exists()


def test_hiding_spot_slot_resolves_to_reused_locker(manifest):
    slot = _slot(manifest, "Dedicated hiding spot near the panel")
    assert slot["class"] == "hiding"
    assert slot["status"] == "committed"
    assert slot["reused"] is True
    assert slot["prop"] == "locker_v1"
    assert (PROPS_DIR / "locker_v1.png").exists()
    assert (PROPS_DIR / "locker_v1.provenance.json").exists()


# ── P-7 provenance for newly-generated props only ────────────────────────────

def test_new_props_are_rgba(manifest):  # noqa: ARG001
    for name in NEW_PROPS:
        data = (PROPS_DIR / f"{name}.png").read_bytes()
        img = Image.open(io.BytesIO(data))
        assert img.mode == "RGBA", f"{name}: expected RGBA, got {img.mode}"


def test_new_props_have_opaque_pixels(manifest):  # noqa: ARG001
    for name in NEW_PROPS:
        data = (PROPS_DIR / f"{name}.png").read_bytes()
        img = Image.open(io.BytesIO(data)).convert("RGBA")
        opaque = [1 for *_, a in img.getdata() if a > 0]
        assert opaque, f"{name}: no opaque pixels — sprite appears fully transparent."


def test_new_props_provenance_required_fields(manifest):  # noqa: ARG001
    required = {"model", "model_license", "prompt", "seed", "generator", "concept_hash", "concept_source"}
    for name in NEW_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        missing = required - prov.keys()
        assert not missing, f"{name}.provenance.json missing required fields: {missing}"


def test_new_props_concept_hash_resolves_to_approved_v3_sheet(manifest, v3_sheet_hash):  # noqa: ARG001
    for name in NEW_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        assert prov["concept_hash"] == v3_sheet_hash, (
            f"{name}: concept_hash does not resolve to the approved v3 sheet's own sha256."
        )
        assert prov["concept_source"] == "assets/src/concept/signal_tower_props_concept_sheet_v3.png"


def test_new_props_generator_resolves_to_committed_cutout_module(manifest):  # noqa: ARG001
    generator_path = "tools/comfy-client/src/comfy_client/cutout.py"
    for name in NEW_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        assert prov["generator"] == generator_path
        assert (WORKTREE / generator_path).is_file()


def test_new_props_prop_class_field(manifest):  # noqa: ARG001
    for name in COVER_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        assert prov["prop_class"] == "cover"
    for name in GATE_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        assert prov["prop_class"] == "gate"


# ── P-3 16px cover/hiding separation gate ────────────────────────────────────

def test_gate_measurements_present_for_both_cover_hiding_pairs(manifest):
    pairs = manifest["gate_16px_separation"]["cover_hide_pairs_in_room"]
    assert {p["cover_prop"] for p in pairs} == set(COVER_PROPS)
    assert all(p["hiding_prop"] == HIDING_PROP for p in pairs)


def test_gate_measurements_match_real_sprites(manifest):
    """Recorded luma16 numbers must match a fresh measurement of the actual
    committed sprites — guards against the recorded numbers drifting from
    reality if a prop is ever re-tuned."""
    hide_png = (PROPS_DIR / f"{HIDING_PROP}.png").read_bytes()
    hide_luma = _mean_luma(_downscale_to_game_16px(hide_png))

    for pair in manifest["gate_16px_separation"]["cover_hide_pairs_in_room"]:
        cover_png = (PROPS_DIR / f"{pair['cover_prop']}.png").read_bytes()
        cover_luma = _mean_luma(_downscale_to_game_16px(cover_png))
        gap = cover_luma - hide_luma

        assert pair["cover_luma16"] == pytest.approx(cover_luma, abs=0.1)
        assert pair["hiding_luma16"] == pytest.approx(hide_luma, abs=0.1)
        assert pair["gap"] == pytest.approx(gap, abs=0.1)


def test_gate_measurements_clear_floor(manifest):
    """Every cover/hiding pair this room places must clear the P-3 floor."""
    for pair in manifest["gate_16px_separation"]["cover_hide_pairs_in_room"]:
        assert pair["gap"] >= _MIN_COVER_HIDE_GAP, (
            f"{pair['cover_prop']} vs {pair['hiding_prop']}: gap {pair['gap']:.1f} "
            f"is below the required {_MIN_COVER_HIDE_GAP} luma16 floor."
        )


def test_gate_16px_separation_applicable(manifest):
    assert manifest["gate_16px_separation"]["applicable"] is True


# ── Non-regression ────────────────────────────────────────────────────────────

def test_non_regression_note_present(manifest):
    assert "non_regression" in manifest
    assert "locker_v1" not in manifest.get("regenerated_props", [])
