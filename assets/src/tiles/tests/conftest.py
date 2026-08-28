"""Test-collection wiring for the T-0232 Signal Tower tileset gate tests.

Adds tools/asset-gate/src to sys.path at module level so that
`pytest.importorskip("asset_gate.art")` in the test modules resolves
correctly without requiring a separate `pip install -e tools/asset-gate`
step -- conftest is loaded before test modules, so this is in place before
any `importorskip` runs. Same pattern as
assets/src/character/tests/conftest.py and
assets/src/concept/tests/conftest.py: a plain `pytest` run against a venv
that only has this package's own `[dev]` deps installed (per the routed
`pip install -e ".[dev]"` command) still collects and runs the asset-gate
checks, instead of `importorskip` silently skipping every gate test.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]

_ASSET_GATE_SRC = _REPO_ROOT / "tools" / "asset-gate" / "src"
if _ASSET_GATE_SRC.exists() and str(_ASSET_GATE_SRC) not in sys.path:
    sys.path.insert(0, str(_ASSET_GATE_SRC))
