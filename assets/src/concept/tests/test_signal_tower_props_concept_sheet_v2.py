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
import json
import struct
from pathlib import Path

import pytest

WORKTREE = Path(__file__).resolve().parents[4]
CONCEPT_DIR = WORKTREE / "assets" / "src" / "concept"

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


def test_v2_covers_archive_shelving(v2_provenance):
    """#1: Archive shelving row (Records Room, cover-class dressing)."""
    prompt = v2_provenance.get("prompt", "")
    terms = ["shelving", "shelves", "archive"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, f"Provenance prompt must reference archive shelving. Looked for {terms!r}."


def test_v2_covers_transformer_housing(v2_provenance):
    """#2a: Transformer housing x2-3 (Power Substation, cover)."""
    prompt = v2_provenance.get("prompt", "")
    terms = ["transformer"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, f"Provenance prompt must reference transformer housings. Looked for {terms!r}."


def test_v2_covers_breaker_panel(v2_provenance):
    """#2b: Breaker panel (Power Substation)."""
    prompt = v2_provenance.get("prompt", "")
    terms = ["breaker"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, f"Provenance prompt must reference the breaker panel. Looked for {terms!r}."


def test_v2_breaker_panel_depicted_as_gate_object_not_cover(v2_provenance):
    """`14` §4: the breaker panel is an explicit switch-locked gate with three
    labelled breakers and indicator lamps -- not a crouch-behind cover prop."""
    prompt = v2_provenance.get("prompt", "").lower()
    assert "breaker" in prompt, "Prompt must mention the breaker panel at all."
    gate_terms = ["gate", "switch-locked", "switch locked", "labelled", "labeled", "indicator lamp"]
    matched = [t for t in gate_terms if t in prompt]
    assert matched, (
        "Breaker panel must be depicted as a gate object (switch-locked, labelled "
        f"breakers, indicator lamps), not mere cover. Looked for any of {gate_terms!r}."
    )
    assert "not cover" in prompt or "gate object" in prompt, (
        "Prompt must explicitly distinguish the breaker panel from the cover-prop "
        "grammar (`14` §4: gate object, not cover)."
    )


def test_v2_covers_crawlspace(v2_provenance):
    """#3: Crawlspace opening (Equipment Floor, hiding-spot)."""
    prompt = v2_provenance.get("prompt", "")
    terms = ["crawlspace", "crawl space", "crawl-in"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, f"Provenance prompt must reference the crawlspace opening. Looked for {terms!r}."


def test_v2_covers_hiding_alcove(v2_provenance):
    """#4: Hiding alcove (Antenna Shaft, hiding-spot)."""
    prompt = v2_provenance.get("prompt", "")
    terms = ["alcove"]
    matched = [t for t in terms if t.lower() in prompt.lower()]
    assert matched, f"Provenance prompt must reference the hiding alcove. Looked for {terms!r}."


def test_v2_preserves_cover_vs_hiding_visual_grammar(v2_provenance):
    """v1's grammar: cover props are opaque mid-value blocky forms open from
    above; hiding props are dark-bodied enclosed single-occupant forms with an
    exposed entry. Both vocabularies must appear in v2's prompt."""
    prompt = v2_provenance.get("prompt", "").lower()
    cover_terms = ["cover", "exposed", "mid-value"]
    hide_terms = ["dark", "enclosed", "single-occupant", "hiding"]
    matched_cover = [t for t in cover_terms if t in prompt]
    matched_hide = [t for t in hide_terms if t in prompt]
    assert matched_cover, f"Prompt must preserve the cover-prop vocabulary. Looked for {cover_terms!r}."
    assert matched_hide, f"Prompt must preserve the hiding-spot vocabulary. Looked for {hide_terms!r}."
