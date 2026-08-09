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
  4. ASSET_PROVENANCE.md has a row for the LoRA-conditioned sheet.
  5. Decision Log has a DL-15 handshake entry.
"""

from __future__ import annotations

import json
import pathlib
import re

REPO = pathlib.Path(__file__).parents[5]  # worktree root

RECIPE = REPO / "assets/src/concept/signal_tower_material_sheet_lora.recipe.json"
GENERATED_PNG = REPO / "assets/src/concept/signal_tower_material_sheet_lora.png"
PROVENANCE_JSON = REPO / "assets/src/concept/signal_tower_material_sheet_lora.provenance.json"
ASSET_PROVENANCE_MD = REPO / "ASSET_PROVENANCE.md"
DECISION_LOG_MD = REPO / "docs/decision-log.md"

# Required top-level keys in every recipe (base fields + LoRA extension).
_RECIPE_BASE_KEYS = {"prompt", "negative_prompt", "seed", "steps", "cfg", "width", "height", "checkpoint"}
_RECIPE_LORA_KEYS = {"lora_name", "lora_weight"}

# Required keys in the provenance sidecar that are specific to LoRA runs.
_PROVENANCE_LORA_KEYS = {"lora_name", "lora_weight", "lora_license", "base_concept_hash"}


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
            "lora_license, and base_concept_hash in their provenance."
        )

    def test_provenance_lora_license_is_allowlisted(self) -> None:
        assert PROVENANCE_JSON.exists(), "provenance missing — see test_provenance_exists"
        data = json.loads(PROVENANCE_JSON.read_text())
        if "lora_license" not in data:
            return  # covered by test_provenance_has_lora_keys
        # The T-0072 LoRA is CreativeML Open RAIL++-M (base inherits this).
        assert "creativeml" in data["lora_license"].lower() or "openrail" in data["lora_license"].lower(), (
            f"lora_license not on allowlist: {data['lora_license']!r}\n"
            "Only Apache-2.0 / OpenRAIL / CC0-derived models are permitted."
        )


class TestProvenanceMd:
    """Gate 4 — ASSET_PROVENANCE.md has a row for the LoRA-conditioned sheet."""

    def test_asset_provenance_md_has_lora_handshake_row(self) -> None:
        assert ASSET_PROVENANCE_MD.exists(), f"ASSET_PROVENANCE.md missing at {ASSET_PROVENANCE_MD}"
        content = ASSET_PROVENANCE_MD.read_text()
        assert "signal_tower_material_sheet_lora" in content, (
            "ASSET_PROVENANCE.md has no row for signal_tower_material_sheet_lora.\n"
            "Every generated asset requires a provenance entry (conduct.md)."
        )


class TestDecisionLog:
    """Gate 5 — Decision Log has a DL-15 handshake entry covering T-0167."""

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
