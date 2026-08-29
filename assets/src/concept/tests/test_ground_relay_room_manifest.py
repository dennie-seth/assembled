"""T-0240 — Signal Tower / Ground Relay room prop manifest gate (HANDOFF §23-j-a).

Ground Relay (`signal_tower.ground_relay`) needs exactly two prop slots per
`docs/design/14-vertical-slice.md` §10: one dedicated hiding-spot (teaching
instance) and one incidental cover slot for floor dressing. Both slots are
fully covered by props already committed under
`assets/final/props/signal_tower/` (T-0201/T-0221/T-0223) against the
approved `signal_tower_props_concept_sheet_v1.png` sheet (DL-5) — this card
generates no new prop geometry, it only records the room's slot -> prop
mapping and re-confirms the 16px cover/hiding separation gate for the
specific pair this room places together.

Gate references:
  - DL-5 / P-6 — concept art precedes generation (no new geometry here).
  - P-3 — 16px legibility: >= 15.0 luma16 gap between any cover/hiding pair
    co-located in a room. The full pack's worst-case gap is already proven
    in test_signal_tower_prop_pack.py::test_cover_vs_hiding_distinguishable_at_16px;
    this file re-derives the gap for Ground Relay's actual pair
    (locker_v1 hiding vs crate_stack_v1 cover) and checks it against the
    manifest's own recorded measurement, so the recorded numbers cannot
    silently drift from the real sprites.
  - P-7 (amended 2026-08-29) — provenance is required only for props a card
    *newly generates*. Ground Relay reuses five already-committed,
    already-provenanced props as-is.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
import pytest

WORKTREE = Path(__file__).resolve().parents[4]
PROPS_DIR = WORKTREE / "assets" / "final" / "props" / "signal_tower"
MANIFEST_PATH = PROPS_DIR / "ground_relay.manifest.json"

_MIN_COVER_HIDE_GAP = 15.0


def _downscale_to_game_16px(data: bytes) -> list[tuple[int, int, int]]:
    """Same game-scale rule as test_signal_tower_prop_pack.py: longest side -> 16px."""
    img = Image.open(__import__("io").BytesIO(data)).convert("RGBA")
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


def test_manifest_identifies_room(manifest):
    assert manifest["room"] == "signal_tower.ground_relay"


def test_manifest_declares_no_new_geometry(manifest):
    """This card generates no props — DL-5 has nothing new to check against."""
    assert manifest["generated_new_props"] is False


def test_manifest_has_exactly_the_two_slots(manifest):
    slot_names = {s["slot"] for s in manifest["slots"]}
    assert slot_names == {
        "Dedicated hiding spot (teaching instance)",
        "Incidental floor dressing",
    }


def test_manifest_slots_resolve_to_committed_props(manifest):
    """Every slot -> prop mapping must point at a prop already committed
    under assets/final/props/signal_tower/, referenced (not regenerated)."""
    for slot in manifest["slots"]:
        assert slot["status"] == "committed"
        assert slot["reused"] is True
        prop_png = PROPS_DIR / f"{slot['prop']}.png"
        prop_prov = PROPS_DIR / f"{slot['prop']}.provenance.json"
        assert prop_png.exists(), f"{slot['slot']}: {prop_png} does not exist"
        assert prop_prov.exists(), f"{slot['slot']}: {prop_prov} does not exist"


def test_manifest_slot_classes_match_expected_props(manifest):
    expected = {
        "Dedicated hiding spot (teaching instance)": ("hiding", "locker_v1"),
        "Incidental floor dressing": ("cover", "crate_stack_v1"),
    }
    for slot in manifest["slots"]:
        exp_class, exp_prop = expected[slot["slot"]]
        assert slot["class"] == exp_class
        assert slot["prop"] == exp_prop


def test_manifest_gate_measurement_matches_real_sprites(manifest):
    """The manifest's recorded luma16 numbers must match a fresh measurement
    of the actual committed sprites — guards against the recorded numbers
    drifting from reality if a prop is ever re-tuned."""
    gm = manifest["gate_measurements"]
    cover_png = (PROPS_DIR / "crate_stack_v1.png").read_bytes()
    hide_png = (PROPS_DIR / "locker_v1.png").read_bytes()

    cover_luma = _mean_luma(_downscale_to_game_16px(cover_png))
    hide_luma = _mean_luma(_downscale_to_game_16px(hide_png))
    gap = cover_luma - hide_luma

    assert gm["cover_prop"] == "crate_stack_v1"
    assert gm["hiding_prop"] == "locker_v1"
    assert gm["cover_luma16"] == pytest.approx(cover_luma, abs=0.1)
    assert gm["hiding_luma16"] == pytest.approx(hide_luma, abs=0.1)
    assert gm["gap"] == pytest.approx(gap, abs=0.1)


def test_manifest_gate_measurement_clears_floor(manifest):
    """Ground Relay's actual cover/hiding pair must clear the P-3 floor."""
    gap = manifest["gate_measurements"]["gap"]
    assert gap >= _MIN_COVER_HIDE_GAP, (
        f"Ground Relay pair gap {gap:.1f} is below the required "
        f"{_MIN_COVER_HIDE_GAP} luma16 floor."
    )
