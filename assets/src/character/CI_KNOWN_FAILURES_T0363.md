# T-0363 investigation notes

Two things this card's acceptance criteria asked to be recorded, not just
fixed in code. Written down here because a commit message doesn't survive
into a PR body the way a tracked file does.

## 1. The 2026-09-11 "soundfile absent, could not collect" report

**Could not be reproduced against a clean venv built from
`assets/src/character/pyproject.toml` alone.** Exhaustive static trace,
confirmed by actually collecting the suite in such a venv (1174 items
collected, zero collection errors, zero `importorskip` skips):

- `assets/src/character/tests/conftest.py` sys.path-injects exactly three
  things: `tools/asset-gate/src`, this package's own `src/`, and
  `assets/src/lora/src`. It does not touch `assets/src/audio` or
  `assets/src/ambience_synth` (the only two packages under `assets/src/`
  that import `soundfile`).
- Every `asset_gate.*` module actually reachable from character's test
  suite (`art`, `character`, `palette`, `determinism`, `transparency`, per
  `grep -rhoE 'asset_gate[a-zA-Z0-9_.]*' tests --include=*.py`) has no
  `soundfile`/`pyloudnorm`/`scipy` import in its own import block.
  `asset_gate/__init__.py` is empty. `asset_gate.cli` -- the one module in
  that package that *did* unconditionally import `soundfile` before this
  card's `e69237e` -- is never imported by anything under
  `assets/src/character/tests/`.
- `assets/src/lora/src/lora_train/*` (config/manifest/attach/fetch/train)
  has no soundfile-adjacent import either.
- The only `scipy` references anywhere under `assets/src/character` are
  already-lazy, already-guarded `from scipy import ndimage` calls inside
  try/except blocks in `src/char_gen/synth_entities.py:490` and
  `gen_arm_a_idle_T0228.py:476,513` -- not on any collection path, and not
  new.

So in this package's own clean venv, nothing on the collection path ever
touches `soundfile`. The `asset_gate.cli` lazy-import fix in `e69237e`
(deferring `import soundfile as sf` / `from asset_gate import audio` into
`_cmd_audio_gate`) is real, correct hardening for `asset_gate.cli` as a
module in its own right -- a caller that only needs the non-audio
subcommands genuinely no longer needs to have the audio stack installed to
import it -- but it is **not** the fix for the reported collection failure,
because that failure's actual trigger was never identified. The commit
messages on `227cc63`/`e69237e` overstated this connection; this file is
the correction. If the 2026-09-11 report recurs, the next place to look is
whatever venv/command actually produced it (a shared multi-package venv
picking up `assets/src/audio`'s test collection alongside character's own,
for instance) rather than anything inside this package.

## 2. Pre-existing test failures excluded from `ci-character.yml`

A full `pytest -q` run of this package's suite from a venv built only from
its own `pyproject.toml` is **17 failed, 131 errors, 1026 passed** on this
branch -- and reproduces identically on `develop` (none of the files below
are touched by this branch's diff; `git diff --stat develop...HEAD --
<file>` is empty for every one of them). The exact 148 failing/erroring
node ids are listed one per line in
`tests/T0363_KNOWN_FAILING_IDS.txt` (verified to match this branch's own
`.pytest_cache/v/cache/lastfailed` exactly), and `ci-character.yml`'s
`pytest -q` step `--deselect`s each of them individually -- not a whole-file
`--ignore` -- so currently-passing tests in the same module (e.g.
`test_gate_report_T0349.py` is 6 green / 1 red; every v2 gate file has one
passing test alongside its broken ones) still run in CI instead of being
dropped as collateral:

| Files | Node ids excluded | Root cause (not diagnosed further -- out of this card's scope) |
|---|---|---|
| `tests/test_gate_report_T0349.py` | 1 of 7 | committed gate report no longer matches a fresh recomputation |
| `tests/test_player_idle_arm_a_gate.py` | 4 of many `test_frame_consistency` parametrizations (`cell_a2-cell_b2`, `cell_a4-cell_b4`, `cell_a5-cell_b5`, `cell_a7-cell_b7`) | pixel-delta drift against the committed sheet on those specific cell pairs only |
| `tests/test_player_profile_hybrid_T0272_gate.py` | 17 (effectively the whole file) | `assets/final/character/player_profile_keyframe_hybrid_T0272.provenance.json` is genuinely absent from the checkout, so every test sharing that fixture errors at setup |
| `tests/test_sound_idle_gate_v2.py`, `test_sound_move_gate_v2.py`, `test_sound_trapped_gate_v2.py` | all but 1 test per file | committed `assets/final/entity/sound_*_sheet_v2.png` opens as PIL mode `RGB`, not the indexed `P` the shared `sheet` fixture asserts |
| `tests/test_still_air_idle_gate_v2.py`, `test_still_air_move_gate_v2.py`, `test_still_air_trapped_gate_v2.py` | all but 1 test per file | same `RGB`-vs-`P` mode mismatch, `still_air_*_sheet_v2.png` |
| `tests/test_watcher_idle_gate_v2.py`, `test_watcher_move_gate_v2.py`, `test_watcher_trapped_gate_v2.py` | all but 1 test per file | same `RGB`-vs-`P` mode mismatch, `watcher_*_sheet_v2.png` |

This card is test-hygiene/CI wiring (conftest writes, the soundfile report,
getting a CI job running at all) and its own "do not" section forbids
readying, running, or re-scoping any GPU/asset-generation work from it --
which is what fixing any row above would require (regenerating or
re-exporting shipped sheets through ComfyUI, or reconciling a stale gate
report). Excluding them by explicit node id, with the evidence above, means
a future card can pick up each one individually instead of this CI job
silently growing wider -- or silently losing coverage it didn't need to --
over time.
