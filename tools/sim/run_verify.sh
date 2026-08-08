#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]" -q
echo "=== PYTEST ==="
.venv/bin/pytest tests/test_run_inv14.py -v
echo "=== RUFF ==="
.venv/bin/ruff check .
echo "=== ALL PASSED ==="
