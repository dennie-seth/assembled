#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]" -q
echo "=== RUFF ==="
.venv/bin/ruff check .
echo "=== PYTEST ==="
.venv/bin/pytest -v
echo "=== ALL PASSED ==="
