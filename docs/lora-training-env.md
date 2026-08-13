# WSL-native LoRA training environment (T-0072, "option 3")

**Author:** Claude (Sonnet 5)
**Date:** 2026-08-12

Previously, `assets/src/lora/pyproject.toml` explicitly excluded GPU/training
deps with the note "installed separately on the GPU box" — i.e. this repo
assumed a human would run the actual `accelerate launch` training step by
hand on a machine with a GPU. This doc records replacing that manual step
with a WSL-native stack the `assets` agent can invoke itself.

## Why this is possible now

`docs/comfyui-setup.md` (T-0070) and `docs/env-inventory.md` both flagged
"no GPU passthrough in WSL" as of 2026-08-02. Re-checked 2026-08-12: this
is no longer true. `nvidia-smi` inside WSL (Ubuntu-24.04) sees the RTX
3070 Ti Laptop GPU directly (driver 581.57, CUDA 13.0), and a WSL-native
PyTorch install gets real CUDA access. ComfyUI itself stays on the Windows
host (no reason to move a working setup) — only the training stack is
WSL-native.

## Setup

`assets/src/lora/setup-training-env.sh` (idempotent) creates:

- **`~/dev/lora-train-venv`** — Python 3.12 venv on the WSL Linux
  filesystem (never `/mnt/*`, per this repo's WSL-UNC-ownership
  convention — Windows-side access to WSL paths creates root-owned files;
  a venv the Windows side never touches avoids that entirely).
  - `torch==2.5.1+cu121` / `torchvision==0.20.1+cu121` from the PyTorch
    cu121 wheel index — same choice `docs/comfyui-setup.md` made for
    ComfyUI's own venv; cu121 wheels run fine against the 13.0 driver.
  - kohya sd-scripts' own deps, pinned in
    `assets/src/lora/training-requirements.txt` (accelerate, transformers,
    diffusers, bitsandbytes, safetensors, etc.) — deliberately **not**
    added to `pyproject.toml`'s `dependencies`, since these are GPU-specific
    multi-GB wheels that don't belong in a plain CPU-only editable dev
    install (see that file's `[project]` comment and
    `training-requirements.txt`'s header for the full rationale).
- **`~/dev/sd-scripts`** — kohya sd-scripts checkout, commit
  `37a1cbbc5725ed2a3575506e7bd2001c9908ac92` (pinned in the setup script).
  The SDXL LoRA entry point is `sdxl_train_network.py`, not the SD1.5
  `train_network.py` an earlier revision of `training_config.toml`'s
  header comment named — corrected there and in
  `assets/src/lora/src/lora_train/train.py`, the new module that turns
  `training_config.toml` into a real `accelerate launch` invocation
  (dataset TOML generation + CLI arg building; see its docstring).

## Verification (2026-08-12)

```
$ python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
2.5.1+cu121 True NVIDIA GeForce RTX 3070 Ti Laptop GPU

$ accelerate env
...
PyTorch version (GPU?): 2.5.1+cu121 (True)
GPU type: NVIDIA GeForce RTX 3070 Ti Laptop GPU

$ python sdxl_train_network.py --help
# clean --help output, no import errors
```

## 8GB VRAM tuning

`training_config.toml`'s existing settings (rank=16, alpha=8, batch_size=1,
resolution=1024, fp16, AdamW8bit, cache_latents=true) were kept as-is —
1024 is SDXL-native and the config's own validator (`config.py`) rejects
anything else. `lora_train.train.build_train_args` adds, on top of that:

- `--gradient_checkpointing` — trades compute for activation memory.
- `--sdpa` — PyTorch's native memory-efficient attention (Ampere-class
  GPU support built in since torch 2.0); chosen over installing `xformers`
  separately, since `xformers` wheels are finicky to match against an
  exact torch+CUDA build and `--sdpa` needs no extra dependency.

**Flagged, not applied:** `--cache_text_encoder_outputs` would free more
VRAM (SDXL's two text encoders wouldn't need to stay resident during the
U-Net loop) but sd-scripts refuses to combine it with `shuffle_caption`
(hard `AssertionError` at startup — verified live, see smoke test below).
`training_config.toml`'s `dataset.shuffle = true` is treated as a
deliberate corpus-augmentation choice, not an oversight, so this flag was
left off rather than silently changing that behavior. If a future full
run OOMs, the tradeoff to revisit is: set `shuffle = false` and re-add
`--cache_text_encoder_outputs`.

## Smoke test (2026-08-12)

Ran `PYTHONPATH=src python -m lora_train.train --max-train-steps 10`
against the **real** T-0072 corpus — 18 of the 44 refs were on disk at
smoke-test time (Wikimedia Commons rate-limits `lora_train.fetch` after
~18-20 rapid requests in a single run; a known, pre-existing gap, not
something this task fixed — see the module's docstring). 18 real,
license-verified images is more than enough to exercise the full training
path; the remaining refs only matter for the eventual full 10-epoch T-0072
run, which should re-run `lora_train.fetch --download` with pauses between
batches (or reuse whatever's already cached in `refs/` — the fetch script
doesn't overwrite what's already correct on disk).

- Checkpoint loaded from `/mnt/f/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors`
  (no re-download needed — same file ComfyUI already uses).
- Latent caching: 18/18 images cached successfully.
- LoRA network created: 264 text-encoder modules + 722 U-Net modules,
  rank 16 / alpha 8, matching `training_config.toml`.
- **VRAM peak: 8005 MiB used / 8192 MiB total — 14 MiB free.** Training
  completed all 10 steps without OOM (`avr_loss` moving, e.g.
  `0.0104 → 0.13` across the first two steps — real gradient updates, not
  a no-op), but the margin is razor-thin. This is right at the edge of
  what 8GB can do for SDXL LoRA training even with gradient checkpointing
  + sdpa; a full 10-epoch (~180-step, 18-image) or 400-step (44-image)
  run is not guaranteed OOM-free purely on the strength of this 10-step
  smoke test, though nothing in the trend across 10 steps suggested
  growing memory pressure (steady-state ~8.0 GB, not climbing).
- Output: `assets/final/lora/soviet_brutalism_style_v1.safetensors`
  written, confirmed to be a valid safetensors file (header parses,
  correct LoRA key structure) — see the smoke run's artifact for details.
  This is a 10-step, massively under-trained checkpoint, kept only as
  pipeline proof, not usable output — **do not treat it as the real T-0072
  deliverable.** The real deliverable is produced by re-running T-0072 on
  the board with the full `training_config.toml` epoch count.

## Deploy to ComfyUI (automated)

`training_config.toml`'s `output.dir = "assets/final/lora"` is
repo-relative by design (`config.py`'s validator requires
`output_dir.startswith("assets/final/")`) — training writes into the git
repo, not directly to ComfyUI. `lora_train.train.main` now copies the
result there itself: after `accelerate launch sdxl_train_network.py`
exits 0, `deploy_to_comfyui()` validates `assets/final/lora/<output_name>.safetensors`
(non-empty, actually loads via `safetensors.safe_open`) and, if valid,
copies it into the ComfyUI loras directory — default
`/mnt/f/ComfyUI/models/loras/` (`F:\ComfyUI\models\loras\`, confirmed
writable from both the Windows side and the `~/dev/lora-train-venv`
python), overridable via `LORA_COMFYUI_LORAS_DIR`. The target directory
is created if missing. A copy failure (missing/invalid source, disk
error) is logged to stderr and returns `None` — it does **not** fail the
training run itself, since a good weight file sitting in `assets/final/`
is still a successful outcome even if the copy hiccups.

Manual equivalent, if ever needed:

```
cp assets/final/lora/soviet_brutalism_style_v1.safetensors /mnt/f/ComfyUI/models/loras/
```

## Git LFS (2026-08-13)

A trained SDXL LoRA (`soviet_brutalism_style_v1.safetensors`, 218MB) is
well over GitHub's 100MB per-blob limit — the first real T-0072 training
run committed fine locally but `git push` was rejected outright ("this
exceeds GitHub's file size limit... Try Git LFS"), landing the card in
`blocked` even though training itself had already succeeded.

`.gitattributes` now tracks `assets/final/lora/*.safetensors` (plus
`assets/final/**/*.ckpt` and `*.pt` for other trained-weight formats)
via Git LFS, and `git lfs install` has been run for the WSL user, which
also wires the `pre-push` LFS hook into this repo's shared git-common-dir
(`~/dev/assembled/.git`) — every worktree picks it up automatically, no
per-worktree setup needed. As a result, the `assets` agent's ordinary
end-of-task `git add` / `git commit` / `git push` on its feature branch
needs no code changes: a `.safetensors` under `assets/final/lora/` is
transparently swapped for an LFS pointer at commit time and the real
blob is uploaded to LFS storage on push. Future full training runs
should push cleanly; if a push is ever rejected again, check `git lfs
env` and `git lfs ls-files` before assuming it's the same 100MB issue.
