"""
T-0152: Verify home_palette.json carries a 'character' annotation that is
internally consistent with its hex values, and that docs/design/05-art-direction.md
§3 does not claim palette components that are absent from the shipped palette.

Implements: docs/design/05-art-direction.md §3 (home palette family spec vs.
shipped palette).

These tests were committed RED before the implementation (T-0152 step 1).
They go GREEN once:
  - home_palette.json gains a "character" block (warm_notes bool)
  - 05-art-direction.md §3 is amended to acknowledge the absence of warm slots
"""

import json
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[4]
PALETTE = REPO / "assets/final/palette/home_palette.json"
ART_DOC = REPO / "docs/design/05-art-direction.md"


def _warm_slot_count(slots: list[dict]) -> int:
    """Count slots with a warm dominant hue (R > G, R > B, chroma > 20)."""
    count = 0
    for slot in slots:
        h = slot["hex"].lstrip("#")
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        chroma = max(r, g, b) - min(r, g, b)
        if chroma > 20 and r > g and r > b:
            count += 1
    return count


def test_palette_has_character_annotation() -> None:
    """home_palette.json must carry a 'character' block added by T-0152."""
    data = json.loads(PALETTE.read_text())
    assert "character" in data, (
        "home_palette.json is missing the 'character' annotation; see T-0152"
    )
    assert "warm_notes" in data["character"], (
        "'character' must include a 'warm_notes' boolean"
    )


def test_character_warm_notes_matches_hex_values() -> None:
    """character.warm_notes must agree with the actual hex values in the palette."""
    data = json.loads(PALETTE.read_text())
    warm_actual = _warm_slot_count(data["slots"])
    warm_claimed = data["character"]["warm_notes"]
    assert warm_claimed == (warm_actual > 0), (
        f"character.warm_notes={warm_claimed!r} but {warm_actual} warm slot(s) found; "
        "re-run palette extraction or correct the annotation"
    )


def test_art_direction_section3_acknowledges_palette_character() -> None:
    """
    05-art-direction.md §3 must not silently claim oxide/rust are a shipped
    palette component when none exist.  After T-0152 the section carries a
    sentinel phrase that notes the absence explicitly.
    """
    data = json.loads(PALETTE.read_text())
    if data["character"]["warm_notes"]:
        return  # warm slots present — no contradiction to check

    doc = ART_DOC.read_text()
    m = re.search(r"## 3\. Palette(.*?)## 4\.", doc, re.DOTALL)
    assert m, "Cannot locate §3 in 05-art-direction.md"
    section3 = m.group(1)

    has_acknowledgement = any(
        phrase in section3.lower()
        for phrase in ("no warm", "absent", "not present", "zero warm", "no oxide")
    )
    assert has_acknowledgement, (
        "05 §3 does not acknowledge the absence of warm/oxide-rust slots in the "
        "shipped home_palette.json.  Amend §3 or re-extract the palette with an "
        "oxide-bearing concept sheet (T-0152)."
    )
