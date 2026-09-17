"""Shared conftest: sys.path wiring for the character gate test suite.

Adds tools/asset-gate/src to sys.path at module level so that
`pytest.importorskip("asset_gate.art")` in the test modules resolves correctly
without requiring a separate pip install step. Same for this package's own
src/ (char_gen — needed by generator scripts under src/char_gen) and
assets/src/lora/src (lora_train.config — needed by the Arm B, T-0229,
identity-curation/training gate tests) so a plain `pytest` run against a
venv that only has this package's [dev] deps installed, not every editable
package pip would otherwise chain-install, still collects cleanly.

This file deliberately does NOT generate or otherwise write any sheet into
assets/final/**. It used to (module-level _generate_*/_ensure_* calls plus a
session-scoped autouse fixture that silently synthesized any missing shipped
player/entity sheet directly into the committed assets/final/character and
assets/final/entity trees) -- removed in T-0363. That was a false-provenance
hazard: every *_gate.py test module already asserts its own shipped sheet's
existence with a clear message (e.g. `assert SHEET_PATH.exists(), "idle sheet
not found: ..."`), and auto-generating a replacement here pre-empted that
assertion from ever firing, so a deleted or missing shipped sheet would be
silently replaced by a procedural stand-in on any test run instead of failing
loudly -- exactly the hazard T-0212/T-0217 already paid for. See
tests/test_conftest_no_synthesis_T0363.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]

# Make asset_gate importable from the monorepo's tools/asset-gate package
# without requiring `pip install -e tools/asset-gate` — conftest is loaded
# before test modules, so this is in place before pytest.importorskip runs.
_ASSET_GATE_SRC = _REPO_ROOT / "tools" / "asset-gate" / "src"
if _ASSET_GATE_SRC.exists() and str(_ASSET_GATE_SRC) not in sys.path:
    sys.path.insert(0, str(_ASSET_GATE_SRC))

_CHAR_GEN_SRC = Path(__file__).resolve().parents[1] / "src"
if _CHAR_GEN_SRC.exists() and str(_CHAR_GEN_SRC) not in sys.path:
    sys.path.insert(0, str(_CHAR_GEN_SRC))

_LORA_TRAIN_SRC = _REPO_ROOT / "assets" / "src" / "lora" / "src"
if _LORA_TRAIN_SRC.exists() and str(_LORA_TRAIN_SRC) not in sys.path:
    sys.path.insert(0, str(_LORA_TRAIN_SRC))
