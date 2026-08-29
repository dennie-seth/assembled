"""Tests for the sd-scripts training glue (lora_train.train).

Covers the pure config-building functions only (dataset TOML rendering,
CLI arg construction) — actually invoking `accelerate launch
sdxl_train_network.py` requires a GPU and the WSL-native training stack
from setup-training-env.sh, so that path is exercised by a manual smoke
run, not this suite (same pattern as lora_train.fetch's network calls).
"""

from __future__ import annotations

import pathlib

from lora_train.config import TrainingConfig
from lora_train.train import (
    build_dataset_toml,
    build_train_args,
    deploy_to_comfyui,
    find_resume_state,
    resolve_checkpoint_path,
    resolve_comfyui_loras_dir,
    resolve_sd_scripts_dir,
)


def _make_config(**overrides) -> TrainingConfig:
    defaults = dict(
        base_checkpoint="sd_xl_base_1.0.safetensors",
        checkpoint_license="CreativeML Open RAIL++-M",
        output_name="soviet_brutalism_style_v1",
        output_dir="assets/final/lora",
        output_format="safetensors",
        resolution=1024,
        batch_size=1,
        mixed_precision="fp16",
        num_epochs=10,
        learning_rate=1.0e-4,
        optimizer="AdamW8bit",
        network_rank=16,
        network_alpha=8,
        network_type="lora",
        dataset_dir="assets/src/lora/refs",
        shuffle=True,
        cache_latents=True,
    )
    defaults.update(overrides)
    return TrainingConfig(**defaults)


def test_dataset_toml_points_at_refs_dir():
    config = _make_config()
    refs_dir = pathlib.Path("/repo/assets/src/lora/refs")
    toml_text = build_dataset_toml(config, refs_dir)
    assert str(refs_dir) in toml_text
    assert 'caption_extension = ".txt"' in toml_text
    assert "resolution = 1024" in toml_text
    assert "batch_size = 1" in toml_text


def test_dataset_toml_shuffle_reflects_config():
    assert "shuffle_caption = true" in build_dataset_toml(
        _make_config(shuffle=True), pathlib.Path("/repo/refs")
    )
    assert "shuffle_caption = false" in build_dataset_toml(
        _make_config(shuffle=False), pathlib.Path("/repo/refs")
    )


def test_train_args_include_8gb_vram_flags():
    config = _make_config()
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
    )
    assert "--gradient_checkpointing" in args
    assert "--sdpa" in args
    assert "--cache_latents" in args
    assert "--optimizer_type=AdamW8bit" in args
    # deliberately NOT used: incompatible with shuffle_caption (see train.py)
    assert "--cache_text_encoder_outputs" not in args


def test_train_args_max_train_steps_overrides_epochs():
    config = _make_config(num_epochs=10)
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
        max_train_steps=10,
    )
    assert "--max_train_steps=10" in args
    assert not any(a.startswith("--max_train_epochs") for a in args)


def test_train_args_default_uses_num_epochs():
    config = _make_config(num_epochs=10)
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
    )
    assert "--max_train_epochs=10" in args
    assert not any(a.startswith("--max_train_steps") for a in args)


def test_train_args_network_settings_from_config():
    config = _make_config(network_rank=16, network_alpha=8)
    args = build_train_args(
        config,
        checkpoint_path=pathlib.Path("/ckpt.safetensors"),
        dataset_config_path=pathlib.Path("/dataset.toml"),
        output_dir=pathlib.Path("/out"),
    )
    assert "--network_dim=16" in args
    assert "--network_alpha=8" in args
    assert "--network_module=networks.lora" in args


def test_resolve_checkpoint_path_uses_default_root(monkeypatch):
    monkeypatch.delenv("LORA_CHECKPOINT_PATH", raising=False)
    config = _make_config()
    path = resolve_checkpoint_path(config)
    assert path.name == "sd_xl_base_1.0.safetensors"
    assert "ComfyUI" in str(path)


def test_resolve_checkpoint_path_honours_env_override(monkeypatch):
    monkeypatch.setenv("LORA_CHECKPOINT_PATH", "/custom/checkpoint.safetensors")
    config = _make_config()
    assert resolve_checkpoint_path(config) == pathlib.Path("/custom/checkpoint.safetensors")


def test_resolve_sd_scripts_dir_honours_env_override(monkeypatch):
    monkeypatch.setenv("LORA_SD_SCRIPTS_DIR", "/custom/sd-scripts")
    assert resolve_sd_scripts_dir() == pathlib.Path("/custom/sd-scripts")


def test_resolve_comfyui_loras_dir_uses_default(monkeypatch):
    monkeypatch.delenv("LORA_COMFYUI_LORAS_DIR", raising=False)
    path = resolve_comfyui_loras_dir()
    assert str(path) in ("/mnt/f/ComfyUI/models/loras", "\\mnt\\f\\ComfyUI\\models\\loras")


def test_resolve_comfyui_loras_dir_honours_env_override(monkeypatch):
    monkeypatch.setenv("LORA_COMFYUI_LORAS_DIR", "/custom/loras")
    assert resolve_comfyui_loras_dir() == pathlib.Path("/custom/loras")


def _always_valid(_path: pathlib.Path) -> tuple[bool, str]:
    return True, "valid safetensors (2958 tensors)"


def _always_invalid(_path: pathlib.Path) -> tuple[bool, str]:
    return False, "safetensors file has zero tensors"


def test_deploy_to_comfyui_copies_valid_file(tmp_path):
    source_dir = tmp_path / "final"
    source_dir.mkdir()
    source = source_dir / "soviet_brutalism_style_v1.safetensors"
    source.write_bytes(b"fake-but-nonempty-weights")
    target_dir = tmp_path / "loras"

    dest = deploy_to_comfyui(source, target_dir, validate=_always_valid)

    assert dest == target_dir / "soviet_brutalism_style_v1.safetensors"
    assert dest.read_bytes() == source.read_bytes()


def test_deploy_to_comfyui_creates_missing_target_dir(tmp_path):
    source = tmp_path / "soviet_brutalism_style_v1.safetensors"
    source.write_bytes(b"fake-weights")
    target_dir = tmp_path / "does" / "not" / "exist" / "yet"
    assert not target_dir.exists()

    dest = deploy_to_comfyui(source, target_dir, validate=_always_valid)

    assert target_dir.is_dir()
    assert dest is not None
    assert dest.exists()


def test_deploy_to_comfyui_skips_copy_when_invalid(tmp_path):
    source = tmp_path / "soviet_brutalism_style_v1.safetensors"
    source.write_bytes(b"not-really-safetensors")
    target_dir = tmp_path / "loras"

    dest = deploy_to_comfyui(source, target_dir, validate=_always_invalid)

    assert dest is None
    assert not target_dir.exists()


def test_deploy_to_comfyui_default_validate_rejects_missing_file(tmp_path):
    missing = tmp_path / "does-not-exist.safetensors"
    target_dir = tmp_path / "loras"

    dest = deploy_to_comfyui(missing, target_dir)

    assert dest is None
    assert not target_dir.exists()


def test_deploy_to_comfyui_default_validate_rejects_empty_file(tmp_path):
    empty = tmp_path / "empty.safetensors"
    empty.write_bytes(b"")
    target_dir = tmp_path / "loras"

    dest = deploy_to_comfyui(empty, target_dir)

    assert dest is None
    assert not target_dir.exists()


def test_deploy_to_comfyui_reports_copy_failure_without_raising(tmp_path, monkeypatch):
    import lora_train.train as train_mod

    source = tmp_path / "soviet_brutalism_style_v1.safetensors"
    source.write_bytes(b"fake-weights")
    target_dir = tmp_path / "loras"

    def _boom(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(train_mod.shutil, "copy2", _boom)

    dest = deploy_to_comfyui(source, target_dir, validate=_always_valid)

    assert dest is None


class TestSaveEveryNEpochsArg:
    """The checkpoint cadence has to reach sd-scripts, not just sit in the config."""

    def test_passes_the_configured_cadence_through_to_sd_scripts(self):
        config = _make_config(save_every_n_epochs=1)
        args = build_train_args(
            config,
            checkpoint_path=pathlib.Path("/ckpt.safetensors"),
            dataset_config_path=pathlib.Path("/dataset.toml"),
            output_dir=pathlib.Path("/out"),
        )
        assert "--save_every_n_epochs=1" in args

    def test_a_larger_cadence_is_passed_verbatim(self):
        config = _make_config(save_every_n_epochs=3)
        args = build_train_args(
            config,
            checkpoint_path=pathlib.Path("/ckpt.safetensors"),
            dataset_config_path=pathlib.Path("/dataset.toml"),
            output_dir=pathlib.Path("/out"),
        )
        assert "--save_every_n_epochs=3" in args


class TestFindResumeState:
    """A run cut short by this environment's per-call wall-clock budget (the
    tool that invokes train.py has its own timeout well under a full training
    run's wall-clock, see T-0248 HANDOFF §24-a) must resume from the last
    sd-scripts `--save_state` checkpoint on the next invocation instead of
    restarting at step 0 -- this is what makes rule (b) ("a re-run resumes
    from the last checkpoint") actually true rather than aspirational.

    sd-scripts' `--save_state` writes a state dir in one of three shapes
    (`library/checkpoint_io.py`): a numbered `{output_name}-{epoch:06d}-state`
    per *intermediate* epoch boundary (EPOCH_STATE_NAME), a numbered
    `{output_name}-step{step:08d}-state` per step-cadence boundary
    (STEP_STATE_NAME, `--save_every_n_steps`), or a single unnumbered
    `{output_name}-state` (LAST_STATE_NAME) written whenever a run reaches its
    actual end (`save_state_on_train_end`) -- which, confirmed empirically
    against a real training run (T-0248), is what every run's FINAL epoch
    gets: `train_network.py` deliberately excludes the last epoch from the
    numbered per-epoch save (`saving = ... and (epoch + 1) < num_train_epochs`),
    so a run that completes normally -- every real training invocation, not
    just a smoke test -- writes the bare, unnumbered form, never a numbered
    one. All three shapes end in `-state` and are resumed the same way
    (`--resume <dir>`), so the most-recently-written one (by mtime) is always
    the correct resume point regardless of which produced it.
    """

    def test_returns_none_when_no_state_dir_exists(self, tmp_path):
        assert find_resume_state(tmp_path, "player_identity_v2") is None

    def test_ignores_unrelated_files_and_dirs(self, tmp_path):
        (tmp_path / "player_identity_v2.safetensors").write_bytes(b"not a state dir")
        (tmp_path / "some_other_model-000001-state").mkdir()
        assert find_resume_state(tmp_path, "player_identity_v2") is None

    def test_finds_a_single_epoch_state_dir(self, tmp_path):
        state_dir = tmp_path / "player_identity_v2-000001-state"
        state_dir.mkdir()
        assert find_resume_state(tmp_path, "player_identity_v2") == state_dir

    def test_finds_a_single_step_state_dir(self, tmp_path):
        state_dir = tmp_path / "player_identity_v2-step00000004-state"
        state_dir.mkdir()
        assert find_resume_state(tmp_path, "player_identity_v2") == state_dir

    def test_finds_the_bare_last_state_dir(self, tmp_path):
        """T-0248: the unnumbered `{output_name}-state` dir sd-scripts writes
        via `save_state_on_train_end` for a run's final epoch -- the shape
        every normally-completed real training run actually produces, not
        just an edge case. A find_resume_state that only matched the numbered
        shapes above would never find this and silently never resume a real
        run (found by actually running training end-to-end, not by mocking)."""
        state_dir = tmp_path / "player_identity_v2-state"
        state_dir.mkdir()
        assert find_resume_state(tmp_path, "player_identity_v2") == state_dir

    def test_bare_last_state_dir_does_not_match_a_prefix_colliding_output_name(self, tmp_path):
        """`player_identity_v2_checkpoint_demo-state` must not be mistaken for
        `player_identity_v2`'s own state dir just because it shares a prefix."""
        (tmp_path / "player_identity_v2_checkpoint_demo-state").mkdir()
        assert find_resume_state(tmp_path, "player_identity_v2") is None

    def test_picks_the_most_recently_written_state_dir(self, tmp_path):
        import time

        older = tmp_path / "player_identity_v2-000001-state"
        older.mkdir()
        time.sleep(0.01)
        newer = tmp_path / "player_identity_v2-step00000016-state"
        newer.mkdir()

        assert find_resume_state(tmp_path, "player_identity_v2") == newer

    def test_bare_last_state_dir_wins_when_written_most_recently(self, tmp_path):
        import time

        older = tmp_path / "player_identity_v2-000001-state"
        older.mkdir()
        time.sleep(0.01)
        newer = tmp_path / "player_identity_v2-state"
        newer.mkdir()

        assert find_resume_state(tmp_path, "player_identity_v2") == newer

    def test_does_not_match_a_different_output_name(self, tmp_path):
        (tmp_path / "player_identity_v1-000006-state").mkdir()
        assert find_resume_state(tmp_path, "player_identity_v2") is None


class TestResumeAndStepwiseStateWiring:
    """The functions above only matter if their results actually reach the
    sd-scripts CLI invocation."""

    def test_resume_state_adds_resume_flag(self):
        config = _make_config()
        args = build_train_args(
            config,
            checkpoint_path=pathlib.Path("/ckpt.safetensors"),
            dataset_config_path=pathlib.Path("/dataset.toml"),
            output_dir=pathlib.Path("/out"),
            resume_state=pathlib.Path("/out/player_identity_v2-step00000004-state"),
        )
        assert "--resume=/out/player_identity_v2-step00000004-state" in args

    def test_no_resume_state_omits_resume_flag(self):
        config = _make_config()
        args = build_train_args(
            config,
            checkpoint_path=pathlib.Path("/ckpt.safetensors"),
            dataset_config_path=pathlib.Path("/dataset.toml"),
            output_dir=pathlib.Path("/out"),
        )
        assert not any(a.startswith("--resume") for a in args)

    def test_save_every_n_steps_adds_stepwise_state_flags(self):
        config = _make_config()
        args = build_train_args(
            config,
            checkpoint_path=pathlib.Path("/ckpt.safetensors"),
            dataset_config_path=pathlib.Path("/dataset.toml"),
            output_dir=pathlib.Path("/out"),
            save_every_n_steps=4,
        )
        assert "--save_every_n_steps=4" in args
        assert "--save_state" in args

    def test_no_save_every_n_steps_omits_only_the_step_cadence_flag(self):
        """T-0248: `--save_state` must NOT depend on the step-cadence override.

        Without it, sd-scripts' plain `--save_every_n_epochs` cadence writes only
        the LoRA weight snapshot at each epoch boundary, never a full resumable
        `-state` dir -- so a run that relies solely on `config.save_every_n_epochs`
        (i.e. every real training invocation that doesn't pass
        `--save-every-n-steps`, which is a smoke-test-only CLI override) is not
        actually resumable, contradicting rule (b) ("a re-run resumes from the
        last checkpoint"). `--save_state` must ride along with the baseline epoch
        cadence unconditionally; only `--save_every_n_steps` itself is optional.
        """
        config = _make_config()
        args = build_train_args(
            config,
            checkpoint_path=pathlib.Path("/ckpt.safetensors"),
            dataset_config_path=pathlib.Path("/dataset.toml"),
            output_dir=pathlib.Path("/out"),
        )
        assert not any(a.startswith("--save_every_n_steps") for a in args)
        assert "--save_state" in args

    def test_save_state_present_even_with_default_epoch_cadence_only(self):
        """T-0248: epoch-cadence checkpoints (`config.save_every_n_epochs`) must be
        resumable on their own, not only when a step-cadence override is also
        passed -- see test_no_save_every_n_steps_omits_only_the_step_cadence_flag.
        """
        config = _make_config(save_every_n_epochs=1)
        args = build_train_args(
            config,
            checkpoint_path=pathlib.Path("/ckpt.safetensors"),
            dataset_config_path=pathlib.Path("/dataset.toml"),
            output_dir=pathlib.Path("/out"),
        )
        assert "--save_every_n_epochs=1" in args
        assert "--save_state" in args
