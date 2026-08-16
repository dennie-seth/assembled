#!/usr/bin/env bash
# T-0072 training runner — fetch corpus then train the SDXL style LoRA.
# Run from assets/src/lora/ (where corpus.json and training_config.toml live).
# This script is the single command the agent needs approval for.
#
# Steps:
#   1. Install lora_train package editable into the training venv
#   2. Fetch 44 refs from Wikimedia Commons into refs/
#   3. Run accelerate launch sdxl_train_network.py (full 10-epoch run)
#   4. Validate and deploy the output .safetensors to /mnt/f/ComfyUI/models/loras/
#
# Environment:
#   LORA_TRAIN_VENV_DIR  default: ~/dev/lora-train-venv
#   LORA_SD_SCRIPTS_DIR  default: ~/dev/sd-scripts
#   LORA_CHECKPOINT_PATH override for checkpoint (default reads training_config.toml)
#   LORA_COMFYUI_LORAS_DIR override for deploy target

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${LORA_TRAIN_VENV_DIR:-$HOME/dev/lora-train-venv}"
PYTHON="$VENV_DIR/bin/python"

echo "=== Step 1: install lora_train into training venv ==="
"$VENV_DIR/bin/pip" install -e "$SCRIPT_DIR" -q
echo "lora_train installed."

echo ""
echo "=== Step 2: fetch corpus refs ==="
cd "$SCRIPT_DIR"
"$PYTHON" -m lora_train.fetch --download --corpus corpus.json --out refs

echo ""
echo "=== Step 3: train ==="
PYTHONPATH="$SCRIPT_DIR/src" "$PYTHON" -m lora_train.train

echo ""
echo "=== Done ==="
LORA_OUT="$SCRIPT_DIR/../../../final/lora/soviet_brutalism_style_v1.safetensors"
if [ -f "$LORA_OUT" ]; then
    echo "LoRA artifact: $LORA_OUT"
    LORA_SIZE=$(stat -c%s "$LORA_OUT")
    echo "Size: $LORA_SIZE bytes"
    DEPLOY_DIR="${LORA_COMFYUI_LORAS_DIR:-/mnt/f/ComfyUI/models/loras}"
    if [ -f "$DEPLOY_DIR/soviet_brutalism_style_v1.safetensors" ]; then
        echo "Deployed to: $DEPLOY_DIR/soviet_brutalism_style_v1.safetensors"
    else
        echo "WARNING: deploy did not place file in $DEPLOY_DIR"
        echo "Attempting manual copy..."
        cp "$LORA_OUT" "$DEPLOY_DIR/soviet_brutalism_style_v1.safetensors"
        echo "Copied manually."
    fi
else
    echo "ERROR: expected output not found at $LORA_OUT"
    exit 1
fi
