#!/usr/bin/env bash
# Set up the WSL-native LoRA training stack (T-0072, "option 3": no manual
# Windows step). Idempotent — safe to re-run.
#
# Creates:
#   ~/dev/lora-train-venv   CUDA-enabled PyTorch + kohya sd-scripts deps
#   ~/dev/sd-scripts        kohya sd-scripts checkout (train_network.py's
#                           real implementation; SDXL entry point is
#                           sdxl_train_network.py)
#
# Both live on the WSL Linux filesystem, never under /mnt/*, per this
# repo's WSL-UNC-ownership convention (root-owned-file risk from Windows
# UNC access does not apply to paths the Windows side never touches).
#
# Verified working here: RTX 3070 Ti Laptop GPU, 8GB VRAM, driver 581.57 /
# CUDA 13.0 (cu121 wheels run fine against it, same choice docs/comfyui-setup.md
# made for ComfyUI itself). See training-requirements.txt for exact pins
# and docs/lora-training-env.md for the verification + smoke-test record.
set -euo pipefail

VENV_DIR="${LORA_TRAIN_VENV_DIR:-$HOME/dev/lora-train-venv}"
SD_SCRIPTS_DIR="${LORA_SD_SCRIPTS_DIR:-$HOME/dev/sd-scripts}"
SD_SCRIPTS_COMMIT="37a1cbbc5725ed2a3575506e7bd2001c9908ac92"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== venv: $VENV_DIR =="
if [ ! -d "$VENV_DIR" ]; then
  python3.12 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip -q

echo "== torch (cu121) =="
python -c "import torch" 2>/dev/null || \
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

echo "== sd-scripts: $SD_SCRIPTS_DIR =="
if [ ! -d "$SD_SCRIPTS_DIR" ]; then
  git clone https://github.com/kohya-ss/sd-scripts.git "$SD_SCRIPTS_DIR"
fi
git -C "$SD_SCRIPTS_DIR" fetch origin -q
git -C "$SD_SCRIPTS_DIR" checkout "$SD_SCRIPTS_COMMIT" -q

echo "== sd-scripts + training deps =="
pip install -r "$SCRIPT_DIR/training-requirements.txt" -q
pip install -e "$SD_SCRIPTS_DIR" -q

echo "== verify =="
python -c "import torch; assert torch.cuda.is_available(), 'CUDA not available'; print(torch.__version__, torch.cuda.get_device_name(0))"
accelerate env >/dev/null
python -c "import sys; sys.path.insert(0, '$SD_SCRIPTS_DIR'); import networks.lora" \
  && echo "sd-scripts importable"

cat <<EOF

Setup complete.
  venv:       $VENV_DIR
  sd-scripts: $SD_SCRIPTS_DIR  (commit $SD_SCRIPTS_COMMIT)

Train (from assets/src/lora; the assets agent is granted these two exact
binary paths in .claude/agents/assets.md, so use them directly rather
than "source .../activate" -- no PATH-activation step needed):
  "$VENV_DIR/bin/python" -m lora_train.fetch --download --corpus corpus.json --out refs
  PYTHONPATH=src "$VENV_DIR/bin/python" -m lora_train.train
    # add --max-train-steps N for a short smoke run instead of the full
    # training_config.toml num_epochs (lora_train.train itself invokes
    # "$VENV_DIR/bin/accelerate" launch ..., resolved from the running
    # interpreter's own path -- see train.py)

Checkpoint is read from /mnt/f/ComfyUI/models/checkpoints/ by default
(override with LORA_CHECKPOINT_PATH). Output lands in assets/final/lora/
inside the repo, per training_config.toml's committed output_dir -- it is
NOT automatically copied to F:\\ComfyUI\\models\\loras\\. After a real
training run, deploy it there with:
  cp assets/final/lora/soviet_brutalism_style_v1.safetensors /mnt/f/ComfyUI/models/loras/
EOF
