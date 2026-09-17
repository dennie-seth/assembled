"""T-0239 -- Signal Tower props concept sheet v2 artifact gate (§23-j-0).

`docs/design/14-vertical-slice.md` §10 requires prop geometry for four room
dressings the v1 props sheet (T-0211) does not depict: Records Room archive
shelving, Power Substation transformer housings + breaker panel, Equipment
Floor crawlspace, and Antenna Shaft hiding alcove. This is a single new
sheet extending the v1 set (`13-asset-pipeline.md` §6.2, "one concept sheet
per asset set") rather than four separate sheets, additive to v1 -- v1's five
props stay the approved reference and are never redrawn.

Continuity requirements checked here (§23-j-0 acceptance):
  - v2 extends v1's own recipe: same checkpoint, same LoRA + weight, same
    palette language.
  - v2 is img2img-conditioned on the v1 props sheet itself, per the
    archetype-first coherence guard T-0226 established
    (`13-asset-pipeline.md` §6 lines 313-319): a sheet after the archetype's
    first is conditioned on an already-approved sheet, not a bare prompt.
  - The breaker panel is depicted as a gate object (switch-locked, labelled
    breakers, indicator lamps), not as a crouch-behind cover prop.
  - v1's own PNG is not redrawn or superseded by this card.

Full-colour, full-res, provenance + recipe sidecars -- same shape as the
other Signal Tower concept-sheet gates (T-0211, T-0226).

PNG inspection uses stdlib (struct) only -- no Pillow/numpy dependency.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
import sys
from pathlib import Path

import pytest
from PIL import Image

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"


def _load_composite_module():
    """Import `_composite_props_v2.py` by path (not a package -- no __init__.py
    in assets/src/concept). Tests assert against this module's own LAYOUT /
    colour constants so pixel checks can never drift from what the generator
    actually draws."""
    path = CONCEPT_DIR / "_composite_props_v2.py"
    spec = importlib.util.spec_from_file_location("_composite_props_v2", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_composite_props_v2"] = module
    spec.loader.exec_module(module)
    return module


COMPOSITE = _load_composite_module()


def _luma(rgb: tuple) -> float:
    r, g, b = rgb
    return 0.299 * r + 0.587 * g + 0.114 * b


def _region_colour_counts(img: Image.Image, box: tuple) -> dict:
    """Count pixel occurrences of each colour within `box` (x0, y0, x1, y1)."""
    crop = img.crop(box)
    counts: dict = {}
    for rgb in crop.getdata():
        counts[rgb] = counts.get(rgb, 0) + 1
    return counts


def _count_near(counts: dict, target: tuple, tolerance: int = 6) -> int:
    """Sum counts for colours within `tolerance` per channel of `target` --
    tolerant of the SDXL background wash's blend/resize antialiasing at
    region edges."""
    total = 0
    for rgb, n in counts.items():
        if all(abs(rgb[i] - target[i]) <= tolerance for i in range(3)):
            total += n
    return total

V1_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.png"
V1_PROVENANCE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.provenance.json"
V1_RECIPE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v1.recipe.json"

V2_PNG = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.png"
V2_PROVENANCE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.provenance.json"
V2_RECIPE = CONCEPT_DIR / "signal_tower_props_concept_sheet_v2.recipe.json"

_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _parse_png_ihdr(data: bytes) -> dict:
    """Parse PNG signature + IHDR chunk, return image metadata dict.

    Returns keys: width, height, bit_depth, colour_type.
    colour_type 2 = RGB truecolour (not indexed).
    """
    assert data[:8] == _PNG_SIG, "Not a valid PNG (bad signature)"
    chunk_len = struct.unpack(">I", data[8:12])[0]
    chunk_type = data[12:16]
    assert chunk_type == b"IHDR", f"First chunk is {chunk_type!r}, expected IHDR"
    assert chunk_len == 13, f"IHDR length {chunk_len}, expected 13"
    ihdr = data[16:29]
    width, height = struct.unpack(">II", ihdr[0:8])
    bit_depth = ihdr[8]
    colour_type = ihdr[9]
    return {
        "width": width,
        "height": height,
        "bit_depth": bit_depth,
        "colour_type": colour_type,
    }


@pytest.fixture(scope="session")
def v2_bytes(ensure_signal_tower_props_concept_sheet_v2) -> bytes:  # noqa: ARG001
    """Return the raw bytes of the signal tower props concept sheet v2 PNG."""
    return V2_PNG.read_bytes()


@pytest.fixture(scope="session")
def v2_image(v2_bytes) -> Image.Image:  # noqa: ARG001
    """Decoded RGB pixels of the actual committed v2 PNG -- these tests
    inspect real pixel content, not just provenance metadata, per the
    2026-08-29T10:48:20.385Z review's TEST-DESIGN DEFECT finding (the prior
    prompt-substring-only gates were green against an image containing none
    of the four required prop classes)."""
    return Image.open(V2_PNG).convert("RGB")


@pytest.fixture(scope="session")
def v2_provenance(v2_bytes) -> dict:  # noqa: ARG001
    return json.loads(V2_PROVENANCE.read_text())


@pytest.fixture(scope="session")
def v2_recipe() -> dict:
    return json.loads(V2_RECIPE.read_text())


@pytest.fixture(scope="session")
def v1_provenance(ensure_signal_tower_props_concept_sheet) -> dict:  # noqa: ARG001
    return json.loads(V1_PROVENANCE.read_text())


@pytest.fixture(scope="session")
def v1_recipe() -> dict:
    return json.loads(V1_RECIPE.read_text())


# ── Existence + format gates ─────────────────────────────────────────────────


def test_v2_concept_png_exists(ensure_signal_tower_props_concept_sheet_v2):  # noqa: ARG001
    """v2 concept sheet must exist as an artifact (checkDeliverable.js gate)."""
    assert V2_PNG.exists(), f"Missing signal tower props concept sheet v2: {V2_PNG}"


def test_v2_concept_full_colour(v2_bytes):
    """§6 table: concept sheets are full-colour (RGB colour_type=2), never indexed/quantized."""
    meta = _parse_png_ihdr(v2_bytes)
    assert meta["colour_type"] == 2, (
        f"Expected PNG colour_type 2 (RGB truecolour), got {meta['colour_type']}. "
        "colour_type 3 = indexed (mode P) -- concept sheets must NOT be indexed."
    )
    assert meta["bit_depth"] == 8, f"Expected 8-bit depth, got {meta['bit_depth']}."


def test_v2_concept_resolution(v2_bytes):
    """§6.9 / §3.5: 1024x1024 base SDXL resolution."""
    meta = _parse_png_ihdr(v2_bytes)
    assert meta["width"] == 1024, f"Expected width 1024, got {meta['width']}"
    assert meta["height"] == 1024, f"Expected height 1024, got {meta['height']}"


# ── Provenance gates ──────────────────────────────────────────────────────────


def test_v2_provenance_exists(v2_provenance):
    assert isinstance(v2_provenance, dict)


def test_v2_provenance_required_fields(v2_provenance):
    """§6 coherence guard: concept_hash + generator + img2img conditioning fields."""
    required = {
        "model",
        "model_license",
        "prompt",
        "seed",
        "concept_hash",
        "generator",
        "denoise",
        "conditioning_source",
        "base_concept_hash",
        "lora_name",
        "lora_weight",
    }
    missing = required - v2_provenance.keys()
    assert not missing, f"Provenance missing required fields: {missing}"


def test_v2_provenance_concept_hash_matches(v2_bytes, v2_provenance):
    """concept_hash must match sha256 of the actual concept sheet bytes (§6 seam)."""
    expected = hashlib.sha256(v2_bytes).hexdigest()
    actual = v2_provenance.get("concept_hash", "")
    assert actual == expected, (
        f"concept_hash mismatch.\n"
        f"  provenance says: {actual}\n"
        f"  file sha256 is:  {expected}"
    )


def test_v2_provenance_generator_resolves_to_committed_code(v2_provenance):
    """P-7: the generator field must resolve to a file committed in the repo."""
    generator = v2_provenance.get("generator", "")
    assert generator, "Provenance must declare a generator (P-7)"
    candidate = generator.split()[0]
    resolved = WORKTREE / candidate
    assert resolved.exists(), (
        f"generator field {generator!r} does not resolve to a committed file "
        f"(looked for {resolved})"
    )


def test_v2_provenance_compositing_script_hash_matches(v2_provenance):
    """compositing_script_hash is the stage-2 reproducibility seam (the analogue
    of workflow_hash for stage 1): it must equal the sha256 of the committed
    `generator` script it names, not a stale value left over from an edit made
    after the hash was recorded (2026-08-29T11:10:42.878Z review)."""
    generator = v2_provenance.get("generator", "")
    assert generator, "Provenance must declare a generator (P-7)"
    script_path = WORKTREE / generator.split()[0]
    expected = hashlib.sha256(script_path.read_bytes()).hexdigest()
    actual = v2_provenance.get("compositing_script_hash", "")
    assert actual == expected, (
        f"compositing_script_hash mismatch.\n"
        f"  provenance says: {actual}\n"
        f"  file sha256 is:  {expected}\n"
        f"  (file: {script_path})"
    )


def test_v2_provenance_workflow_hash_matches(v2_provenance):
    """workflow_hash (stage 1) must equal the sha256 of the committed
    background_workflow JSON it names."""
    background_workflow = v2_provenance.get("background_workflow", "")
    assert background_workflow, "Provenance must declare background_workflow"
    workflow_path = WORKTREE / background_workflow
    expected = hashlib.sha256(workflow_path.read_bytes()).hexdigest()
    actual = v2_provenance.get("workflow_hash", "")
    assert actual == expected, (
        f"workflow_hash mismatch.\n"
        f"  provenance says: {actual}\n"
        f"  file sha256 is:  {expected}\n"
        f"  (file: {workflow_path})"
    )


def test_v2_recipe_exists():
    assert V2_RECIPE.exists(), f"Missing recipe: {V2_RECIPE}"


def test_v2_recipe_required_fields(v2_recipe):
    required = {"prompt", "negative_prompt", "seed", "checkpoint", "width", "height", "name"}
    missing = required - v2_recipe.keys()
    assert not missing, f"Recipe missing required fields: {missing}"


# ── Continuity requirements (§23-j-0: "extend v1's own recipe") ─────────────


def test_v2_recipe_extends_v1_checkpoint(v2_recipe, v1_recipe):
    assert v2_recipe["checkpoint"] == v1_recipe["checkpoint"], (
        "v2 must use the same checkpoint as v1 -- same vocabulary, not a second art style."
    )


def test_v2_recipe_extends_v1_lora(v2_recipe, v1_recipe):
    assert v2_recipe["lora"] == v1_recipe["lora"], "v2 must reuse v1's style LoRA."
    assert v2_recipe["lora_strength"] == v1_recipe["lora_strength"], (
        "v2 must reuse v1's LoRA weight exactly (same style lock)."
    )


def test_v2_conditioned_on_v1_props_sheet(v2_provenance):
    """v2 is img2img-conditioned on the v1 props sheet itself (not the material
    sheet or a bare prompt) -- this card explicitly extends v1's own recipe."""
    conditioning_source = v2_provenance.get("conditioning_source", "")
    assert conditioning_source == "assets/src/concept/signal_tower_props_concept_sheet_v1.png", (
        f"conditioning_source is {conditioning_source!r}, expected the v1 props sheet "
        "(v2 must extend v1's own recipe, not a different archetype sheet)."
    )


def test_v2_obeys_archetype_first_coherence_guard(v2_provenance):
    """§6 archetype-first coherence guard (13-asset-pipeline.md:313-319), established
    by T-0226: a Signal Tower sheet after the first must be img2img/IP-Adapter
    conditioned, not a bare prompt. denoise must be strictly < 1.0."""
    assert "conditioning_source" in v2_provenance
    assert "denoise" in v2_provenance
    denoise = v2_provenance["denoise"]
    assert 0.0 < denoise < 1.0, (
        f"denoise={denoise!r} -- must be strictly less than 1.0 (1.0 discards the "
        "conditioning image's latent entirely, which is a bare prompt in disguise)."
    )


def test_v2_conditioning_source_resolves_and_matches_base_concept_hash(v2_provenance):
    conditioning_source = v2_provenance.get("conditioning_source", "")
    assert conditioning_source, "conditioning_source must be set (coherence guard)."
    resolved = WORKTREE / conditioning_source
    assert resolved.exists(), f"conditioning_source {conditioning_source!r} does not resolve to a committed file"

    base_concept_hash = v2_provenance.get("base_concept_hash", "")
    assert base_concept_hash, "base_concept_hash must be set to the sha256 of the conditioning sheet."
    actual = hashlib.sha256(resolved.read_bytes()).hexdigest()
    assert base_concept_hash == actual, (
        f"base_concept_hash {base_concept_hash!r} does not match sha256 of "
        f"conditioning_source {conditioning_source!r} ({actual!r})"
    )


# ── v1 is additive, never redrawn/superseded ────────────────────────────────


def test_v1_sheet_untouched_by_this_card(ensure_signal_tower_props_concept_sheet):  # noqa: ARG001
    """v1's own PNG must still match its own provenance's concept_hash -- proof
    this card did not overwrite or regenerate the approved v1 reference."""
    v1_bytes = V1_PNG.read_bytes()
    v1_prov = json.loads(V1_PROVENANCE.read_text())
    actual = hashlib.sha256(v1_bytes).hexdigest()
    assert v1_prov.get("concept_hash") == actual, (
        "v1 props concept sheet bytes no longer match its own provenance's concept_hash -- "
        "v1 must stay the untouched approved reference; v2 is additive only."
    )


# ── Four missing prop classes (§23-j-0 table) ───────────────────────────────
#
# These inspect actual pixel content of the committed v2 PNG at the exact
# coordinates `_composite_props_v2.py`'s own LAYOUT says each icon is drawn
# at, so a wrong or missing image fails these tests regardless of what its
# provenance JSON *claims* -- the defect the 2026-08-29T10:48:20.385Z review
# found (every one of these gates previously only grepped the prompt string,
# so they stayed green against an image containing none of the four classes).


def test_v2_covers_archive_shelving(v2_image):
    """#1: Archive shelving row (Records Room, cover-class dressing) --
    the shelf frame (COVER_BODY/SIDE/TOP) and stacked document boxes
    (COVER_ACCT) must actually be present at the drawn icon's location."""
    cx = COMPOSITE.LAYOUT["archive_shelving_cx"]
    floor_y = COMPOSITE.LAYOUT["archive_shelving_floor"]
    box = (cx - 60, floor_y - 200, cx + 60, floor_y + 4)
    counts = _region_colour_counts(v2_image, box)
    boxes = _count_near(counts, COMPOSITE.COVER_ACCT)
    frame = _count_near(counts, COMPOSITE.COVER_BODY) + _count_near(counts, COMPOSITE.COVER_SIDE)
    assert boxes > 100, f"Archive shelving document-box colour barely present ({boxes}px) at {box}."
    assert frame > 500, f"Archive shelving frame colour barely present ({frame}px) at {box}."


def test_v2_covers_transformer_housing(v2_image):
    """#2a: Transformer housing x2-3 (Power Substation, cover) -- squat
    ribbed bodies must actually be present at the drawn icon's location."""
    cx = COMPOSITE.LAYOUT["transformer_cx"]
    floor_y = COMPOSITE.LAYOUT["transformer_floor"]
    box = (cx - 120, floor_y - 110, cx + 120, floor_y + 4)
    counts = _region_colour_counts(v2_image, box)
    body = _count_near(counts, COMPOSITE.COVER_BODY)
    fins = _count_near(counts, COMPOSITE.COVER_SIDE)
    assert body > 400, f"Transformer housing body colour barely present ({body}px) at {box}."
    assert fins > 100, f"Transformer housing cooling-fin colour barely present ({fins}px) at {box}."


def test_v2_covers_breaker_panel(v2_image):
    """#2b: Breaker panel (Power Substation) -- the panel body and its three
    switches must actually be present at the drawn icon's location."""
    cx = COMPOSITE.LAYOUT["breaker_cx"]
    floor_y = COMPOSITE.LAYOUT["breaker_floor"]
    s = COMPOSITE.LAYOUT["breaker_s"]
    box = (cx - 60 * s, floor_y - 52 * s, cx + 60 * s, floor_y + 4)
    counts = _region_colour_counts(v2_image, box)
    body = _count_near(counts, COMPOSITE.GATE_BODY)
    switches = _count_near(counts, COMPOSITE.GATE_SWITCH)
    assert body > 1000, f"Breaker panel body colour barely present ({body}px) at {box}."
    assert switches > 100, f"Breaker switch colour barely present ({switches}px) at {box}."


def test_v2_breaker_panel_depicted_as_gate_object_not_cover(v2_image):
    """`14` §4: the breaker panel is an explicit switch-locked gate with three
    labelled breakers and indicator lamps -- not a crouch-behind cover prop.
    Checks (a) the three indicator lamps are actually lit at their drawn
    centres, and (b) the panel body colour is a distinct value from both the
    cover-prop and hiding-prop bodies (not silently reusing either grammar)."""
    cx = COMPOSITE.LAYOUT["breaker_cx"]
    floor_y = COMPOSITE.LAYOUT["breaker_floor"]
    s = COMPOSITE.LAYOUT["breaker_s"]
    for lamp_cx, lamp_cy in COMPOSITE.breaker_lamp_centers(cx, floor_y, s):
        sample = v2_image.getpixel((lamp_cx, lamp_cy))
        assert all(abs(sample[i] - COMPOSITE.GATE_LAMP[i]) <= 8 for i in range(3)), (
            f"Indicator lamp at ({lamp_cx}, {lamp_cy}) is {sample}, expected near "
            f"GATE_LAMP {COMPOSITE.GATE_LAMP} -- lamp not actually lit/drawn."
        )
    assert COMPOSITE.GATE_BODY != COMPOSITE.COVER_BODY, "Gate body colour must not reuse the cover-prop body colour."
    assert COMPOSITE.GATE_BODY != COMPOSITE.HIDE_BODY, "Gate body colour must not reuse the hiding-prop body colour."


def test_v2_covers_crawlspace(v2_image):
    """#3: Crawlspace opening (Equipment Floor, hiding-spot) -- a low, dark
    (HIDE_INSIDE) opening embedded in a wall segment must actually be
    present at the drawn icon's location."""
    cx = COMPOSITE.LAYOUT["crawlspace_cx"]
    floor_y = COMPOSITE.LAYOUT["crawlspace_floor"]
    box = (cx - 60, floor_y - 60, cx + 60, floor_y + 4)
    counts = _region_colour_counts(v2_image, box)
    dark = _count_near(counts, COMPOSITE.HIDE_INSIDE)
    assert dark > 200, f"Crawlspace dark-opening colour barely present ({dark}px) at {box}."


def test_v2_covers_hiding_alcove(v2_image):
    """#4: Hiding alcove (Antenna Shaft, hiding-spot) -- a recessed niche
    (HIDE_BODY outer shell + HIDE_INSIDE interior void) must actually be
    present at the drawn icon's location."""
    cx = COMPOSITE.LAYOUT["alcove_cx"]
    floor_y = COMPOSITE.LAYOUT["alcove_floor"]
    box = (cx - 60, floor_y - 170, cx + 60, floor_y + 4)
    counts = _region_colour_counts(v2_image, box)
    shell = _count_near(counts, COMPOSITE.HIDE_BODY)
    void = _count_near(counts, COMPOSITE.HIDE_INSIDE)
    assert shell > 200, f"Hiding alcove shell colour barely present ({shell}px) at {box}."
    assert void > 100, f"Hiding alcove interior-void colour barely present ({void}px) at {box}."


def test_v2_preserves_cover_vs_hiding_visual_grammar(v2_image):
    """v1's grammar: cover props are opaque mid-value blocky forms open from
    above; hiding props are dark-bodied enclosed single-occupant forms with an
    exposed entry. Measures actual average luma of the drawn cover-prop icons
    (archive shelving + transformer housings) against the drawn hiding-prop
    icons (crawlspace + alcove) -- T-0223 established a 16px luma gate
    (locker measured -34 luma against a required +15); this checks the same
    separation actually holds for the real committed v2 image's icon pixels
    (not the shared panel background, which is equally dark behind both and
    would dilute a whole-panel average to near zero regardless of the icons)."""
    cx1, fy1 = COMPOSITE.LAYOUT["archive_shelving_cx"], COMPOSITE.LAYOUT["archive_shelving_floor"]
    cover_boxes = [
        (cx1 - 60, fy1 - 200, cx1 + 60, fy1 + 4),
        (
            COMPOSITE.LAYOUT["transformer_cx"] - 120, COMPOSITE.LAYOUT["transformer_floor"] - 110,
            COMPOSITE.LAYOUT["transformer_cx"] + 120, COMPOSITE.LAYOUT["transformer_floor"] + 4,
        ),
    ]
    hide_boxes = [
        (
            COMPOSITE.LAYOUT["crawlspace_cx"] - 60, COMPOSITE.LAYOUT["crawlspace_floor"] - 60,
            COMPOSITE.LAYOUT["crawlspace_cx"] + 60, COMPOSITE.LAYOUT["crawlspace_floor"] + 4,
        ),
        (
            COMPOSITE.LAYOUT["alcove_cx"] - 60, COMPOSITE.LAYOUT["alcove_floor"] - 170,
            COMPOSITE.LAYOUT["alcove_cx"] + 60, COMPOSITE.LAYOUT["alcove_floor"] + 4,
        ),
    ]
    cover_pixels = [p for box in cover_boxes for p in v2_image.crop(box).getdata()]
    hide_pixels = [p for box in hide_boxes for p in v2_image.crop(box).getdata()]
    cover_luma = sum(_luma(p) for p in cover_pixels) / len(cover_pixels)
    hide_luma = sum(_luma(p) for p in hide_pixels) / len(hide_pixels)
    assert cover_luma - hide_luma >= 15, (
        f"Cover-icon avg luma {cover_luma:.1f} vs hiding-icon avg luma {hide_luma:.1f} "
        f"-- separation {cover_luma - hide_luma:.1f} is below the required 15 (T-0223 gate)."
    )
