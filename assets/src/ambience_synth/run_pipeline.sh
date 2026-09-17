#!/usr/bin/env bash
# T-0202: Run the ambience pipeline to produce the committed artifact.
# Run from the worktree root or assets/src/ambience_synth/.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
OUT="$(cd ../../.. && pwd)/final/audio/signal_tower_ambience.ogg"
mkdir -p "$(dirname "$OUT")"
.venv/bin/python -m ambience_synth.pipeline "$OUT"
echo "Artifact written to: $OUT"
