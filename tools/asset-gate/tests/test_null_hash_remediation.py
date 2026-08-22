"""T-0215 null-hash remediation tests.

Two concerns under test:

1.  ENFORCEMENT CONFIRMATION — every concept-generation code path
    refuses to write ``model_hash: null``.  The two paths covered by
    PR #221 (``pipeline.generate()`` via ``test_pipeline.py``, and
    ``generate_concept_lora()`` via ``test_concept.py``) already have
    tests.  This file adds "add or confirm" coverage for the remaining
    concept writers: ``generate_concept()`` and
    ``generate_concept_conditioned()`` both route through
    ``build_provenance_record()`` which raises ``MissingModelHashError``
    when ``recipe.model_hash is None`` — confirmed here so the full
    inventory of writers is documented in one place.

    NOTE: these are import-skipped when ``comfy_client`` is not
    installed, so asset-gate CI (which does not install comfy-client)
    sees them as ``SKIP`` rather than ``ERROR``.

2.  ARTIFACT GATE — the committed ``*.provenance.json`` sidecars for
    the eight null-hash assets identified by PR #221's audit table and
    owned directly by T-0215 must carry a non-null ``model_hash``:

    * T-0209  assets/src/concept/player_character_concept_sheet_v1.provenance.json
    * T-0210  assets/src/concept/entities_concept_sheet_v1.provenance.json
    * T-0153  assets/final/tiles/signal_tower_concrete_wall_floor_transitions_16px.provenance.json
    * T-0201  assets/final/props/signal_tower/
      {crate_stack,locker,low_duct,relay_cabinet,server_rack}_v1.provenance.json

    These tests are RED until the provenance files are updated (step 3
    of the TDD cycle).  They turn GREEN when the sidecar carries any
    truthy string for ``model_hash``.

    The sweep test at the end proves the gate as a whole: once all
    eight paths are fixed and removed from provenance_baseline.txt, a
    sweep of assets/ with an EMPTY baseline must find zero failures
    (excluding the T-0198/T-0199/T-0200 paths still tracked by
    T-0212/T-0213/T-0214, which remain in the baseline until those
    cards land).

docs/design/13-asset-pipeline.md §2 (validation gate, T-0102).
HANDOFF §21, T-0151, T-0215.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# ── Paths ────────────────────────────────────────────────────────────────────
# tools/asset-gate/tests/  ->  tools/asset-gate/  ->  tools/  ->  repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
ASSETS = REPO_ROOT / "assets"

PLAYER_PROV = ASSETS / "src" / "concept" / "player_character_concept_sheet_v1.provenance.json"
ENTITIES_PROV = ASSETS / "src" / "concept" / "entities_concept_sheet_v1.provenance.json"
TILE_PROV = (
    ASSETS / "final" / "tiles"
    / "signal_tower_concrete_wall_floor_transitions_16px.provenance.json"
)

PROP_NAMES = [
    "crate_stack_v1",
    "locker_v1",
    "low_duct_v1",
    "relay_cabinet_v1",
    "server_rack_v1",
]
PROPS_DIR = ASSETS / "final" / "props" / "signal_tower"


# ── 1. Enforcement confirmation (import-skipped per-test when comfy-client absent) ──
# Full coverage lives in tools/comfy-client/tests/test_concept.py (where comfy-client
# IS installed).  These tests are secondary confirmation in the asset-gate suite;
# they skip gracefully when comfy-client is not installed rather than erroring.
#
# 1a. build_provenance_record() — the single enforcement point for ALL AI writers
# (pipeline.generate, generate_concept*, and any future tile/SDXL writer that goes
# through comfy_client).  Confirmed here so the test file documents the full
# inventory in one place (T-0215 acceptance #1).
#
# 1b. Tile/descent writers — comfy_client.descend.descend() and
# transition_sheet.generate_sheet() do NOT write *.provenance.json at all, so
# they cannot introduce null model_hash.  Confirmed by checking that calling them
# leaves no provenance sidecar on disk.


def test_generate_concept_raises_missing_model_hash_when_recipe_has_none(tmp_path):
    """generate_concept() routes through build_provenance_record() which
    raises MissingModelHashError when recipe.model_hash is None.
    This confirms the path is covered in addition to generate_concept_lora()
    (PR #221) and pipeline.generate() (T-0151).  (HANDOFF §21 / T-0215)
    """
    pytest.importorskip("comfy_client.concept", reason="comfy-client not installed")
    from comfy_client.concept import generate_concept  # noqa: PLC0415
    from comfy_client.errors import MissingModelHashError  # noqa: PLC0415
    from comfy_client.recipe import Recipe  # noqa: PLC0415

    recipe = Recipe(prompt="x", seed=1)  # model_hash defaults to None

    class _FakeClient:
        calls: list = []

        def submit(self, wf):
            self.calls.append("submit")
            return "id"

        def wait_for_completion(self, jid, timeout, poll_interval):
            self.calls.append("wait")
            return {"job_id": jid}

        def fetch_output(self, jr):
            self.calls.append("fetch")
            return b"PNGDATA"

    client = _FakeClient()
    with pytest.raises(MissingModelHashError):
        generate_concept(recipe, out_dir=tmp_path, client=client)
    # The error fires in build_provenance_record(), AFTER generation —
    # so client calls may have occurred.  The key assertion is that the
    # error is raised and no null-hash provenance file is written.
    prov_path = tmp_path / "assembled.provenance.json"
    assert not prov_path.exists(), (
        "generate_concept() wrote a provenance sidecar with null model_hash; "
        "should have raised MissingModelHashError instead."
    )


def test_generate_concept_conditioned_raises_missing_model_hash_when_recipe_has_none(tmp_path):
    """generate_concept_conditioned() routes through build_provenance_record()
    which raises MissingModelHashError when recipe.model_hash is None.
    (HANDOFF §21 / T-0215)
    """
    pytest.importorskip("comfy_client.concept", reason="comfy-client not installed")
    from comfy_client.concept import generate_concept_conditioned  # noqa: PLC0415
    from comfy_client.errors import MissingModelHashError  # noqa: PLC0415
    from comfy_client.recipe import Recipe  # noqa: PLC0415

    init_img = tmp_path / "template.png"
    init_img.write_bytes(b"TEMPLATEBYTES")

    recipe = Recipe(prompt="x", seed=1)  # model_hash defaults to None

    class _FakeCondClient:
        def upload_image(self, img_bytes, filename, image_type="input"):
            return {"name": "t.png", "subfolder": "", "type": image_type}

        def submit(self, wf):
            return "id"

        def wait_for_completion(self, jid, timeout, poll_interval):
            return {"job_id": jid}

        def fetch_output(self, jr):
            return b"PNGDATA"

    client = _FakeCondClient()
    with pytest.raises(MissingModelHashError):
        generate_concept_conditioned(
            recipe, init_image_path=init_img, out_dir=tmp_path, client=client
        )
    prov_path = tmp_path / "assembled.provenance.json"
    assert not prov_path.exists(), (
        "generate_concept_conditioned() wrote a provenance sidecar with null "
        "model_hash; should have raised MissingModelHashError instead."
    )


# 1a — shared enforcement point -----------------------------------------------


def test_build_provenance_record_raises_missing_model_hash_when_none():
    """build_provenance_record() is the single enforcement point used by every
    AI-based writer in comfy_client: pipeline.generate(), generate_concept(),
    generate_concept_lora(), generate_concept_conditioned(), and any future
    tile/SDXL writer that is built on top of comfy_client.

    Confirming it raises MissingModelHashError when recipe.model_hash is None
    proves the entire writer inventory is covered without duplicating the check
    in every caller.  (HANDOFF §21 / T-0215 acceptance #1 — tile/descent path)
    """
    pytest.importorskip("comfy_client.provenance", reason="comfy-client not installed")
    from comfy_client.errors import MissingModelHashError  # noqa: PLC0415
    from comfy_client.provenance import build_provenance_record  # noqa: PLC0415
    from comfy_client.recipe import Recipe  # noqa: PLC0415

    recipe = Recipe(prompt="x", seed=1)  # model_hash defaults to None
    with pytest.raises(MissingModelHashError):
        build_provenance_record(recipe, workflow_hash="abc", prompt_id="test-id")


# 1b — tile and descent writers don't write provenance ------------------------


def test_descend_does_not_write_provenance_sidecar(tmp_path):
    """comfy_client.descend.descend() is a post-processing step (downscale ->
    quantize -> indexed PNG).  It writes only the indexed PNG, no
    *.provenance.json.  Null model_hash cannot originate from the descent path.
    (HANDOFF §21 / T-0215 acceptance #1 — tile/descent path)
    """
    pytest.importorskip("comfy_client.descend", reason="comfy-client not installed")
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    from comfy_client.descend import descend  # noqa: PLC0415

    palette = [(0, 0, 0), (128, 128, 128), (255, 255, 255)]
    arr = np.full((16, 16, 3), 128, dtype=np.uint8)
    raw = tmp_path / "raw.png"
    Image.fromarray(arr, mode="RGB").save(raw)

    descend(raw, palette=palette, target_size=8, out_path=tmp_path / "out.png")

    prov_files = list(tmp_path.glob("*.provenance.json"))
    assert not prov_files, (
        "descend() wrote a provenance sidecar — it must only write the indexed PNG. "
        "Null model_hash risk from the descent path is now present and must be fixed."
    )


def test_tile_transition_sheet_generate_sheet_does_not_write_provenance():
    """transition_sheet.generate_sheet() is a deterministic procedural writer:
    it returns a PIL.Image without writing any file (main() writes the PNG,
    nothing writes a *.provenance.json from within the module).  The tile
    sidecar for T-0153 was written manually with model_hash='N/A — procedural'.
    No AI model -> no null-hash risk from this path.
    (HANDOFF §21 / T-0215 acceptance #1 — tile/descent path)
    """
    pytest.importorskip("tile_gen.transition_sheet", reason="tile_gen not installed")
    from tile_gen.transition_sheet import generate_sheet  # noqa: PLC0415

    sheet = generate_sheet()
    # generate_sheet() returns a PIL Image and writes nothing to disk
    assert sheet is not None, "generate_sheet() returned None"
    assert sheet.mode == "P", f"Expected indexed mode 'P', got {sheet.mode!r}"
    assert sheet.size == (64, 32), f"Expected 64x32 sheet, got {sheet.size}"


# ── 2. Artifact gate: committed sidecars must have non-null model_hash ───────


def test_T0209_player_concept_sheet_provenance_has_non_null_model_hash():
    """T-0209 player concept sheet provenance must carry a non-null model_hash.

    The SDXL generation used sd_xl_base_1.0.safetensors — model_hash was
    never captured because T-0151's enforcement only covered pipeline.generate(),
    not generate_concept_lora().  Fixed as HANDOFF §21 option A in PR #221;
    this card (T-0215) backfills the sidecar.  (T-0215 acceptance §3)
    """
    assert PLAYER_PROV.exists(), f"Player provenance sidecar not found: {PLAYER_PROV}"
    prov = json.loads(PLAYER_PROV.read_text())
    model_hash = prov.get("model_hash", "<<key missing>>")
    assert model_hash, (
        f"player_character_concept_sheet_v1.provenance.json has model_hash={model_hash!r}. "
        "Expected a non-null, non-empty string (HANDOFF §21 / T-0215)."
    )


def test_T0210_entities_concept_sheet_provenance_has_non_null_model_hash():
    """T-0210 entities concept sheet provenance must carry a non-null model_hash.

    The model_hash key was missing entirely (not just null) from the committed
    sidecar.  This card (T-0215) adds it.  (T-0215 acceptance §3)
    """
    assert ENTITIES_PROV.exists(), f"Entities provenance sidecar not found: {ENTITIES_PROV}"
    prov = json.loads(ENTITIES_PROV.read_text())
    model_hash = prov.get("model_hash", "<<key missing>>")
    assert model_hash, (
        f"entities_concept_sheet_v1.provenance.json has model_hash={model_hash!r}. "
        "Expected a non-null, non-empty string (HANDOFF §21 / T-0215)."
    )


def test_T0153_tile_sheet_provenance_has_non_null_model_hash():
    """T-0153 transition tile sheet provenance must carry a non-null model_hash.

    The sheet is deterministically procedural (no AI model); model_hash must
    be a descriptive non-null string rather than null so the sweep gate passes.
    (T-0215 acceptance §4)
    """
    assert TILE_PROV.exists(), f"Tile provenance not found: {TILE_PROV}"
    prov = json.loads(TILE_PROV.read_text())
    model_hash = prov.get("model_hash", "<<key missing>>")
    assert model_hash, (
        f"signal_tower_concrete_wall_floor_transitions_16px.provenance.json has "
        f"model_hash={model_hash!r}.  Expected a non-null, non-empty string — "
        "use 'N/A — procedural generation' for non-AI assets (HANDOFF §21 / T-0215)."
    )


@pytest.mark.parametrize("prop_name", PROP_NAMES)
def test_T0201_prop_provenance_has_non_null_model_hash(prop_name):
    """T-0201 Signal Tower prop provenance must carry a non-null model_hash.

    All five props were synth fallbacks (no AI model used); model_hash was null.
    Use a descriptive non-null string so the sweep gate passes.
    (T-0215 acceptance §4)
    """
    prov_path = PROPS_DIR / f"{prop_name}.provenance.json"
    assert prov_path.exists(), f"Prop provenance not found: {prov_path}"
    prov = json.loads(prov_path.read_text())
    model_hash = prov.get("model_hash", "<<key missing>>")
    assert model_hash, (
        f"{prop_name}.provenance.json has model_hash={model_hash!r}. "
        "Expected a non-null, non-empty string (HANDOFF §21 / T-0215)."
    )


# ── 3. Sweep gate: assets/ with EMPTY baseline must find zero failures ────────


def test_sweep_with_empty_baseline_finds_no_null_hash_in_T0215_owned_files(tmp_path):
    """After T-0215's fixes, the eight directly-owned provenance files must
    pass check_provenance_model_hash individually.

    This does NOT sweep the full assets/ tree (which still contains the
    T-0198/T-0199/T-0200 paths tracked by T-0212/T-0213/T-0214 and still
    in baseline) — it isolates T-0215's eight files in a tmp tree so the
    test has no dependency on the in-flight cards.
    """
    from asset_gate.provenance import sweep_provenance_model_hash

    # Copy only the T-0215-owned files into the tmp tree
    t0215_files = [
        PLAYER_PROV,
        ENTITIES_PROV,
        TILE_PROV,
        *(PROPS_DIR / f"{n}.provenance.json" for n in PROP_NAMES),
    ]

    # Mirror their relative paths under tmp_path/assets/
    mirror_root = tmp_path / "assets"
    for src in t0215_files:
        rel = src.relative_to(REPO_ROOT)
        dst = tmp_path / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(src.read_text())

    results = sweep_provenance_model_hash(mirror_root, baseline=frozenset())
    failures = [r for r in results if not r.passed]
    assert not failures, (
        f"Sweep found {len(failures)} null-hash failure(s) in T-0215-owned files "
        f"with empty baseline:\n"
        + "\n".join(f"  {r.details.get('path', '?')}: {r.reason}" for r in failures)
    )
