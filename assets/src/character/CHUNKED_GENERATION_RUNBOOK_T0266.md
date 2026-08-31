# Chunked/resumable §24-e generation — runbook (T-0266)

Applies to every §24-e per-frame hybrid generator: WALK
(`gen_hybrid_walk_T0259.py`), and HIDE/ACTION once they exist. All three
share `char_gen.chunked_frames` (`assets/src/character/src/char_gen/chunked_frames.py`)
for resume + chunk bookkeeping — see that module's docstring for the full
mechanism. This doc is the runbook: what to actually type, in what order.

## Why this exists

Measured per-frame cost from real ComfyUI history (T-0259, 5 real walk
generations): 95.2s, 100.4s, 118.0s — ~100s/frame. An 8-frame sheet is
~14 minutes of GPU time. **A single foreground shell call caps at
600000ms = 10 minutes.** One call cannot finish a sheet. Backgrounding the
generator and ending the turn does not help either: the background child
is torn down with the session, orphaning the ComfyUI run mid-sheet with no
resume logic reachable from outside that session — this is exactly how
T-0259 got stuck at signature `3f1568f9…` twice, with ComfyUI observed
still `running=1` after the card had already flipped to `blocked`.

## The rule

**Drive a sheet to completion with sequential foreground calls of the
identical command, inside one implementer session.**

```
python3 assets/src/character/gen_hybrid_walk_T0259.py --attempt 1 --seed 31416
```

Run it. It generates the next `--max-frames` (default 4, see
`char_gen.chunked_frames.DEFAULT_MAX_FRAMES`) still-incomplete frames and
either:

- prints `chunk complete, frames remain -- re-run the identical command to
  continue` and exits 0 — **run the exact same command again**; already-
  complete frames are skipped, and generation resumes from the first
  incomplete one; or
- prints the full provenance JSON — every frame is done, the sheet is
  assembled, and `provenance_candidate.json` is written.

Never do this instead:

```
# WRONG — do not do this.
gen_hybrid_walk_T0259.py --attempt 1 --seed 31416   (run_in_background: true)
<end the turn>
```

The background process's ComfyUI request keeps running against the GPU,
but nothing in the implementer's own session is left to see it finish,
resume it, or write the frames it produces into a state a next chunk can
build on. That is not "slower" — it is a run that produces nothing anyone
can find.

## Tuning `--max-frames`

The default (4, ~7 minutes of generation against the 10-minute cap) is
derived from the measured per-frame cost with 180s of headroom for
IP-Adapter upload, cutout/assembly and HTTP polling overhead — see
`char_gen.chunked_frames.default_max_frames`. If a host's measured
per-frame cost differs meaningfully, pass an explicit `--max-frames`
rather than trusting the default; do not guess a bound with no measurement
behind it.

## After the sheet is complete

```
python3 assets/src/character/gen_hybrid_walk_T0259.py --attempt 1 --promote-attempt 1
```

Promotes to `assets/final/character/player_walk_sheet_hybrid.png` (only if
the mechanical frame-delta gate passed), re-homes the promoted attempt's
per-frame pose evidence into a committed directory, and appends the
attempt log. Then run the gate tests
(`assets/src/character/tests/test_player_walk_hybrid_T0259_gate.py`), the
`asset-provenance` skill, attach the sheet to the card via the attachments
API, and commit.

## If generation is blocked

Write and commit `ARM_<NAME>_ATTEMPT_LOG_<CARD>.md` per
`.claude/rules/assets.md` — with the `Write` tool, never shell redirection.
A blocked generation that is not written down reads from the outside as
"nothing happened" (T-0259's own history — `assets/out/` is gitignored, so
partial frames are invisible to the diff).
