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
    LORA_SD_SCRIPTS_DIR      default: ~/dev/sd-scripts
    LORA_CHECKPOINT_PATH     default: /mnt/f/ComfyUI/models/checkpoints/<base_checkpoint>
    LORA_COMFYUI_LORAS_DIR   default: /mnt/f/ComfyUI/models/loras
"""

from __future__ import annotations

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
from collections.abc import Callable

from lora_train.config import TrainingConfig, load_config

_DEFAULT_SD_SCRIPTS_DIR = pathlib.Path.home() / "dev" / "sd-scripts"
_DEFAULT_CHECKPOINT_ROOT = pathlib.Path("/mnt/f/ComfyUI/models/checkpoints")
_DEFAULT_COMFYUI_LORAS_DIR = pathlib.Path("/mnt/f/ComfyUI/models/loras")


def resolve_sd_scripts_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("LORA_SD_SCRIPTS_DIR", str(_DEFAULT_SD_SCRIPTS_DIR)))


def resolve_checkpoint_path(config: TrainingConfig) -> pathlib.Path:
    override = os.environ.get("LORA_CHECKPOINT_PATH")
    if override:
        return pathlib.Path(override)
    return _DEFAULT_CHECKPOINT_ROOT / config.base_checkpoint


def resolve_comfyui_loras_dir() -> pathlib.Path:
    override = os.environ.get("LORA_COMFYUI_LORAS_DIR")
    if override:
        return pathlib.Path(override)
    return _DEFAULT_COMFYUI_LORAS_DIR


def _validate_safetensors(path: pathlib.Path) -> tuple[bool, str]:
    """Check that `path` is a non-empty file that actually loads as safetensors.

    Uses the `safetensors` package (present in the training venv per
    training-requirements.txt, not this package's own lightweight dev deps)
    imported lazily so this module still imports cleanly outside that venv.
    """
    if not path.exists():
        return False, f"file not found: {path}"
    if path.stat().st_size == 0:
        return False, f"file is empty: {path}"
    try:
        from safetensors import safe_open
    except ModuleNotFoundError as exc:
        return False, f"safetensors package not importable: {exc}"
    try:
        with safe_open(str(path), framework="pt") as f:
            keys = list(f.keys())
    except Exception as exc:  # noqa: BLE001 - report any load failure, don't crash the run
        return False, f"failed to load as safetensors: {exc}"
    if not keys:
        return False, "safetensors file has zero tensors"
    return True, f"valid safetensors ({len(keys)} tensors)"


def deploy_to_comfyui(
    output_path: pathlib.Path,
    target_dir: pathlib.Path | None = None,
    *,
    validate: Callable[[pathlib.Path], tuple[bool, str]] = _validate_safetensors,
) -> pathlib.Path | None:
    """Copy a validated trained LoRA into the ComfyUI loras directory.

    Returns the destination path on success, or None on any failure (missing/
    invalid source file, copy error) -- logged to stderr, never raised, so a
    deploy hiccup never fails the training run that produced a good weight file.
    """
    if target_dir is None:
        target_dir = resolve_comfyui_loras_dir()
    is_valid, message = validate(output_path)
    if not is_valid:
        print(f"[deploy] skipping ComfyUI copy: {message}", file=sys.stderr)
        return None
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        dest = target_dir / output_path.name
        shutil.copy2(output_path, dest)
    except OSError as exc:
        print(f"[deploy] failed to copy {output_path} -> {target_dir}: {exc}", file=sys.stderr)
        return None
    print(f"[deploy] {message}: copied {output_path} -> {dest}")
    return dest


def find_resume_state(output_dir: pathlib.Path, output_name: str) -> pathlib.Path | None:
    """Find the sd-scripts `--save_state` checkpoint dir to resume from.

    sd-scripts writes a state dir in one of three shapes (`library/checkpoint_io.py`):
    a numbered `{output_name}-{epoch:06d}-state` per *intermediate* epoch boundary
    (EPOCH_STATE_NAME), a numbered `{output_name}-step{step:08d}-state` per
    step-cadence boundary (STEP_STATE_NAME, `--save_every_n_steps`), or a single
    unnumbered `{output_name}-state` (LAST_STATE_NAME) written whenever a run
    reaches its actual end (`save_state_on_train_end`) -- which is what every
    run's FINAL epoch gets, since `train_network.py` deliberately excludes the
    last epoch from the numbered per-epoch save. A run that completes normally
    (every real training invocation, not just an interrupted smoke test) always
    produces this bare, unnumbered shape -- confirmed empirically (T-0248) by
    running training end-to-end and observing that the original numbered-only
    glob never matched it, so a real run's own checkpoint was silently never
    resumable. All three shapes are resumed identically via `--resume <dir>`,
    so the most-recently-written one (by mtime) is always the correct resume
    point regardless of which produced it. Returns None for a fresh run (no
    state dir yet).
    """
    prefix = f"{output_name}-"
    candidates = [
        p
        for p in output_dir.iterdir()
        if p.is_dir() and p.name.startswith(prefix) and p.name.endswith("-state")
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


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
    resume_state: pathlib.Path | None = None,
    save_every_n_steps: int | None = None,
) -> list[str]:
    """Build the `sdxl_train_network.py` CLI argument list from `config`.

    `max_train_steps` overrides `config.num_epochs` for a short smoke run;
    when omitted, trains the full `num_epochs` specified in
    training_config.toml.

    `resume_state` (from `find_resume_state`) continues an interrupted run
    instead of restarting at step 0 -- rule (b): this environment's per-call
    wall-clock budget is well under a full training run's wall-clock, so a
    single card's training phase is many separate invocations of this
    module, each resuming where the last left off.

    `config.save_every_n_epochs`'s cadence is always paired with `--save_state`
    (T-0248), so every epoch boundary writes a full resumable state dir, not
    just the LoRA weight snapshot. `save_every_n_steps` (independent of
    `config.save_every_n_epochs`, which stays the reproducibility-spec cadence
    for the emitted LoRA weights) additionally saves that same full resumable
    trainer state every N steps -- without it, a run interrupted mid-epoch has
    no state dir to resume from, since epoch-boundary checkpoints alone can't
    help a run that never reaches one.
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
    # Per-epoch checkpoints so a run cut short by the phase budget resumes instead of
    # restarting from step 0 (see TrainingConfig.save_every_n_epochs). --save_state is
    # unconditional, not gated on save_every_n_steps below: without it, sd-scripts'
    # plain epoch cadence writes only the LoRA weight snapshot at each boundary, never
    # a full resumable state dir, so a run that never passes --save-every-n-steps (i.e.
    # every real, non-smoke-test invocation) would not actually be resumable -- T-0248.
    args.append(f"--save_every_n_epochs={config.save_every_n_epochs}")
    args.append("--save_state")
    if config.cache_latents:
        args.append("--cache_latents")
    if max_train_steps is not None:
        args.append(f"--max_train_steps={max_train_steps}")
    else:
        args.append(f"--max_train_epochs={config.num_epochs}")
    if save_every_n_steps is not None:
        args.append(f"--save_every_n_steps={save_every_n_steps}")
    if resume_state is not None:
        args.append(f"--resume={resume_state}")
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
    parser.add_argument(
        "--save-every-n-steps",
        type=int,
        default=None,
        help=(
            "Save full resumable trainer state every N steps, in addition to "
            "config.save_every_n_epochs' LoRA weight snapshots -- needed when a "
            "single invocation's wall-clock budget is shorter than one epoch, "
            "so there is still a state dir to resume from (rule (b))"
        ),
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="Ignore any existing --save_state checkpoint and start fresh",
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

    resume_state = None
    if not args.no_resume:
        resume_state = find_resume_state(output_dir, config.output_name)
        if resume_state is not None:
            print(f"[resume] continuing from {resume_state}")

    train_args = build_train_args(
        config,
        checkpoint_path=checkpoint_path,
        dataset_config_path=dataset_config_path,
        output_dir=output_dir,
        max_train_steps=args.max_train_steps,
        resume_state=resume_state,
        save_every_n_steps=args.save_every_n_steps,
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
    if result.returncode == 0:
        trained_path = output_dir / f"{config.output_name}.{config.output_format}"
        deploy_to_comfyui(trained_path)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
