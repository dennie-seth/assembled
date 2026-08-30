"""T-0257 -- Signal Tower props concept sheet v3 artifact gate (HANDOFF §23, track 2).

`docs/design/14-vertical-slice.md` §10 requires prop geometry for four room
dressings the v1 props sheet (T-0211) does not depict: Records Room archive
shelving, Power Substation transformer housings + breaker panel, Equipment
Floor crawlspace, and Antenna Shaft hiding alcove. T-0239 tried to cover this
gap with `signal_tower_props_concept_sheet_v2.png` and was declined by
@DennieSeth on 2026-08-29: v2's prop geometry was drawn deterministically by
`_composite_props_v2.py`, not generated -- a synthetic composite cannot
satisfy DL-5/P-6 as a generation reference for the four blocked room cards
([T-0243]-[T-0246]).

This card (T-0257) replaces v2 as the rooms' approval gate with a REAL
generated sheet, `signal_tower_props_concept_sheet_v3.png`: pure txt2img +
`soviet_brutalism_style_v1` LoRA through the committed T-0104 concept
workflow (same generation method v1 itself used -- see the recipe's
`_generator_note` -- chosen deliberately over v2's img2img-on-v1 path, which
T-0239's own provenance records as having reproduced v1's own prop
vocabulary instead of drawing the four new classes at denoise=0.88).

Unlike `test_signal_tower_props_concept_sheet_v2.py`, this file does **not**
import `_composite_props_v2.py` and does **not** assert against a
deterministic LAYOUT dict -- there is no compositing script in this card's
generation path (acceptance criterion: "no prop geometry originates from
compositing or script drawing, and `_composite_props_v2.py` is not used or
imported"). Pixel checks below instead inspect the four panel *quadrants*
this card's own recipe/prompt commits to (2x2 grid, same MARGIN/GUTTER
convention as v1/v2's synthetic panel layout), checking for real generated
variance (not blank canvas) and the T-0223-style +15 luma cover-vs-hiding
gate -- against the actual committed PNG's pixels, not just its provenance
prose.

There is deliberately **no** autouse synthetic-fallback fixture here (unlike
`conftest.py`'s `ensure_signal_tower_props_concept_sheet*` fixtures for
v1/entities/player sheets): a script-drawn placeholder is exactly the
anti-pattern this card exists to replace. If the real PNG is missing, these
tests fail -- that is the correct RED state until real generation has run.

PNG inspection uses stdlib (struct) only for format checks; Pillow is used
only for the pixel-content/luma checks (already a project test dependency,
`assets/src/concept/pyproject.toml`).
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import pytest
from PIL import Image

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"

V1_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.png"
V1_PROVENANCE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.provenance.json"
V1_RECIPE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.recipe.json"

V3_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.png"
V3_PROVENANCE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.provenance.json"
V3_RECIPE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v3.recipe.json"

_PNG_SIG = b"\x89PNG\r\n\x1a\n"

# Panel-quadrant contract this card's own recipe/prompt commits to (2x2 grid,
# same MARGIN/GUTTER convention v1/v2's synthetic layouts used). Not read
# from any generator module -- this file IS the committed contract for where
# each prop class is expected to land.
_MARGIN, _GUTTER = 16, 8
_PW = _PH = (1024 - 2 * _MARGIN - _GUTTER) // 2  # 492
_CAPTION_BAND = 40  # bottom strip reserved for typeset captions, excluded from measurement


def _quadrant_box(row: int, col: int) -> tuple:
    x0 = _MARGIN + col * (_PW + _GUTTER)
    y0 = _MARGIN + row * (_PH + _GUTTER)
    x1 = x0 + _PW - 1
    y1 = y0 + _PH - 1 - _CAPTION_BAND
    return (x0, y0, x1, y1)


ARCHIVE_SHELVING_BOX = _quadrant_box(0, 0)  # top-left -- cover
TRANSFORMER_BREAKER_BOX = _quadrant_box(0, 1)  # top-right -- cover + gate object
CRAWLSPACE_BOX = _quadrant_box(1, 0)  # bottom-left -- hiding
ALCOVE_BOX = _quadrant_box(1, 1)  # bottom-right -- hiding


def _parse_png_ihdr(data: bytes) -> dict:
    assert data[:8] == _PNG_SIG, "Not a valid PNG (bad signature)"
    chunk_len = struct.unpack(">I", data[8:12])[0]
    chunk_type = data[12:16]
    assert chunk_type == b"IHDR", f"First chunk is {chunk_type!r}, expected IHDR"
    assert chunk_len == 13, f"IHDR length {chunk_len}, expected 13"
    ihdr = data[16:29]
    width, height = struct.unpack(">II", ihdr[0:8])
    return {
        "width": width,
        "height": height,
        "bit_depth": ihdr[8],
        "colour_type": ihdr[9],
    }


def _luma(rgb: tuple) -> float:
    r, g, b = rgb[:3]
    return 0.299 * r + 0.587 * g + 0.114 * b


def _region_luma_mean(img: Image.Image, box: tuple) -> float:
    pixels = list(img.crop(box).getdata())
    return sum(_luma(p) for p in pixels) / len(pixels)


def _region_distinct_colour_count(img: Image.Image, box: tuple) -> int:
    return len(set(img.crop(box).getdata()))


@pytest.fixture(scope="session")
def v3_bytes() -> bytes:
    assert V3_PNG.exists(), (
        f"Missing signal tower props concept sheet v3: {V3_PNG}. This is not "
        "auto-generated by a fallback fixture -- a script-drawn placeholder is "
        "exactly what this card replaces. Real generation must have run first."
    )
    return V3_PNG.read_bytes()


@pytest.fixture(scope="session")
def v3_image(v3_bytes) -> Image.Image:  # noqa: ARG001
    return Image.open(V3_PNG).convert("RGB")


@pytest.fixture(scope="session")
def v3_provenance(v3_bytes) -> dict:  # noqa: ARG001
    return json.loads(V3_PROVENANCE.read_text())


@pytest.fixture(scope="session")
def v3_recipe() -> dict:
    return json.loads(V3_RECIPE.read_text())


@pytest.fixture(scope="session")
def v1_provenance() -> dict:
    return json.loads(V1_PROVENANCE.read_text())


@pytest.fixture(scope="session")
def v1_recipe() -> dict:
    return json.loads(V1_RECIPE.read_text())


# ── Existence + format gates ─────────────────────────────────────────────


def test_v3_concept_png_exists(v3_bytes):  # noqa: ARG001
    assert V3_PNG.exists()


def test_v3_concept_full_colour(v3_bytes):
    meta = _parse_png_ihdr(v3_bytes)
    assert meta["colour_type"] == 2, (
        f"Expected PNG colour_type 2 (RGB truecolour), got {meta['colour_type']}. "
        "colour_type 3 = indexed (mode P) -- concept sheets must NOT be indexed."
    )
    assert meta["bit_depth"] == 8


def test_v3_concept_resolution(v3_bytes):
    meta = _parse_png_ihdr(v3_bytes)
    assert meta["width"] == 1024
    assert meta["height"] == 1024


# ── Provenance gates ─────────────────────────────────────────────────────


def test_v3_provenance_exists(v3_provenance):
    assert isinstance(v3_provenance, dict)


def test_v3_provenance_required_fields(v3_provenance):
    required = {
        "model",
        "model_license",
        "model_hash",
        "prompt",
        "negative_prompt",
        "seed",
        "concept_hash",
        "generator",
        "workflow_hash",
        "prompt_id",
    }
    missing = required - v3_provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_v3_provenance_model_hash_non_null(v3_provenance):
    """P-7: a concept sheet's model_hash must be a real value, not null (HANDOFF §21)."""
    assert v3_provenance.get("model_hash"), "model_hash must be non-null"


def test_v3_provenance_concept_hash_matches(v3_bytes, v3_provenance):
    expected = hashlib.sha256(v3_bytes).hexdigest()
    actual = v3_provenance.get("concept_hash", "")
    assert actual == expected, (
        f"concept_hash mismatch.\n  provenance says: {actual}\n  file sha256 is:  {expected}"
    )


def test_v3_provenance_generator_resolves_to_committed_code(v3_provenance):
    """P-7: generator must resolve to a committed file, no generator_baseline.txt exemption."""
    generator = v3_provenance.get("generator", "")
    assert generator, "Provenance must declare a generator (P-7)"
    candidate = generator.split()[0]
    resolved = WORKTREE / candidate
    assert resolved.exists(), (
        f"generator field {generator!r} does not resolve to a committed file (looked for {resolved})"
    )


def test_v3_provenance_generator_is_not_composite_script(v3_provenance):
    """Acceptance: `_composite_props_v2.py` is not used or imported by this card."""
    generator = v3_provenance.get("generator", "")
    assert "_composite_props_v2" not in generator, (
        f"generator {generator!r} must not be the v2 compositing script -- every prop's "
        "geometry in this card must be model-generated, not composited."
    )


def test_v3_provenance_not_in_generator_baseline_exemption_list():
    """Acceptance: no generator_baseline.txt exemption for this sheet."""
    baseline = CONCEPT_DIR.parents[1] / "tools" / "asset-gate" / "generator_baseline.txt"
    if not baseline.exists():
        return
    text = baseline.read_text()
    assert "signal_tower_props_concept_sheet_v3" not in text, (
        "v3 provenance must resolve its own generator directly, not via a "
        "generator_baseline.txt exemption."
    )


def test_v3_workflow_hash_present_and_well_formed(v3_provenance):
    """workflow_hash is a sha256 hex digest of the rendered ComfyUI graph."""
    workflow_hash = v3_provenance.get("workflow_hash", "")
    assert len(workflow_hash) == 64
    int(workflow_hash, 16)  # raises ValueError if not hex


def test_v3_prompt_id_present(v3_provenance):
    """Acceptance: the ComfyUI prompt_id must be recorded as generation evidence."""
    assert v3_provenance.get("prompt_id"), "prompt_id must be recorded (real ComfyUI generation evidence)"


def test_v3_recipe_exists():
    assert V3_RECIPE.exists()


def test_v3_recipe_required_fields(v3_recipe):
    required = {"prompt", "negative_prompt", "seed", "checkpoint", "width", "height", "name"}
    missing = required - v3_recipe.keys()
    assert not missing, f"Recipe missing required fields: {missing}"


# ── Continuity requirements ("extends v1's own recipe") ───────────────────


def test_v3_recipe_extends_v1_checkpoint(v3_recipe, v1_recipe):
    assert v3_recipe["checkpoint"] == v1_recipe["checkpoint"], (
        "v3 must use the same checkpoint as v1 -- same vocabulary, not a new art style."
    )


def test_v3_recipe_extends_v1_lora(v3_recipe, v1_recipe):
    assert v3_recipe["lora"] == v1_recipe["lora"], "v3 must reuse v1's style LoRA."
    assert v3_recipe["lora_strength"] == v1_recipe["lora_strength"], (
        "v3 must reuse v1's LoRA weight exactly (same style lock)."
    )


def test_v3_every_generation_uses_the_declared_lora_weight(v3_recipe):
    """Acceptance criterion 4 ("same checkpoint, style LoRA, palette language,
    framing") is a claim about every real generation this sheet submits, not
    just the recipe's top-level declared field -- a sub-panel can override
    its own effective weight (`generate_sub_panel`'s `lora_strength` escape
    hatch) without the top-level `lora_strength` changing at all, which is
    exactly how the previous cut of this sheet shipped one sub-generation at
    LoRA weight 0.0 (an entirely different visual vocabulary from the rest
    of the sheet) while `test_v3_recipe_extends_v1_lora` above stayed green
    (2026-08-30 review, run 2). This test walks every panel AND every
    sub_panel's effective weight -- `sub_panel.get("lora_strength", declared)`,
    the same lookup the generator itself uses -- so a future silent
    weight-zero (or any other) deviation fails here even if it never touches
    the top-level field."""
    declared = v3_recipe["lora_strength"]
    for panel in v3_recipe["panels"]:
        if "sub_panels" in panel:
            for sub in panel["sub_panels"]:
                effective = sub.get("lora_strength", declared)
                assert effective == declared, (
                    f"sub-panel {sub.get('label', '?')!r} in panel "
                    f"({panel['row']},{panel['col']}) runs at LoRA weight {effective}, "
                    f"not the sheet's declared {declared} -- every real generation must "
                    "share the same style lock unless a human has explicitly approved "
                    "a deviation."
                )
        else:
            effective = panel.get("lora_strength", declared)
            assert effective == declared, (
                f"panel {panel.get('label', '?')!r} ({panel['row']},{panel['col']}) runs at "
                f"LoRA weight {effective}, not the sheet's declared {declared}."
            )


def test_v3_recipe_extends_v1_dimensions(v3_recipe, v1_recipe):
    assert v3_recipe["width"] == v1_recipe["width"]
    assert v3_recipe["height"] == v1_recipe["height"]


# ── v1 is additive, never redrawn/superseded ──────────────────────────────


def test_v1_sheet_untouched_by_this_card():
    """v1's own PNG must still match its own provenance's concept_hash -- proof
    this card did not overwrite or regenerate the approved v1 reference."""
    v1_bytes = V1_PNG.read_bytes()
    v1_prov = json.loads(V1_PROVENANCE.read_text())
    actual = hashlib.sha256(v1_bytes).hexdigest()
    assert v1_prov.get("concept_hash") == actual, (
        "v1 props concept sheet bytes no longer match its own provenance's concept_hash -- "
        "v1 must stay the untouched approved reference; v3 is additive only."
    )


# ── Four prop classes covered by prompt content ────────────────────────────


def test_v3_prompt_covers_archive_shelving(v3_provenance):
    prompt = v3_provenance.get("prompt", "").lower()
    assert "shelving" in prompt or "shelf" in prompt


def test_v3_prompt_covers_transformer_housings(v3_provenance):
    prompt = v3_provenance.get("prompt", "").lower()
    assert "transformer" in prompt


def test_v3_prompt_covers_breaker_panel_as_gate_object(v3_provenance):
    prompt = v3_provenance.get("prompt", "").lower()
    assert "breaker" in prompt
    assert "gate object" in prompt or "switch-locked" in prompt, (
        "Prompt must depict the breaker panel as a gate object per `14` §4, not as cover."
    )


def test_v3_prompt_covers_crawlspace(v3_provenance):
    prompt = v3_provenance.get("prompt", "").lower()
    assert "crawlspace" in prompt


def test_v3_prompt_covers_hiding_alcove(v3_provenance):
    prompt = v3_provenance.get("prompt", "").lower()
    assert "alcove" in prompt


def test_v3_prompt_classifies_cover_vs_hiding(v3_provenance):
    prompt = v3_provenance.get("prompt", "").lower()
    assert "cover prop" in prompt
    assert "hiding spot" in prompt


# ── Real pixel content (not blank canvas, not provenance-prose-only) ──────


@pytest.mark.parametrize(
    "box,label",
    [
        (ARCHIVE_SHELVING_BOX, "archive shelving (top-left)"),
        (TRANSFORMER_BREAKER_BOX, "transformer/breaker (top-right)"),
        (CRAWLSPACE_BOX, "crawlspace (bottom-left)"),
        (ALCOVE_BOX, "hiding alcove (bottom-right)"),
    ],
)
def test_v3_quadrant_has_real_generated_content(v3_image, box, label):
    """Each of the four panel quadrants must show real generated detail, not
    a flat/blank fill -- the pixel-content lesson from the 2026-08-29T10:48:20
    review (v2's earlier prompt-substring-only gates stayed green against an
    image containing none of the required content)."""
    distinct = _region_distinct_colour_count(v3_image, box)
    assert distinct > 50, (
        f"{label} quadrant has only {distinct} distinct colours -- looks blank/flat, "
        "not real generated prop content."
    )


@pytest.mark.parametrize(
    "hiding_box,hiding_label",
    [
        (CRAWLSPACE_BOX, "crawlspace"),
        (ALCOVE_BOX, "hiding alcove"),
    ],
)
def test_v3_hiding_props_clear_luma_gate_against_power_substation_cover(v3_image, hiding_box, hiding_label):
    """T-0223 established a 16px +15 luma gate (locker measured -34 luma
    against the +15 required) between a hiding prop and the cover prop it
    actually shares a room with. Of this sheet's four prop classes, only
    Power Substation is on record (`docs/design/14-vertical-slice.md` line
    150: "Cover-break behind the housings between flips; one dedicated
    hiding spot near the panel as a fallback") as needing both a cover prop
    AND a hiding spot -- Records Room's archive shelving has no hiding-spot
    need (`14` line 149: safety valve "N/A"), so a shelving-vs-hiding
    comparison is not evidence for any real room pairing (2026-08-30 review).
    Power Substation's own cover prop is TRANSFORMER_BREAKER_BOX; both of
    this sheet's hiding panels are checked against it since either could be
    the room's "fallback" hiding spot."""
    cover_luma = _region_luma_mean(v3_image, TRANSFORMER_BREAKER_BOX)
    hide_luma = _region_luma_mean(v3_image, hiding_box)
    delta = cover_luma - hide_luma
    assert delta >= 15, (
        f"Power Substation cover-quadrant avg luma {cover_luma:.1f} vs {hiding_label} avg luma "
        f"{hide_luma:.1f} -- separation {delta:.1f} is below the required 15 (T-0223 gate)."
    )


def test_v3_all_hiding_panels_darker_than_all_cover_panels(v3_image):
    """General grammar sanity check (not room-pairing evidence, see the test
    above for that): v1's grammar is that cover props read as mid-value and
    hiding props read as dark, sheet-wide. Every cover-class panel should be
    lighter than every hiding-class panel."""
    cover_lumas = [
        _region_luma_mean(v3_image, ARCHIVE_SHELVING_BOX),
        _region_luma_mean(v3_image, TRANSFORMER_BREAKER_BOX),
    ]
    hiding_lumas = [
        _region_luma_mean(v3_image, CRAWLSPACE_BOX),
        _region_luma_mean(v3_image, ALCOVE_BOX),
    ]
    assert min(cover_lumas) > max(hiding_lumas), (
        f"cover-panel lumas {cover_lumas} must all be lighter than hiding-panel lumas "
        f"{hiding_lumas} to preserve v1's cover-vs-hiding grammar."
    )


def test_v3_archive_shelving_is_mid_value_not_near_white(v3_image):
    """Acceptance: archive shelving must be 'mid-value concrete-grey' and
    match v1's 'same palette language' -- not a near-white/empty render. An
    earlier committed cut (2026-08-30 review) was measured near-white and
    empty, contradicting its own prompt."""
    luma = _region_luma_mean(v3_image, ARCHIVE_SHELVING_BOX)
    assert luma < 200, (
        f"Archive shelving quadrant mean luma {luma:.1f} reads as near-white, not the "
        "mid-value concrete-grey the prompt and v1's palette language call for."
    )


def test_v3_transformer_breaker_quadrant_shows_institutional_green(v3_image):
    """Acceptance: the breaker panel must be depicted as a distinct gate
    object -- this sheet's own recipe/prompt commits to it being a flat
    institutional-green plate, distinguishable from the grey transformer
    housings it shares the quadrant with. A meaningful fraction of clearly
    green-hued pixels is required, not just any pixel variance (the
    2026-08-30 review's finding: a >50-distinct-colours check alone stayed
    green against a quadrant with no breaker panel or transformer housings
    at all)."""
    pixels = list(v3_image.crop(TRANSFORMER_BREAKER_BOX).getdata())
    green_pixels = sum(1 for r, g, b in pixels if g > r + 15 and g > b + 15)
    fraction = green_pixels / len(pixels)
    assert fraction >= 0.02, (
        f"Only {fraction:.1%} of the transformer/breaker quadrant is green-hued -- too "
        "little to read as a distinct institutional-green breaker panel gate object."
    )


@pytest.mark.parametrize(
    "row,col,label",
    [(0, 0, "archive shelving"), (0, 1, "transformer/breaker"), (1, 0, "crawlspace"), (1, 1, "hiding alcove")],
)
def test_v3_captions_stay_within_own_quadrant(v3_image, row, col, label):
    """Acceptance: each panel must be clearly labelled -- the 2026-08-30
    review found the top-right caption ('...BREAKER PANEL -- GATE OBJECT')
    clipped at the image edge, silently dropping the exact classification
    text the card calls out three times. Checks the "dead zone" no panel's
    own caption should ever draw into -- the gutter after this quadrant (for
    col 0) or the right margin past the last quadrant (for col 1) -- for
    text-coloured pixels, within this panel's own caption row range. (A
    naive scan across the panel's own row-range but full canvas width would
    false-positive on the *next* quadrant's own, legitimately drawn caption
    sharing the same row -- this checks only the strip neither panel's
    caption should ever reach.)"""
    x0 = _MARGIN + col * (_PW + _GUTTER)
    y0 = _MARGIN + row * (_PH + _GUTTER)
    x1 = x0 + _PW - 1
    y1 = y0 + _PH - 1
    strip_top = y1 - _CAPTION_BAND + 1
    canvas_w, canvas_h = v3_image.size
    dead_zone_start = x1 + 1
    dead_zone_end = (x1 + _GUTTER) if col == 0 else (canvas_w - 1)
    text_colour = (168, 164, 160)
    max_x_seen = -1
    for y in range(strip_top, min(y1, canvas_h - 1) + 1):
        for x in range(dead_zone_start, min(dead_zone_end, canvas_w - 1) + 1):
            px = v3_image.getpixel((x, y))
            if all(abs(px[i] - text_colour[i]) <= 12 for i in range(3)):
                max_x_seen = max(max_x_seen, x)
    assert max_x_seen == -1, (
        f"{label} caption has text-coloured pixels at x={max_x_seen}, inside the gutter/margin "
        f"dead zone [{dead_zone_start}, {dead_zone_end}] past this panel's own right edge x={x1} "
        "-- the caption is clipping past its own quadrant."
    )
