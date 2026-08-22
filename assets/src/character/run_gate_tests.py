#!/usr/bin/env python3
"""Run T-0212 gate tests using lora-train-venv (numpy+PIL available) + asset-gate from src."""

import sys
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[3]

# Inject asset-gate and char-gen src paths so pytest can find them without pip install
asset_gate_src = WORKTREE / "tools/asset-gate/src"
char_gen_src = WORKTREE / "assets/src/character/src"
for p in (str(asset_gate_src), str(char_gen_src)):
    if p not in sys.path:
        sys.path.insert(0, p)

if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([
        str(WORKTREE / "assets/src/character/tests/test_player_idle_v2_gate.py"),
        "-v",
    ]))
