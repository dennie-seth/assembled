#!/usr/bin/env bash
# T-0202: setup venv, install deps, run pipeline to produce the Ogg artifact,
# then run tests and lint. Run from assets/src/ambience_synth/:
#   bash setup_and_run.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Creating venv ==="
python3 -m venv .venv

echo "=== Installing dependencies ==="
.venv/bin/pip install -e ".[dev]" -e ../../../tools/asset-gate

echo "=== Running pipeline (produces assets/final/audio/signal_tower_ambience.ogg) ==="
.venv/bin/python -m ambience_synth.pipeline

echo "=== Running tests ==="
.venv/bin/pytest -v

echo "=== Running ruff lint ==="
.venv/bin/ruff check --fix .
.venv/bin/ruff check .

echo "=== All done ==="
