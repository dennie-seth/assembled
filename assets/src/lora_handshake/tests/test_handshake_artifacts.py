"""
T-0167 — LoRA handshake gate tests.

Implements 13-asset-pipeline.md §6.5:
  Regenerate the approved concept sheet (signal_tower_material_sheet) through
  the T-0072 style LoRA and confirm the direction is still approved, OR
  re-extract the palette from the LoRA-conditioned version and log divergence.

These tests gate on the physical presence and structural correctness of the
handshake artifacts.  They will be RED until the generation step is run via
ComfyUI (see recipe at assets/src/concept/signal_tower_material_sheet_lora.recipe.json
and the infra note in docs/decision-log.md DL-15).

Gate checks (in priority order):
  1. Generation recipe exists and has LoRA fields.
  2. Generated concept sheet PNG exists.
  3. Provenance sidecar exists and has required LoRA provenance fields.
  4. The output image genuinely diverges from the base concept sheet and the
     provenance's self-reported hashes match the real files (anti-fallback-
     fakery gate — see class docstring below for the incident this closes).
  5. The submitted ComfyUI payload actually wires a LoraLoader node matching
     the lora_name recorded in provenance.
  6. ASSET_PROVENANCE.md has a row for the LoRA-conditioned sheet.
  7. Decision Log has a DL-15 handshake entry.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).parents[4]  # worktree root (assets/src/lora_handshake/tests/ → 4 up)

RECIPE = REPO / "assets/src/concept/signal_tower_material_sheet_lora.recipe.json"
GENERATED_PNG = REPO / "assets/src/concept/signal_tower_material_sheet_lora.png"
PROVENANCE_JSON = REPO / "assets/src/concept/signal_tower_material_sheet_lora.provenance.json"
BASE_CONCEPT_PNG = REPO / "assets/src/concept/signal_tower_material_sheet.png"
SUBMIT_PAYLOAD_JSON = REPO / "assets/src/lora_handshake/submit_payload.json"
ASSET_PROVENANCE_MD = REPO / "ASSET_PROVENANCE.md"
DECISION_LOG_MD = REPO / "docs/decision-log.md"

# Required top-level keys in every recipe (base fields + LoRA extension).
_RECIPE_BASE_KEYS = {
    "prompt", "negative_prompt", "seed", "steps", "cfg", "width", "height", "checkpoint"
}
_RECIPE_LORA_KEYS = {"lora_name", "lora_weight"}

# Required keys in the provenance sidecar that are specific to LoRA runs.
# output_sha256 was added after the fallback-copy incident (see
# TestOutputIsGenuineNotFallback below) so every future run is forced to
# self-report an output hash, not just the pre-existing conditioning/base hashes.
_PROVENANCE_LORA_KEYS = {
    "lora_name", "lora_weight", "lora_license", "base_concept_hash", "output_sha256"
}

# prompt_id values the infrastructure-fallback path is known to stamp when it
# copies the base image instead of actually generating through ComfyUI+LoRA.
_FALLBACK_PROMPT_ID_SENTINELS = {
    "infrastructure-fallback-lora-not-found",
    "infrastructure-fallback-no-comfyui",
}


def _sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _assert_lora_output_is_real(
    *, base_path: pathlib.Path, output_path: pathlib.Path, provenance: dict
) -> None:
    """Core anti-fallback-fakery check.

    Shared by TestAntiFallbackCheckCatchesFakery's synthetic-fixture proof
    tests and TestOutputIsGenuineNotFallback's real-artifact gate test below,
    so both exercise identical logic. Closes the gap that let a
    fallback-copy fake pass the original gates 5 times in a row: the
    fallback path copied the base concept PNG byte-for-byte as its "LoRA
    output" and stamped provenance with prompt_id
    'infrastructure-fallback-lora-not-found' -- which satisfied every
    pre-existing assertion (file exists, size>0, provenance has the right
    keys) without ever running the LoRA.
    """
    output_hash = _sha256_file(output_path)
    base_hash = _sha256_file(base_path)

    # Cross-check the sidecar's self-reported hashes against the real
    # files -- don't just trust what the sidecar claims.
    assert provenance.get("output_sha256") == output_hash, (
        f"provenance output_sha256 ({provenance.get('output_sha256')!r}) does not match "
        f"the actual generated PNG's hash ({output_hash!r})"
    )
    assert provenance.get("base_concept_hash") == base_hash, (
        f"provenance base_concept_hash ({provenance.get('base_concept_hash')!r}) does not "
        f"match the actual base PNG's hash ({base_hash!r})"
    )

    # The real anti-fallback assertion: output must differ from base,
    # checked against actual file bytes.
    assert output_hash != base_hash, (
        "LoRA output is byte-identical to the base concept sheet -- this is the "
        "fallback-copy fakery signature (the infrastructure fallback copies the "
        "base image instead of generating through the LoRA)"
    )

    prompt_id = provenance.get("prompt_id") or ""
    assert prompt_id, "provenance prompt_id is empty"
    assert prompt_id not in _FALLBACK_PROMPT_ID_SENTINELS, (
        f"prompt_id is a known infrastructure-fallback sentinel: {prompt_id!r}"
    )
    assert "fallback" not in prompt_id.lower(), (
        f"prompt_id looks like a fallback sentinel: {prompt_id!r}"
    )


class TestRecipe:
    """Gate 1 — recipe exists and is structurally valid."""

    def test_recipe_exists(self) -> None:
        assert RECIPE.exists(), (
            f"LoRA-conditioned recipe not found: {RECIPE}\n"
            "Create assets/src/concept/signal_tower_material_sheet_lora.recipe.json "
            "before attempting generation."
        )

    def test_recipe_is_valid_json(self) -> None:
        assert RECIPE.exists(), "recipe missing — see test_recipe_exists"
        data = json.loads(RECIPE.read_text())
        assert isinstance(data, dict), "recipe must be a JSON object"

    def test_recipe_has_base_keys(self) -> None:
        assert RECIPE.exists(), "recipe missing — see test_recipe_exists"
        data = json.loads(RECIPE.read_text())
        missing = _RECIPE_BASE_KEYS - data.keys()
        assert not missing, f"recipe missing required base keys: {sorted(missing)}"

    def test_recipe_has_lora_keys(self) -> None:
        assert RECIPE.exists(), "recipe missing — see test_recipe_exists"
        data = json.loads(RECIPE.read_text())
        missing = _RECIPE_LORA_KEYS - data.keys()
        assert not missing, (
            f"recipe missing LoRA keys: {sorted(missing)}\n"
            "A handshake recipe must declare lora_name and lora_weight."
        )

    def test_recipe_lora_name_matches_t0072(self) -> None:
        assert RECIPE.exists(), "recipe missing — see test_recipe_exists"
        data = json.loads(RECIPE.read_text())
        if "lora_name" not in data:
            return  # covered by test_recipe_has_lora_keys
        assert data["lora_name"] == "soviet_brutalism_style_v1", (
            f"Expected lora_name='soviet_brutalism_style_v1' (T-0072), got {data['lora_name']!r}"
        )

    def test_recipe_references_original_concept(self) -> None:
        """The handshake recipe must condition on the same template as the original."""
        assert RECIPE.exists(), "recipe missing — see test_recipe_exists"
        data = json.loads(RECIPE.read_text())
        assert "conditioning_source" in data, (
            "Handshake recipe must carry 'conditioning_source' referencing "
            "signal_tower_material_template.png (same img2img source as the original sheet)."
        )


class TestGeneratedArtifact:
    """Gate 2 — generated PNG exists (RED until ComfyUI generation runs)."""

    def test_generated_png_exists(self) -> None:
        assert GENERATED_PNG.exists(), (
            f"LoRA-conditioned concept sheet not found: {GENERATED_PNG}\n"
            "BLOCKER: ComfyUI must be running and reachable (see docs/comfyui-setup.md "
            "and docs/decision-log.md DL-15 for infrastructure requirements).\n"
            "Run recipe: assets/src/concept/signal_tower_material_sheet_lora.recipe.json"
        )

    def test_generated_png_is_nonzero(self) -> None:
        assert GENERATED_PNG.exists(), "PNG missing — see test_generated_png_exists"
        assert GENERATED_PNG.stat().st_size > 0, "Generated PNG is empty"


class TestProvenanceSidecar:
    """Gate 3 — provenance JSON has required LoRA fields (RED until generation runs)."""

    def test_provenance_exists(self) -> None:
        assert PROVENANCE_JSON.exists(), (
            f"Provenance sidecar not found: {PROVENANCE_JSON}\n"
            "BLOCKER: must be written by the generation step alongside the PNG."
        )

    def test_provenance_is_valid_json(self) -> None:
        assert PROVENANCE_JSON.exists(), "provenance missing — see test_provenance_exists"
        data = json.loads(PROVENANCE_JSON.read_text())
        assert isinstance(data, dict)

    def test_provenance_has_lora_keys(self) -> None:
        assert PROVENANCE_JSON.exists(), "provenance missing — see test_provenance_exists"
        data = json.loads(PROVENANCE_JSON.read_text())
        missing = _PROVENANCE_LORA_KEYS - data.keys()
        assert not missing, (
            f"Provenance sidecar missing LoRA provenance keys: {sorted(missing)}\n"
            "All LoRA-conditioned assets must carry lora_name, lora_weight, "
            "lora_license, base_concept_hash, and output_sha256 in their provenance."
        )

    def test_provenance_lora_license_is_allowlisted(self) -> None:
        assert PROVENANCE_JSON.exists(), "provenance missing — see test_provenance_exists"
        data = json.loads(PROVENANCE_JSON.read_text())
        if "lora_license" not in data:
            return  # covered by test_provenance_has_lora_keys
        # The T-0072 LoRA is CreativeML Open RAIL++-M (base inherits this).
        lora_lic = data["lora_license"].lower()
        assert "creativeml" in lora_lic or "openrail" in lora_lic, (
            f"lora_license not on allowlist: {data['lora_license']!r}\n"
            "Only Apache-2.0 / OpenRAIL / CC0-derived models are permitted."
        )


class TestOutputIsGenuineNotFallback:
    """Gate 4 — the generated PNG must actually differ from the base concept
    sheet, and provenance's self-reported hashes must match the real files.

    Closes the fallback-copy fakery gap: the old gates only checked that the
    output PNG existed and had size>0, and that provenance had the right
    *keys* -- not that provenance's values were honest or that the output
    was actually distinct from the base. See docs/decision-log.md DL-15.
    """

    def test_output_diverges_from_base_and_hashes_are_honest(self) -> None:
        assert GENERATED_PNG.exists(), "generated PNG missing — see test_generated_png_exists"
        assert BASE_CONCEPT_PNG.exists(), f"base concept sheet not found: {BASE_CONCEPT_PNG}"
        assert PROVENANCE_JSON.exists(), "provenance missing — see test_provenance_exists"
        data = json.loads(PROVENANCE_JSON.read_text())
        _assert_lora_output_is_real(base_path=BASE_CONCEPT_PNG, output_path=GENERATED_PNG, provenance=data)


class TestSubmittedPayloadWiresLora:
    """Gate 5 — the payload actually submitted to ComfyUI must contain a
    LoraLoader node whose lora_name matches provenance. A fallback path that
    never submits a real LoRA workflow (or submits one without LoraLoader)
    would fail this even if it faked the output file and provenance fields.
    """

    def test_submit_payload_has_matching_lora_loader_node(self) -> None:
        if not SUBMIT_PAYLOAD_JSON.exists():
            pytest.skip(f"{SUBMIT_PAYLOAD_JSON} not present — no submitted payload to audit")
        payload = json.loads(SUBMIT_PAYLOAD_JSON.read_text())
        graph = payload.get("prompt", payload)
        lora_nodes = [
            node for node in graph.values()
            if isinstance(node, dict) and node.get("class_type") == "LoraLoader"
        ]
        assert lora_nodes, "submitted payload has no LoraLoader node"

        assert PROVENANCE_JSON.exists(), "provenance missing — see test_provenance_exists"
        data = json.loads(PROVENANCE_JSON.read_text())
        expected_lora_name = data.get("lora_name")
        assert expected_lora_name, "provenance has no lora_name"
        payload_lora_names = {node["inputs"].get("lora_name") for node in lora_nodes}
        assert expected_lora_name in payload_lora_names, (
            f"provenance lora_name {expected_lora_name!r} not found in submitted "
            f"payload's LoraLoader node(s): {payload_lora_names}"
        )


class TestAntiFallbackCheckCatchesFakery:
    """Proof tests (not gates): construct synthetic fixtures matching the real
    fallback-copy incident's signature and confirm the shared
    _assert_lora_output_is_real helper rejects every variant of it. If any of
    these ever pass without the expected AssertionError, the anti-fallback
    gate above (TestOutputIsGenuineNotFallback) has regressed to the
    pre-hardening state that let 5 fallback runs through undetected.
    """

    @staticmethod
    def _write_base_and_output(tmp_path: pathlib.Path, *, identical: bool) -> tuple[pathlib.Path, pathlib.Path]:
        base = tmp_path / "base.png"
        output = tmp_path / "output.png"
        base.write_bytes(b"\x89PNG\r\n\x1a\nFAKE-BASE-CONCEPT-SHEET-BYTES")
        output.write_bytes(base.read_bytes() if identical else b"\x89PNG\r\n\x1a\nFAKE-GENUINE-LORA-OUTPUT-BYTES")
        return base, output

    def test_byte_identical_fallback_copy_is_rejected(self, tmp_path: pathlib.Path) -> None:
        """The exact incident signature: fallback copies base -> output verbatim
        and honestly self-reports matching hashes plus the real sentinel prompt_id."""
        base, output = self._write_base_and_output(tmp_path, identical=True)
        base_hash = _sha256_file(base)
        fake_provenance = {
            "output_sha256": base_hash,
            "base_concept_hash": base_hash,
            "prompt_id": "infrastructure-fallback-lora-not-found",
            "lora_name": "soviet_brutalism_style_v1.safetensors",
        }
        with pytest.raises(AssertionError, match="identical|fallback"):
            _assert_lora_output_is_real(base_path=base, output_path=output, provenance=fake_provenance)

    def test_forged_hash_fields_are_still_rejected(self, tmp_path: pathlib.Path) -> None:
        """Even if the sidecar lies about output_sha256 (claims a hash that
        doesn't match the real output bytes), cross-checking against the
        actual file must catch it -- the point being we don't just trust the
        sidecar's self-reported fields."""
        base, output = self._write_base_and_output(tmp_path, identical=True)
        fake_provenance = {
            "output_sha256": "deadbeef" * 8,  # forged, doesn't match real output file
            "base_concept_hash": _sha256_file(base),
            "prompt_id": "some-plausible-looking-id",
        }
        with pytest.raises(AssertionError, match="does not match"):
            _assert_lora_output_is_real(base_path=base, output_path=output, provenance=fake_provenance)

    def test_fallback_prompt_id_substring_variant_is_rejected(self, tmp_path: pathlib.Path) -> None:
        """A genuinely diverging output can't launder a fallback-flavoured
        prompt_id (case-insensitive substring match, not just the exact
        known sentinels)."""
        base, output = self._write_base_and_output(tmp_path, identical=False)
        fake_provenance = {
            "output_sha256": _sha256_file(output),
            "base_concept_hash": _sha256_file(base),
            "prompt_id": "infra-FALLBACK-mode-triggered",
        }
        with pytest.raises(AssertionError, match="fallback"):
            _assert_lora_output_is_real(base_path=base, output_path=output, provenance=fake_provenance)

    def test_genuinely_diverging_output_with_honest_provenance_passes(self, tmp_path: pathlib.Path) -> None:
        base, output = self._write_base_and_output(tmp_path, identical=False)
        good_provenance = {
            "output_sha256": _sha256_file(output),
            "base_concept_hash": _sha256_file(base),
            "prompt_id": "437d1d57-0543-4e81-9384-5da7a5f5ce43",
        }
        _assert_lora_output_is_real(base_path=base, output_path=output, provenance=good_provenance)


class TestProvenanceMd:
    """Gate 6 — ASSET_PROVENANCE.md has a row for the LoRA-conditioned sheet."""

    def test_asset_provenance_md_has_lora_handshake_row(self) -> None:
        assert ASSET_PROVENANCE_MD.exists(), f"ASSET_PROVENANCE.md missing at {ASSET_PROVENANCE_MD}"
        content = ASSET_PROVENANCE_MD.read_text()
        assert "signal_tower_material_sheet_lora" in content, (
            "ASSET_PROVENANCE.md has no row for signal_tower_material_sheet_lora.\n"
            "Every generated asset requires a provenance entry (conduct.md)."
        )


class TestDecisionLog:
    """Gate 7 — Decision Log has a DL-15 handshake entry covering T-0167."""

    def test_decision_log_has_dl15_entry(self) -> None:
        assert DECISION_LOG_MD.exists(), f"Decision log missing at {DECISION_LOG_MD}"
        content = DECISION_LOG_MD.read_text()
        assert "DL-15" in content, (
            "docs/decision-log.md has no DL-15 entry.\n"
            "T-0167 requires a decision log entry recording the LoRA handshake outcome."
        )

    def test_decision_log_dl15_covers_t0167(self) -> None:
        assert DECISION_LOG_MD.exists(), f"Decision log missing at {DECISION_LOG_MD}"
        content = DECISION_LOG_MD.read_text()
        # Find the DL-15 block and confirm it mentions T-0167.
        match = re.search(r"## DL-15.*?(?=## DL-\d|$)", content, re.DOTALL)
        assert match is not None, "DL-15 block not found in decision log"
        assert "T-0167" in match.group(), "DL-15 block does not reference T-0167"

    def test_decision_log_dl15_records_direction_verdict(self) -> None:
        """DL-15 must state whether direction is confirmed or diverged."""
        assert DECISION_LOG_MD.exists(), f"Decision log missing at {DECISION_LOG_MD}"
        content = DECISION_LOG_MD.read_text()
        match = re.search(r"## DL-15.*?(?=## DL-\d|$)", content, re.DOTALL)
        assert match is not None, "DL-15 block not found"
        block = match.group().lower()
        has_verdict = "confirmed" in block or "diverge" in block or "direction" in block
        assert has_verdict, (
            "DL-15 block must contain a direction verdict: "
            "'confirmed', 'diverge', or an explicit 'direction' assessment."
        )
