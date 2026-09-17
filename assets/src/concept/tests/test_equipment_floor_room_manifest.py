"""T-0245 -- Signal Tower / Equipment Floor room prop manifest gate (HANDOFF §23-j-d).

Equipment Floor (`signal_tower.equipment_floor`) needs two prop slots per
`docs/design/14-vertical-slice.md` §10's row for this room: "Cluttered,
maze-like rack layout" for routing, and "one dedicated hiding spot
(crawlspace) for full protection" -- explicitly noting "Clutter aids
routing, not concealment (cover doesn't block sound)". The Sound (`14` §3)
roams toward noise and has no sight sensor, so cover-class props (sight-cone
block only) do nothing for this room's entity; only the crawlspace's
full-sensor-block hiding class matters here.

**Maze clutter slot -- resolved to `relay_cabinet_v1` + `crate_stack_v1`
(both reused, cover class, already committed from T-0201/T-0221/T-0223).**
`server_rack_v1` is deliberately NOT used here even though the card's own
slot table lists it as a candidate: T-0201's original v1 sheet classifies
the enclosed server rack as a **hiding-spot** prop (`prop_class=hide`,
`test_signal_tower_prop_pack.py::HIDE_PROPS`), not cover, and `14` §10's own
language for this room is explicit that it wants exactly **one** dedicated
hiding spot (the crawlspace) -- placing server_rack_v1 as a second hiding
prop here would contradict "one dedicated hiding spot", and placing it as a
*cover* prop would silently reclassify an already-approved prop, which this
card's own acceptance criteria forbid ("Do not silently reclassify an
approved prop"). Reserving server_rack_v1 out of this room's slot resolution
entirely is the only option that touches neither constraint.

**Crawlspace slot -- resolved to `crawlspace_v1` (new, hiding class).** The
crawlspace does not exist on the v1 sheet and cannot be faked with the
locker (11 §2: the dedicated hiding spot must block all three sensors; The
Sound has no sight sensor so a sight-only cover prop can't substitute).
`signal_tower_props_concept_sheet_v3.png` (T-0257, APPROVED 2026-08-30, PR
#307) depicts a dedicated "CRAWLSPACE OPENING -- HIDING SPOT" sub-panel --
DL-5 concept coverage for exactly this slot -- so this card generates
`crawlspace_v1` through the committed cutout path
(`tools/comfy-client/src/comfy_client/cutout.py`), reusing that sub-panel's
own reviewed prompt text verbatim (only cutout dimensions/seed differ, same
pattern as T-0244's transformer housings).

Gate references:
  - DL-5 / P-6 -- concept art precedes generation. Verified here by resolving
    crawlspace_v1's `concept_hash` against the approved v3 sheet's own sha256.
  - P-3 -- 16px legibility: >= 15.0 luma16 gap between any cover/hiding pair
    co-located in this room. Two pairs: relay_cabinet_v1/crawlspace_v1 and
    crate_stack_v1/crawlspace_v1.
  - P-7 (amended 2026-08-29) -- provenance `concept_hash`/`generator`
    resolvability is required only for crawlspace_v1, the prop this card
    newly generates. relay_cabinet_v1/crate_stack_v1 are reused as-is,
    already provenanced by T-0201/T-0221/T-0223.
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
MANIFEST_PATH = PROPS_DIR / "equipment_floor.manifest.json"
ASSET_PROVENANCE_PATH = WORKTREE / "ASSET_PROVENANCE.md"
V3_SHEET_PATH = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.png"

_MIN_COVER_HIDE_GAP = 15.0

NEW_PROPS = ["crawlspace_v1"]
COVER_PROPS = ["relay_cabinet_v1", "crate_stack_v1"]
HIDING_PROP = "crawlspace_v1"


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
    assert manifest["room"] == "signal_tower.equipment_floor"


def test_manifest_declares_new_geometry(manifest):
    """This card DOES generate new props (the crawlspace)."""
    assert manifest["generated_new_props"] is True


def test_manifest_has_exactly_the_two_slots(manifest):
    slot_names = {s["slot"] for s in manifest["slots"]}
    assert slot_names == {
        "Maze rack clutter",
        "Crawlspace (dedicated hiding spot)",
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
        "slot (the crawlspace) may be generated (DL-5)."
    )


# ── Slot -> prop resolution ──────────────────────────────────────────────────

def test_maze_clutter_slot_resolves_to_reused_cover_props(manifest):
    slot = _slot(manifest, "Maze rack clutter")
    assert slot["class"] == "cover"
    assert slot["status"] == "committed"
    assert slot["reused"] is True
    assert slot["props"] == ["relay_cabinet_v1", "crate_stack_v1"]
    for name in slot["props"]:
        assert (PROPS_DIR / f"{name}.png").exists()
        assert (PROPS_DIR / f"{name}.provenance.json").exists()


def test_server_rack_not_used_in_this_room(manifest):
    """T-0245 acceptance: do not silently reclassify server_rack_v1's approved
    hiding class to cover, and do not place a second hiding prop alongside the
    crawlspace (14 §10 wants exactly one dedicated hiding spot here)."""
    for slot in manifest["slots"]:
        props = slot.get("props") or [slot.get("prop")]
        assert "server_rack_v1" not in props


def test_crawlspace_slot_resolves_to_one_new_hiding_prop(manifest):
    slot = _slot(manifest, "Crawlspace (dedicated hiding spot)")
    assert slot["class"] == "hiding"
    assert slot["status"] == "committed"
    assert slot["reused"] is False
    assert slot["prop"] == "crawlspace_v1"
    assert (PROPS_DIR / "crawlspace_v1.png").exists()
    assert (PROPS_DIR / "crawlspace_v1.provenance.json").exists()


# ── P-7 provenance for the newly-generated prop only ─────────────────────────

def test_new_prop_is_rgba(manifest):  # noqa: ARG001
    for name in NEW_PROPS:
        data = (PROPS_DIR / f"{name}.png").read_bytes()
        img = Image.open(io.BytesIO(data))
        assert img.mode == "RGBA", f"{name}: expected RGBA, got {img.mode}"


def test_new_prop_has_opaque_pixels(manifest):  # noqa: ARG001
    for name in NEW_PROPS:
        data = (PROPS_DIR / f"{name}.png").read_bytes()
        img = Image.open(io.BytesIO(data)).convert("RGBA")
        opaque = [1 for *_, a in img.getdata() if a > 0]
        assert opaque, f"{name}: no opaque pixels -- sprite appears fully transparent."


def test_new_prop_provenance_required_fields(manifest):  # noqa: ARG001
    required = {"model", "model_license", "prompt", "seed", "generator", "concept_hash", "concept_source"}
    for name in NEW_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        missing = required - prov.keys()
        assert not missing, f"{name}.provenance.json missing required fields: {missing}"


def test_new_prop_concept_hash_resolves_to_approved_v3_sheet(manifest, v3_sheet_hash):  # noqa: ARG001
    for name in NEW_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        assert prov["concept_hash"] == v3_sheet_hash, (
            f"{name}: concept_hash does not resolve to the approved v3 sheet's own sha256."
        )
        assert prov["concept_source"] == "assets/src/concept/signal_tower_props_concept_sheet_v3.png"


def test_new_prop_generator_resolves_to_committed_cutout_module(manifest):  # noqa: ARG001
    generator_path = "tools/comfy-client/src/comfy_client/cutout.py"
    for name in NEW_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        assert prov["generator"] == generator_path
        assert (WORKTREE / generator_path).is_file()


def test_new_prop_class_field(manifest):  # noqa: ARG001
    for name in NEW_PROPS:
        prov = json.loads((PROPS_DIR / f"{name}.provenance.json").read_text())
        assert prov["prop_class"] == "hide"


# ── P-3 16px cover/hiding separation gate ────────────────────────────────────

def test_gate_measurements_present_for_both_cover_hiding_pairs(manifest):
    pairs = manifest["gate_16px_separation"]["cover_hide_pairs_in_room"]
    assert {p["cover_prop"] for p in pairs} == set(COVER_PROPS)
    assert all(p["hiding_prop"] == HIDING_PROP for p in pairs)


def test_gate_measurements_match_real_sprites(manifest):
    """Recorded luma16 numbers must match a fresh measurement of the actual
    committed sprites -- guards against the recorded numbers drifting from
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
    assert set(manifest.get("regenerated_props", [])) == set()
