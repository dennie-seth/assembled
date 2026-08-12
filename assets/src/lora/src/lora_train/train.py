"""Drive kohya sd-scripts to actually train the T-0072 style LoRA.

training_config.toml (loaded via lora_train.config) is the reproducible
*specification*; this module is the missing glue that turns it into a real
`accelerate launch sdxl_train_network.py` invocation against
`assets/src/lora/refs/` (populated by `lora_train.fetch --download`).

sd-scripts' config-based dataset method (`--dataset_config`) is used
instead of its DreamBooth folder-naming convention, since it matches our
existing flat `refs/ref_NNN.jpg` + `ref_NNN.txt` caption layout without
renaming anything.

Note: the checkpoint is SDXL, so the correct sd-scripts entry point is
`sdxl_train_network.py`, not the SD1.5 `train_network.py` referenced in
training_config.toml's header comment (a leftover from before that file
was checked against a real sd-scripts checkout).

8GB-VRAM flags (see docs/lora-training-env.md for why): `--gradient_checkpointing`,
`--sdpa` (PyTorch native memory-efficient attention -- no xformers install
needed), `--cache_latents` (already in training_config.toml), and
`--cache_text_encoder_outputs` (SDXL carries two text encoders; caching
their output once up front means only the U-Net stays resident during the
training loop itself).

Environment (WSL-native training stack, see setup-training-env.sh):
    LORA_SD_SCRIPTS_DIR   default: ~/dev/sd-scripts
    LORA_CHECKPOINT_PATH  default: /mnt/f/ComfyUI/models/checkpoints/<base_checkpoint>
"""

from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys

from lora_train.config import TrainingConfig, load_config

_DEFAULT_SD_SCRIPTS_DIR = pathlib.Path.home() / "dev" / "sd-scripts"
_DEFAULT_CHECKPOINT_ROOT = pathlib.Path("/mnt/f/ComfyUI/models/checkpoints")


def resolve_sd_scripts_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("LORA_SD_SCRIPTS_DIR", str(_DEFAULT_SD_SCRIPTS_DIR)))


def resolve_checkpoint_path(config: TrainingConfig) -> pathlib.Path:
    override = os.environ.get("LORA_CHECKPOINT_PATH")
    if override:
        return pathlib.Path(override)
    return _DEFAULT_CHECKPOINT_ROOT / config.base_checkpoint


def build_dataset_toml(config: TrainingConfig, refs_dir: pathlib.Path) -> str:
    """Render a kohya sd-scripts `--dataset_config` TOML for `refs_dir`.

    One subset, per-image sibling caption files (`caption_ext` from
    training_config.toml), no DreamBooth-style repeat-folder naming needed.
    """
    return (
        "[general]\n"
        'caption_extension = ".txt"\n'
        f"shuffle_caption = {str(config.shuffle).lower()}\n"
        "\n"
        "[[datasets]]\n"
        f"resolution = {config.resolution}\n"
        f"batch_size = {config.batch_size}\n"
        f"  [[datasets.subsets]]\n"
        f'  image_dir = "{refs_dir}"\n'
        "  num_repeats = 1\n"
    )


def build_train_args(
    config: TrainingConfig,
    *,
    checkpoint_path: pathlib.Path,
    dataset_config_path: pathlib.Path,
    output_dir: pathlib.Path,
    max_train_steps: int | None = None,
) -> list[str]:
    """Build the `sdxl_train_network.py` CLI argument list from `config`.

    `max_train_steps` overrides `config.num_epochs` for a short smoke run;
    when omitted, trains the full `num_epochs` specified in
    training_config.toml.
    """
    args = [
        f"--pretrained_model_name_or_path={checkpoint_path}",
        f"--dataset_config={dataset_config_path}",
        f"--output_dir={output_dir}",
        f"--output_name={config.output_name}",
        "--save_model_as=safetensors",
        "--network_module=networks.lora",
        f"--network_dim={config.network_rank}",
        f"--network_alpha={config.network_alpha}",
        f"--learning_rate={config.learning_rate}",
        f"--optimizer_type={config.optimizer}",
        f"--mixed_precision={config.mixed_precision}",
        "--gradient_checkpointing",
        "--sdpa",
        "--no_half_vae",
    ]
    # NOTE: --cache_text_encoder_outputs is deliberately NOT used here even
    # though it would save VRAM (SDXL's two text encoders don't need to stay
    # resident during the U-Net loop) -- sd-scripts refuses to combine it
    # with shuffle_caption (AssertionError at startup), and
    # training_config.toml's dataset.shuffle=true is a deliberate config
    # choice for this corpus, not an oversight. If VRAM pressure demands it,
    # the tradeoff is: drop caption shuffling (set shuffle=false in
    # training_config.toml) to re-enable this flag.
    if config.cache_latents:
        args.append("--cache_latents")
    if max_train_steps is not None:
        args.append(f"--max_train_steps={max_train_steps}")
    else:
        args.append(f"--max_train_epochs={config.num_epochs}")
    return args


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Train the T-0072 SDXL style LoRA via kohya sd-scripts"
    )
    _repo_root_default = pathlib.Path(__file__).resolve().parents[5]
    parser.add_argument(
        "--repo-root",
        type=pathlib.Path,
        default=_repo_root_default,
        help="Repo root that output_dir/dataset_dir in training_config.toml are relative to",
    )
    parser.add_argument(
        "--config",
        type=pathlib.Path,
        default=_repo_root_default / "assets" / "src" / "lora" / "training_config.toml",
    )
    parser.add_argument(
        "--max-train-steps",
        type=int,
        default=None,
        help="Override num_epochs with a fixed step count (smoke tests)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print the command, don't run it")
    args = parser.parse_args(argv)

    config = load_config(args.config)
    refs_dir = args.repo_root / config.dataset_dir
    output_dir = args.repo_root / config.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    scratch_dir = args.repo_root / "assets" / "src" / "lora" / ".train-scratch"
    scratch_dir.mkdir(parents=True, exist_ok=True)
    dataset_config_path = scratch_dir / "dataset_config.toml"
    dataset_config_path.write_text(build_dataset_toml(config, refs_dir), encoding="utf-8")

    checkpoint_path = resolve_checkpoint_path(config)
    if not checkpoint_path.exists():
        print(f"checkpoint not found: {checkpoint_path}", file=sys.stderr)
        return 1

    sd_scripts_dir = resolve_sd_scripts_dir()
    train_script = sd_scripts_dir / "sdxl_train_network.py"
    if not train_script.exists():
        print(f"sd-scripts train script not found: {train_script}", file=sys.stderr)
        return 1

    train_args = build_train_args(
        config,
        checkpoint_path=checkpoint_path,
        dataset_config_path=dataset_config_path,
        output_dir=output_dir,
        max_train_steps=args.max_train_steps,
    )
    # Resolve `accelerate` next to the running interpreter rather than via
    # PATH -- the assets agent invokes this module with the training venv's
    # absolute python path (no `source .../activate` step, so PATH isn't
    # necessarily updated), same as how it invokes `python` itself.
    accelerate_bin = pathlib.Path(sys.executable).parent / "accelerate"
    cmd = [str(accelerate_bin), "launch", str(train_script), *train_args]

    if args.dry_run:
        print(" ".join(cmd))
        return 0

    result = subprocess.run(cmd, cwd=sd_scripts_dir)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
