"""Emit the two LUT artifacts T-0105 promises: an N x 1 indexed PNG strip
(what `descend.py`/T-0073 and a shader would sample) and a machine-readable
JSON palette definition (the schema `asset_gate.palette.load_palette`
already expects: `{"slots": [{"index", "hex", "name"}]}`)."""

from __future__ import annotations

from PIL import Image

from palette_extract.extract import PaletteSlot


def build_lut_image(slots: list[PaletteSlot]) -> Image.Image:
    """N x 1 mode-'P' strip; pixel i's index is i, embedded palette is the
    slots' RGB values. Unused palette table entries (index >= N, PIL requires
    a full 256-entry table) are zeroed -- never a used index, so the
    membership/semantics checks never look at them."""
    n = len(slots)
    image = Image.new("P", (n, 1))
    image.putdata(list(range(n)))

    flat_palette = [0] * (256 * 3)
    for slot in slots:
        flat_palette[3 * slot.index : 3 * slot.index + 3] = list(slot.rgb)
    image.putpalette(flat_palette)
    return image


def build_palette_json(slots: list[PaletteSlot], source: str) -> dict:
    return {
        "_comment": (
            "Locked home palette (V-5, P-A resolved), extracted by T-0105 "
            "from the approved interior concept sheet listed in `source`. "
            "Slot order is a value ramp, darkest (0) -> lightest (N-1), by "
            "Oklab lightness -- see palette_extract/extract.py docstring. "
            "Slot indices are load-bearing (P-4 / chroma swap): do not "
            "reorder or renumber if this file is regenerated, only "
            "re-extract and diff."
        ),
        "source": source,
        "slots": [
            {"index": slot.index, "hex": slot.hex, "name": f"ramp-{slot.index:02d}"}
            for slot in slots
        ],
    }
