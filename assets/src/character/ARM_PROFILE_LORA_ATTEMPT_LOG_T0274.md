# Attempt log — T-0274 profile identity LoRA training

**Author:** Claude (Sonnet 5)

This is the committed attempt log `.claude/rules/assets.md` requires for a
blocked generation. It should have been written after the first interrupted
training run; it was not, across three prior VALIDATION FAIL rounds (see the
card's own Validation history) that each flagged its absence. This session
(run 4) writes it and stops training rather than continuing to compound the
underlying problem.

## What actually happened, mechanically

Training genuinely runs. `assets/src/lora/src/lora_train/train.py` is
correctly designed for exactly this environment: "a single card's training
phase is many separate invocations of this module, each resuming where the
last left off" (its own docstring, rule (b)) — a fresh implementer session's
own wall-clock budget is well under the ~160-175 min a full run needs
(T-0229). Three prior sessions each invoked

```
PYTHONPATH=assets/src/lora/src:assets/src/character/src /home/dennieseth/dev/lora-train-venv/bin/python3 \
  -m lora_train.train --config assets/src/character/training_config_player_identity_profile_v1.toml \
  --save-every-n-steps 4
```

resuming from the previous session's `--save_state` checkpoint each time
(`find_resume_state` picks the most-recently-modified `*-state` dir — no
explicit `--resume` needed), and each made real forward progress before its
own session ended: run 2 reached step ~20/72, run 3 reached epoch 7 (the
furthest-mtime state dir is `player_identity_profile_v1-000007-state`,
2026-09-05 12:05:53 local), i.e. ~42/72 steps (58%), alongside step-cadence
saves up to `-step00000024-state`. No OOM, no crash, no tool denial — every
prior interruption is simply the session ending with the run still short of
its 72-step (12 epochs × 6 refs) target. This is expected per the module's
own design, not an infrastructure failure.

## Why this session does not resume training further

Re-reading the dependency chain surfaced the actual blocker, present since
run 1's VALIDATION and never resolved:

`assets/src/concept/player_profile_reference_SUMMARY.md` (T-0273, the
source of the six profile reference images this LoRA trains on) ends with:

> Per `requires_approval: true`, this card parks for @DennieSeth's review
> before T-0274 trains on anything here. No approval record is written by
> this card.

`ASSET_PROVENANCE.md`'s T-0273 entry ends identically: "**Parked for
@DennieSeth's approval per `requires_approval: true`.**" No approval record
exists anywhere in the repo — not on the card, not in
`docs/decision-log.md`, not in `ASSET_PROVENANCE.md` — as of this session
(checked via `grep -rn "APPROVED\|approved_by\|approved_at"` across the
tree; zero hits tied to T-0273).

Per `.claude/rules/conduct.md`: "a card with `requires_approval: true`...
is finished only when a human has looked at the artifact and said yes...
do not advance any card that depends on it" until that happens. T-0274
depends on T-0273's reference set (acceptance #1: "trained on C1's
committed, **approved** profile reference set"). That approval has not
happened. Three training sessions already ran against this parked material
before this session noticed the dependency was still open — a process
violation this session does not compound by resuming a fourth time,
finishing the run, deploying the result to the ComfyUI host, or writing any
provenance/attachment record for it. Deploying or attaching a deliverable
built on unapproved source material would itself be "advancing a dependent"
of an unapproved card, which is exactly what the rule prohibits.

**This session does not write an approval record.** That is @DennieSeth's
call, not this agent's, per the same rule.

## What is preserved vs. what is not

- The nine `*-state/` checkpoint directories under `assets/final/lora/`
  (gitignored, never committed) are left on disk untouched — training can
  resume exactly where it left off (epoch 7/12) the moment T-0273 is
  approved, with no lost work.
- The 13 intermediate per-epoch/per-step `.safetensors` *weight snapshots*
  that had been committed to git in prior sessions
  (`player_identity_profile_v1-000001..000007.safetensors`,
  `-step00000004..00000024.safetensors`) are untracked in this session
  (`git rm --cached`, files kept on disk) and now gitignored
  (`.gitignore`: `assets/final/lora/*-[0-9]{6}.safetensors`,
  `assets/final/lora/*-step[0-9]*.safetensors`) — they are reproducible
  intermediates of an in-progress run, not curated finals, and
  `.claude/rules/assets.md` reserves `assets/final/` for curated finals
  only. This mirrors how T-0248's real `player_identity_v2` run was
  committed: only the unsuffixed final artifact + provenance sidecar, never
  the numbered intermediates.
- No `player_identity_profile_v1.safetensors` (unsuffixed final),
  `.provenance.json`, `ASSET_PROVENANCE.md` entry, ComfyUI deploy, smoke
  check evidence, or attachment upload is produced by this session, because
  none can legitimately exist yet — the training run has not completed and,
  independent of that, its source material is not yet human-approved.

## What would need to happen for this card to complete

1. @DennieSeth approves T-0273 (drags the card to Done or comments
   `APPROVED` — not this agent's action).
2. A subsequent session resumes training from the preserved
   `player_identity_profile_v1-000007-state` checkpoint (or later, if
   training is deemed acceptable to have continued despite the gate — a
   human call) to completion (epoch 12/72 steps), producing the unsuffixed
   `player_identity_profile_v1.safetensors`.
3. Write `player_identity_profile_v1.provenance.json` (same shape as
   `player_identity_v2.provenance.json`), append the `ASSET_PROVENANCE.md`
   entry, deploy via `lora_train.train.deploy_to_comfyui` (automatic on a
   completed run's exit code 0), execute
   `smoke_check_profile_lora_T0274.py` and commit its declared evidence
   (`assets/src/character/smoke_check_profile_T0274/{main_384.png,provenance.json}`),
   and upload the final artifact + smoke check image via the attachments
   API.

Until step 1 happens, none of steps 2-3 can legitimately close this card.
