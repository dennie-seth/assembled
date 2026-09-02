# Checkpoint/resume evidence — T-0248 acceptance 5

**Author:** Claude (Sonnet 5)

Round-2 review of T-0248 found two real bugs, not just missing test coverage,
behind acceptance 5 ("`save_every_n_epochs=1` is in effect and per-epoch
checkpoints are actually written; a re-run resumes from the last
checkpoint"):

1. `build_train_args` only ever attached `--save_state` when the
   smoke-test-only `--save-every-n-steps` CLI override was passed. The real
   `player_identity_v2` training run never passed that override, so
   `--save_state` was never included and **no resumable state dir was ever
   written** for that run, despite `save_every_n_epochs=1` being set
   correctly in `training_config_player_identity_v2.toml`.
2. Even with `--save_state` fixed to be unconditional, `find_resume_state`'s
   glob only matched the numbered `{output_name}-{epoch:06d}-state` /
   `{output_name}-step{step:08d}-state` shapes. sd-scripts writes a run's
   **final** epoch's state as the unnumbered `{output_name}-state`
   (`checkpoint_io.LAST_STATE_NAME`, via `save_state_on_train_end`) — every
   normally-completed real training run's *last* checkpoint, not an edge
   case — because `train_network.py` deliberately excludes the final epoch
   from the numbered per-epoch save
   (`saving = ... and (epoch + 1) < num_train_epochs`). The old glob never
   matched this shape, so a real run's own checkpoint was silently never
   found on the next invocation.

Both are fixed (`fix(assets): --save_state must not depend on the
step-cadence override`, `fix(assets): find_resume_state must also match
sd-scripts' bare last-state dir`) with unit tests. This file is the
end-to-end, non-mocked evidence that the fix actually works, run against the
real training stack — not a demonstration that the code *could* work.

## Why a separate scratch config, not a re-run of the real v2 training

Re-running `training_config_player_identity_v2.toml` itself would overwrite
the already-committed, already-verified `assets/final/lora/player_identity_v2.safetensors`
deliverable. `training_config_checkpoint_demo_T0248.toml` (gitignored,
`assets/src/lora/.train-scratch/`, never committed) uses the identical
`[model]`/`[network]` block and the same shared `lora_train.train` /
`lora_train.config` code path, output **name** changed to
`player_identity_v2_checkpoint_demo` so it cannot collide with the real
file, and a tiny 2-image dataset (`assets/src/lora/.train-scratch/checkpoint_demo_refs/`,
`ref_001`/`ref_002` from the real `identity_refs_v2/` curated set, copied via
git plumbing) so one epoch is 2 steps instead of 29 — the checkpoint/resume
mechanism itself is dataset-size-independent, so this proves the same code
path cheaply. Demo output (`player_identity_v2_checkpoint_demo*` in
`assets/final/lora/`) was deleted after this evidence was captured; it was
never committed.

## Run 1 — train exactly one epoch, produce a checkpoint

```
~/dev/lora-train-venv/bin/python3 -c "
import sys
sys.path.insert(0, '.../assets/src/lora/src')
from lora_train.train import main
sys.exit(main([
    '--repo-root', '.../worktrees/T-0248',
    '--config', '.../assets/src/lora/.train-scratch/training_config_checkpoint_demo_T0248.toml',
    '--max-train-steps', '2',
]))
"
```

Ran 2026-08-29 22:33:53 -> 22:38:19 UTC (4m26s wall-clock, foreground/blocking
per rule (a), streamed via TaskOutput block=true — the Bash tool's own
per-call cap is under sd-scripts' checkpoint-load time, same reason the real
v2 training run needed a background task + blocking poll). Key log lines:

```
epoch 1/1
steps: 100%|██████████| 2/2 [03:16<00:00, 98.47s/it, avr_loss=0.0377]
INFO     saving last state.             checkpoint_io.py:279
INFO     Saving current state to /.../assets/final/lora/player_identity_v2_checkpoint_demo-state
INFO     save train state to /.../player_identity_v2_checkpoint_demo-state/train_state.json at epoch 1 step 2
INFO     Model weights saved in /.../player_identity_v2_checkpoint_demo-state/model.safetensors
INFO     Optimizer state saved in /.../player_identity_v2_checkpoint_demo-state/optimizer.bin
INFO     model saved.
saving checkpoint: /.../assets/final/lora/player_identity_v2_checkpoint_demo.safetensors
TRAIN_RC 0
```

Confirmed on disk immediately after: `assets/final/lora/player_identity_v2_checkpoint_demo-state/`
(full resumable trainer state — model, optimizer, scheduler, sampler, RNG)
and `find_resume_state(output_dir, "player_identity_v2_checkpoint_demo")`
returns that dir (it returned `None` before the second fix above — the bug
was caught by this exact check, against the real dir, not a synthetic one).

## Run 2 — re-invoke, confirm it resumes instead of restarting at step 0

Identical command, `--max-train-steps 4` (the demo config's full 2 epochs x
2 steps), no `--resume`/`--no-resume` flag — `find_resume_state`
auto-detection is what's under test. Ran 22:41:20 -> 22:46:12 UTC (4m52s).
Key log lines:

```
[resume] continuing from /.../assets/final/lora/player_identity_v2_checkpoint_demo-state
INFO     resume training from local state: /.../player_identity_v2_checkpoint_demo-state
INFO     load train state from /.../player_identity_v2_checkpoint_demo-state/train_state.json:
         {'current_epoch': 1, 'current_step': 2}
INFO     All model weights loaded successfully
INFO     All optimizer states loaded successfully
INFO     All random states loaded successfully
epoch 2/2
steps:  50%|█████     | 2/4 [03:42<03:42, 111.19s/it, avr_loss=0.0639]
INFO     save train state to /.../player_identity_v2_checkpoint_demo-state/train_state.json at epoch 2 step 2
TRAIN_RC 0
```

This is the proof rule (b) asks for: the second invocation's own log shows
the *train.py* wrapper's `[resume] continuing from ...` line (train.py:292)
firing on real auto-detection, sd-scripts' own resume log confirming it
loaded `current_epoch: 1, current_step: 2` (not step 0), and the progress
bar immediately entering `epoch 2/2` and running only steps 3-4 (the "2/4"
label is steps *remaining this invocation*, continuing the global counter
from where run 1 left off, not restarting the 4-step count from zero) before
completing and writing the final epoch's own last-state checkpoint. Exit
code 0 both times.
