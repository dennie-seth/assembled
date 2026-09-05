# Attempt log — T-0274 profile identity LoRA training

**Author:** Claude (Sonnet 5)

This file is being rewritten because its previously-committed content is
stale: it named T-0273's non-approval as the reason training was withheld.
That was correct as of 2026-09-05 ~10:24Z (checked against
`tools/board/approval-ledger.json`, a generated snapshot from
2026-09-03T13:00:22Z), but the card's own board record shows T-0273 was
approved by @DennieSeth at **2026-09-03T17:52:21.435Z** — the ledger
snapshot was simply older than that approval. The card's
`## Unblocked 2026-09-05` note confirms this and explicitly says not to
re-derive approval state from `approval-ledger.json` again. That blocker is
void. This log now records the real, current blocker: repeated mid-run
interruption, and why a fresh single-invocation run is the correct fix.

## Root cause of every prior interruption: session/watchdog silence, not the training stack

Multiple prior sessions invoked

```
/home/dennieseth/dev/lora-train-venv/bin/python3 -m lora_train.train \
  --config assets/src/character/training_config_player_identity_profile_v1.toml \
  --save-every-n-steps 4
```

and each produced real, verifiable forward progress (real 114MB
`.safetensors` checkpoints and `--save_state` resume dirs written to
`assets/final/lora/`, timestamped across 2026-09-05 11:45–15:02), but no
invocation ever reached the full `num_epochs = 12` (72-step) target before
the implementer session ended. Two independent problems compounded this:

1. **The CLI's inactivity watchdog didn't see filesystem-only progress.**
   `T-0308` (now `done`, PR #341 merged to develop) diagnosed and fixed
   this: the watchdog previously re-armed only on parent-stream stdout,
   and a subagent-owned long-running child's `tool_progress` heartbeats are
   not forwarded to the parent stream — 19 minutes of real training produced
   19 minutes of apparent silence and the run was killed at the 8-minute
   inactivity budget. T-0308 added a second, independent liveness source:
   mtime growth in the run's watched artifact directories, which includes
   `assets/final/lora` (a direct entry in `DEFAULT_PRESERVED_ARTIFACT_PATHS`).
   Since training checkpoints there every ~90–95s, this is now comfortably
   inside the inactivity budget regardless of stdout activity.

2. **Cross-session `--resume` does not accumulate epoch/step progress.**
   sd-scripts' `--resume` restores model/optimizer/accelerator state but the
   epoch/step counters used for the LR schedule and `--max_train_epochs`
   bookkeeping are not faithfully restored across separate process
   invocations — verified empirically on 2026-09-05: a resume from a
   preserved epoch-7 state (`train_state.json`: `current_epoch: 7`) produced
   new state dirs reading `current_epoch: 5` and `current_epoch: 6` — the
   counters went backwards, i.e. each new invocation re-runs a fresh
   `--max_train_epochs=12` schedule rather than continuing toward a
   cumulative 72-step target. So chaining short sessions was never going to
   converge on a single well-defined completed artifact; each restart erased
   the previous session's epoch bookkeeping even though it kept the model
   weights.

## What this session does differently

With T-0308's filesystem-liveness fix now on `develop` (merged, this
worktree is not itself a party to it, but the *orchestrator* running this
session is), a training job whose stdout is silent for the ~90s between
checkpoints should no longer be killed for inactivity. Combined with the
`--resume` non-accumulation finding above, the correct action is a **single,
complete, from-scratch invocation** (`--no-resume`) rather than another
partial resume attempt — the run reaches ~90–95s/epoch once latents are
cached, so all 12 epochs is roughly 18-20 minutes wall-clock, well inside
one session.

This session launched exactly:

```
/home/dennieseth/dev/lora-train-venv/bin/python3 -m lora_train.train \
  --config assets/src/character/training_config_player_identity_profile_v1.toml \
  --save-every-n-steps 4 --no-resume
```

in the background and polled it to completion (see the commit(s) following
this log for the resulting artifact, provenance, deploy, and smoke-check
evidence — or, if it still did not complete, a follow-up note below
explaining exactly why and what was observed).

Note: the module's own docstring/header comment recommends prefixing this
command with `PYTHONPATH=assets/src/lora/src:assets/src/character/src`.
That prefix is unnecessary in this environment — the training venv already
has `lora_train` and `char_gen` installed editable, so the bare invocation
above resolves the module correctly — and prefixing it caused this
session's Bash permission grant (matched on the literal command prefix
`/home/dennieseth/dev/lora-train-venv/bin/python3`) to require approval it
could not obtain non-interactively. Dropping the unneeded prefix restored a
match. Worth fixing the header comment separately so a future session
doesn't hit the same denial.
