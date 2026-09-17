# What kohya `--resume` actually restores (T-0311)

**Author:** Claude (Sonnet 5)

**Verdict, one sentence:** `--resume` restores full training state — LoRA
weights, optimizer moments, the LR-scheduler's own internal position, the
gradient scaler, and RNG state — via `accelerate.Accelerator.load_state`;
it is not weights-only, but sd-scripts layers a *separate*,
independently-recomputed epoch/step display counter on top that does not
reliably track true cumulative position, and that second thing is what
T-0274 actually got bitten by.

This was answered entirely by reading code (`sd-scripts`, `accelerate`) and
one already-committed empirical attempt log from this repo. **No training
run was performed for this card.**

## Versions this was read against

- `sd-scripts` checkout: `/home/dennieseth/dev/sd-scripts`, commit
  `37a1cbbc5725ed2a3575506e7bd2001c9908ac92` (2026-07-23).
- `accelerate`: `1.6.0`, installed at
  `/home/dennieseth/dev/lora-train-venv/lib/python3.12/site-packages/accelerate`
  (`accelerate-1.6.0.dist-info/METADATA`).

Re-check both if either is upgraded — `accelerate`'s checkpoint file set in
particular (`checkpointing.py`) has changed shape across major versions
before.

## 1. What a `-state` dir contains

No `-state` directory survived to inspect directly: T-0274's
`player_identity_profile_v1-*-state` dirs were git-ignored
(`.gitignore:97`, `assets/final/lora/*-state/`) and lived only in
`worktrees/T-0274`, which was reaped
when that card's PR (#345) merged. `find /home/dennieseth/dev -name
'*-state' -type d` turns up nothing relevant. So this section is derived
from the **writer** — `accelerate.checkpointing.save_accelerator_state`
(`/home/dennieseth/dev/lora-train-venv/lib/python3.12/site-packages/accelerate/checkpointing.py:56-171`)
— not cross-checked against a real directory listing. Files it writes, in
order:

| File | Line | Content |
|---|---|---|
| `model.safetensors` (or `pytorch_model.bin`) | `checkpointing.py:102-108` | State dict of every model registered with the `Accelerator`. In kohya's case this list is pruned to LoRA-network weights only *before* this runs — see the `save_model_hook` below. |
| `optimizer.bin` | `checkpointing.py:110-115` | `optimizer.state_dict()` for each registered optimizer — for Adam-family optimizers this is the full per-parameter moment buffers (`exp_avg`, `exp_avg_sq`), not just the current LR. |
| `scheduler.bin` | `checkpointing.py:117-122` | `scheduler.state_dict()` for each registered LR scheduler — includes its internal position counter (`last_epoch`/`_step_count` for a standard `torch.optim.lr_scheduler` object), which is what actually drives "what LR should apply right now." |
| `sampler.bin` / `dl_state_dict.bin` | `checkpointing.py:124-139` | Dataloader/sampler position — **conditionally**, only written for accelerate's own `IterableDatasetShard` sampler or a dataloader with `use_stateful_dataloader=True` (see §4, this gate matters). |
| `scaler.pt` | `checkpointing.py:141-146` | Mixed-precision `GradScaler` state, if one is in use. |
| `random_states_<process_index>.pkl` | `checkpointing.py:147-170` | Python `random`, `numpy`, `torch` (CPU), and `torch.cuda` RNG states, plus accelerate's own internal `step` counter (stashed as `states["step"]`, line 150). |

On top of that, sd-scripts registers its **own** pre-save hook
(`save_model_hook`, `train_network.py:1337-1355`) which additionally writes:

| File | Line | Content |
|---|---|---|
| `train_state.json` | `train_network.py:1351-1355` | `{"current_epoch": <int>, "current_step": <int>}` — sd-scripts' own epoch/step bookkeeping, written from the training loop's own `current_epoch`/`current_step` variables. This is *not* an accelerate-managed file; it is the mechanism §4/§6 below turn on. |

## 2. What `--resume` loads back

Trail, verified by reading each hop:

1. `assets/src/lora/src/lora_train/train.py:242-243` — when `find_resume_state()`
   (`train.py:120-148`) finds a `-state` dir, `build_train_args` appends
   `--resume=<dir>` to the `sdxl_train_network.py` argv.
2. `train_network.py:1382` — `args_util.resume_from_local_or_hf_if_specified(accelerator, args)`
   runs after `accelerator.prepare(...)` (see §3) and after the two hooks
   above are registered (`train_network.py:1378-1379`).
3. `library/args.py:1200-1207` (`resume_from_local_or_hf_if_specified`) —
   for a local dir (no `--resume_from_huggingface`), this is just:
   ```python
   accelerator.load_state(args.resume)
   ```
4. `accelerate/accelerator.py:3342` (`Accelerator.load_state`) — for each
   registered model/optimizer/scheduler/dataloader, calls
   `checkpointing.load_accelerator_state`
   (`accelerator.py:3452-3462` → `checkpointing.py:174-299`), which:
   - loads `model.safetensors` into the (LoRA-only) model list
     (`checkpointing.py:222-232`)
   - loads `optimizer.bin` into each optimizer via `load_state_dict`
     (`checkpointing.py:235-240`)
   - loads `scheduler.bin` into each LR scheduler via `load_state_dict`
     (`checkpointing.py:243-248`)
   - loads the sampler/dataloader state **if the gate in §4 applies**
     (`checkpointing.py:250-266`)
   - loads `scaler.pt` if a scaler is registered (`checkpointing.py:269-273`)
   - loads `random_states_<i>.pkl` and restores `random`/`numpy`/`torch`/
     `torch.cuda` RNG state, returning `{"step": <int>}` as an override
     (`checkpointing.py:275-297`)
   - back in `accelerator.py:3463-3464`, that returned `step` overwrites
     `accelerator.step` — accelerate's own internal step counter (distinct
     from sd-scripts' `current_step`).
5. Before any of the above, `accelerator.py:3433-3436` fires sd-scripts'
   `load_model_hook` (`train_network.py:1359-1376`), which reads
   `train_state.json` from the resumed dir and stashes its `current_step`
   into the closure variable `steps_from_state`.
6. Back in `train_network.py:1442-1469`, if neither `--initial_epoch` nor
   `--initial_step` was passed (kohya's own defaults, and
   `assets/src/lora/src/lora_train/train.py`'s `build_train_args` never
   sets either), `steps_from_state` becomes `initial_step`, and
   `epoch_to_start = initial_step // num_update_steps_per_epoch`
   (`train_network.py:1467-1469`) — the loop bound the training `for epoch
   in range(epoch_to_start, num_train_epochs)` (`train_network.py:1573`)
   then starts from.

`lr_scheduler` is confirmed to be one of the objects passed into
`accelerator.prepare(...)` at `train_network.py:1303-1304` (and the
DeepSpeed variant at `:1280-1281`), which is why `scheduler.bin` exists at
all for this trainer and why its `load_state_dict` call in step 4 actually
has something registered to load into.

## 3. The verdict, expanded

**Full training-state resume, not weights-only.** `accelerate.load_state`
restores, per §2: LoRA weights, full optimizer moment buffers, the LR
scheduler's own internal step/position counter, gradient-scaler state, and
RNG state (Python/NumPy/Torch/CUDA), plus accelerate's own `step` counter.
None of that is re-derived or guessed at resume time — every one of those
objects' `load_state_dict()` is called with exactly what `save_state` wrote.

The corroborating help text the card points at
(`train_network.py:1996-1997`, `--initial_epoch`'s help string: *"note:
initial_epoch/step doesn't affect to lr scheduler ... lr scheduler will
start from 0 without `--resume`"*) is consistent with this: it says the LR
schedule only resets when you resume via `--initial_epoch`/`--initial_step`
**instead of** `--resume` — i.e. `--resume` (unlike those flags) is exactly
what keeps the scheduler's position, because it goes through
`accelerator.load_state` and thus `scheduler.bin`. The `:1457-1459` warning
inside the `skip_until_initial_step` branch says the same thing from the
other direction: *"initial_step is specified but not resuming. lr scheduler
will be started from the beginning"* — the warning only fires when
`args.resume` is falsy.

## 4. What is NOT restored

**Dataloader/sampler position**, confirmed from the code, not inferred:
`checkpointing.py:130` and `:256` both gate saving/loading the sampler
state on `isinstance(dataloader.dataset, IterableDatasetShard)` — an
accelerate-internal sharding wrapper kohya's dataset classes
(`library/dataset.py:362`'s `BaseDataset(torch.utils.data.Dataset)`, the
common base for `DreamBoothDataset`/`FineTuningDataset` — a plain map-style
`Dataset`, not an `IterableDataset`) never use, and the `dl_state_dict.bin` path
(`checkpointing.py:134-138`, `:260-265`) requires
`dataloader.use_stateful_dataloader`, which sd-scripts never sets. So for
every real invocation of this pipeline, `sampler.bin`/`dl_state_dict.bin`
are neither written nor read — a resumed run starts its dataloader's own
internal iteration order from scratch, not from wherever it left off
mid-epoch.

sd-scripts is aware of this gap and papers over it, imperfectly: the
`--skip_until_initial_step` branch (`train_network.py:1454-1465`) exists
specifically to "load data and discard it to ensure the same data is used"
— i.e. re-iterate and throw away `initial_step` batches to reach
approximately the same dataloader position. It is **off by default**, and
`assets/src/lora/src/lora_train/train.py`'s `build_train_args` never passes
it, so this repo's training runs get neither the real dataloader-state
restore nor the discard-based workaround — a resumed epoch reshuffles (if
`shuffle_caption`/dataset shuffling is on) and restarts from batch 0 of
whatever the dataloader considers "the first batch," not from the exact
mid-epoch point a full stop would have left off at. In practice this is a
minor gap (repeats or skips at most one epoch's worth of image order, not
gradient/LR state), but it is real and code-confirmed.

## 5. The epoch-renumbering finding (§6 of the card)

The exact `-000007-state` → `-000009-state`, `current_epoch: 7` →
`current_epoch: 9` numbers in this card's body do not match any number
this repo's own history could locate — searching every commit touching
`assets/src/character/ARM_PROFILE_LORA_ATTEMPT_LOG_T0274.md` and the
`player_identity_profile_v1-*` checkpoint filenames the card describes
turned up a real, committed, but *different* empirical record of the same
phenomenon (`assets/src/character/ARM_PROFILE_LORA_ATTEMPT_LOG_T0274.md:46-53`,
merged to `main` in PR #345):

> sd-scripts' `--resume` restores model/optimizer/accelerator state but the
> epoch/step counters used for the LR schedule and `--max_train_epochs`
> bookkeeping are not faithfully restored across separate process
> invocations — verified empirically on 2026-09-05: a resume from a
> preserved epoch-7 state (`train_state.json`: `current_epoch: 7`) produced
> new state dirs reading `current_epoch: 5` and `current_epoch: 6` — the
> counters went backwards.

Taking that (real, committed) 7 → 5 → 6 sequence as the case to explain:
this is **per-invocation renumbering of a display counter, not lost
optimizer/scheduler position** — but the two are easy to conflate, and the
attempt log's own wording ("epoch/step counters used for the LR schedule
... are not faithfully restored") does conflate them. Separating them from
the code:

- `current_epoch`/`current_step` (`train_state.json`) and the numbered
  `EPOCH_STATE_NAME` directory suffix (`library/checkpoint_io.py:43`,
  `:227-234`) are **the same integer**: both come from the training loop's
  `epoch + 1` (`train_network.py:1575` sets `current_epoch.value = epoch +
  1`; `train_network.py:1830` calls
  `checkpoint_io.save_and_remove_state_on_epoch_end(args, accelerator, epoch
  + 1)` with the identical value). So a directory named `-000005-state`
  and a `train_state.json` inside it reading `current_epoch: 5` are not two
  independent measurements — they're the same loop variable read twice.
- That loop variable is **not** restored by `accelerate.load_state`. It is
  recomputed fresh on every invocation as `epoch_to_start = initial_step //
  num_update_steps_per_epoch` (`train_network.py:1467-1469`), where
  `initial_step` comes from the *previous* run's `train_state.json`
  (`current_step`, a raw, monotonic step count — see §2 step 5-6) but
  `num_update_steps_per_epoch` is recomputed from `len(train_dataloader)`
  at the top of **this** invocation (`train_network.py:1385`), independent
  of whatever it was in the run being resumed.
- Given that, a 7 → 5/6 (backward, not reset-to-0/1) result is exactly what
  you'd get if the same *raw step count* survived correctly (§3 already
  established the scheduler/optimizer state itself carries forward via
  `scheduler.bin`/`optimizer.bin`) but got divided by a **larger**
  `num_update_steps_per_epoch` on the resuming invocation than the
  originating one used — e.g. the reference/dataset directory size changed
  between the two invocations (plausible here: T-0274's log records
  training against an actively-curated profile reference set across
  several same-day sessions), which changes `len(train_dataloader)` and
  therefore the epoch-length divisor, without changing the step count
  itself.

**What the code cannot settle:** whether that specific mechanism (a
changed `num_update_steps_per_epoch`) is actually what happened for
T-0274's 7→5/6 case, versus some other cause (e.g. `steps_from_state` not
being the exact step count assumed here, or an interaction with
`--save-every-n-steps` vs. `--save_every_n_epochs` producing a state dir
via a different code path than the one this doc traced). Confirming it
would require re-running with instrumentation (logging
`num_update_steps_per_epoch` and `steps_from_state` on both the
originating and resuming invocation) — which this card's "Do not" section
explicitly rules out. Per that instruction, this is recorded as an
open question rather than a guess.

**Practical consequence, regardless of the exact mechanism:** the numbered
epoch (both the `-NNNNNN-state` directory suffix and the `current_epoch`
field inside it) is a **display/bookkeeping value recomputed per
invocation**, not a reliable cumulative counter across resumed sessions.
Anything in this pipeline that infers "how much total training has
happened" from that number (rather than from the optimizer/scheduler
state, which is genuinely cumulative) will be wrong across a resume
boundary.

## 6. Gap and follow-up

Two real, code-confirmed gaps came out of this:

1. **Dataloader/sampler position is never restored** (§4) — minor, bounded
   to at most one epoch's worth of re-ordering/repeated data per resume.
2. **The epoch/step display bookkeeping (`train_state.json`, numbered
   `-state` dir names) does not reliably track cumulative position across
   resumed invocations** (§5) — more significant, because anything that
   trusts that number (a phase-budgeting heuristic, a "how many epochs
   left" estimate, a human skimming checkpoint filenames) can be misled
   about real progress even though the underlying optimizer/scheduler
   state is fine.

Follow-up filed: [T-0312](T-0312)
(`tasks/T-0312.md`) — instrument `lora_train.train` to log
`num_update_steps_per_epoch` (or the dataset length it derives from) and
the loaded `current_step`/`current_epoch` on every `--resume`, so a future
resume's true cumulative position is verifiable from the run log instead
of re-derived from source after the fact. This worktree's local `tasks/`
directory is a stub subset of the real backlog (121 files, topping out at
`T-0222`, well short of this card's own `T-0311`), so `T-0312`'s id was
chosen as "one past this card" rather than derived from that stub's own
next-id count — the card body flags this explicitly and asks the planner
to confirm the id is actually free on its next pass. Nothing depends on
`T-0312` yet, so a renumber there is low-cost if it does collide.
