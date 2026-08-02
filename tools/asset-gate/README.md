# asset-gate

Machine-checkable validation gate for generated art + audio assets.
Implements **T-0102** (`tasks/T-0102.md`) per `docs/design/13-asset-pipeline.md`
§2 (art) and §4.8 (audio), and `docs/HANDOFF.md` §4/§7.

## Why this exists before any generation code

Under **D-18** (`docs/HANDOFF.md` §2), generated output ships as-is —
no hand editing, ever. Rejection means *regenerate with an adjusted
recipe*. That workflow only works if rejection is automatic, so this gate
**is** the quality mechanism, not a nice-to-have review aid. It is built
now, ahead of the generation chain (T-0070-0074, T-0081-0083, T-0101), so
that chain becomes red -> green against a gate that already exists,
instead of a taste argument once assets exist.

Human review remains the terminal gate — these checks decide whether a
set is *eligible* for review, not whether it is good.

## Location + language

`tools/asset-gate/` (Python), not `assets/`. `assets/` (per `docs/PLAN.md`
§1 and `.claude/rules/assets.md`) is reserved for generation *content* —
`assets/src/` recipes and `assets/final/` curated output, gated by the
license-allowlist hook and the `art/*` branch policy. This package is
generic file-analysis tooling with no generation content of its own, so
it lives alongside `tools/board/` instead — same role (versioned tool
package), different language because the job is image/audio numerical
analysis (Pillow/numpy/scipy/soundfile), not a Kanban UI.

## Install

```sh
cd tools/asset-gate
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Test / lint

```sh
.venv/bin/pytest -q
.venv/bin/ruff check .
```

CI: `.github/workflows/ci-asset-gate.yml` runs both on every push/PR
touching `tools/asset-gate/**`.

## CLI

```sh
asset-gate art-palette <image.png> --palette config/palette.placeholder.json
asset-gate art-tile-seam <tile.png>
asset-gate art-orphan-pixels <image.png> --size-threshold 2
asset-gate art-indexed-preservation <image.png> --palette <file>
asset-gate audio-gate <file.wav> --bus gameplay_sfx --loudness-targets config/loudness_targets.placeholder.json
```

Each command prints a `[PASS]`/`[FAIL]` line per check and exits `0` only
if every check passed. Checks that need more structure than a single file
+ a couple of flags (transition adjacency, cell fit, frame consistency,
atlas determinism) are library functions (`asset_gate.art`) meant to be
called from the generation agent or a test, not one-off CLI flags — see
their docstrings.

## Checks

### Art (`asset_gate/art.py`, `asset_gate/palette.py`)

| Check | Function | Asserts |
|---|---|---|
| Palette membership | `palette.check_palette_membership` | Every colour actually used resolves to an exact member of the home palette (no near-miss/distance matching). |
| Index semantics (**P-4**) | `palette.check_index_semantics` | Index `N` falls inside the canonical slot set *and* resolves, via the image's own embedded palette, to the same RGB the home palette declares for slot `N`. Distinct from membership: colours can all be valid members while slots are swapped — see `tests/test_palette.py::test_index_semantics_fails_when_slots_are_swapped_even_though_colours_are_members`. |
| Tile seamlessness | `art.check_tile_seamlessness` | Left column == right column, top row == bottom row (index equality). |
| Transition adjacency | `art.check_transition_adjacency` | Two declared tiles match on their shared edge (`edge="horizontal"`: A's right column == B's left column; `edge="vertical"`: A's bottom row == B's top row). |
| Cell fit | `art.check_cell_fit` | No foreground pixel touches a cell border shared with a neighbouring cell (outer sheet edges are exempt). Returns one `CheckResult` per cell. |
| Orphan pixels | `art.check_orphan_pixels` | No foreground connected-component smaller than a configurable pixel-count threshold (open question **P-B** — tune per set). |
| Frame consistency | `art.check_frame_consistency` | Silhouette delta between two adjacent frames, as a ratio of the symmetric difference over the union, stays within a configurable bound. |
| Atlas determinism | `art.check_atlas_determinism` | Same input image set -> byte-identical packed output (T-0074). Thin wrapper over the shared `asset_gate.determinism.check_reproducible` harness. |
| Indexed preservation | `art.check_indexed_preservation` | Output is still PIL mode `'P'` with the expected palette — Pillow silently converts to RGB on several operations (crop/paste/etc. can trigger this). |

### Audio (`asset_gate/audio.py`)

All audio checks take **decoded samples from the encoded file** — per
`13-asset-pipeline.md` §4.7, Ogg Vorbis encoder padding can break a seam
that was clean in the source, so validating the source instead of the
shipped file would miss exactly the bug this exists to catch.

| Check | Function | Asserts |
|---|---|---|
| Loop seam | `check_loop_seam` | First/last `window` samples of the encoded file match within a linear-amplitude threshold. |
| Integrated loudness | `check_integrated_loudness` | EBU R128 integrated loudness (via `pyloudnorm`, ITU-R BS.1770) within `tolerance_db` of the bus's target LUFS. TODO(**AU-2**) — targets are placeholders. |
| True peak | `check_true_peak` | 4x-oversampled peak (inter-sample peak approximation) <= `max_dbtp` (default -1 dBTP). |
| Sample rate / bit depth | `check_format` | Matches the format table (`13` §4.7: WAV 44.1kHz one-shots; Ogg Vorbis for music/ambience, no PCM bit depth). |
| Length bounds | `check_length_bounds` | Duration within the recipe's declared `[min_s, max_s]`. |
| Leading/trailing silence | `check_silence_trimmed` | Silence (below an amplitude threshold) at the start/end doesn't exceed `max_silence_s`. |
| DC offset | `check_dc_offset` | Mean sample value is approximately zero. |
| Determinism | `check_determinism` | Same recipe + seed -> byte-identical output (T-0101 one-shots especially). Thin wrapper over `asset_gate.determinism.check_reproducible` — the same harness `art.check_atlas_determinism` uses, since it's the identical predicate applied to a different producer. |

## Open placeholders

Two config files ship **documented placeholders** for values the design
docs mark as unresolved, so the checks that depend on them are exercisable
now rather than blocked:

- **`config/palette.placeholder.json`** — TODO(**V-5**). The real home
  palette (colour count + hex values) isn't decided. Slot *indices* are
  load-bearing (P-4 / the chroma swap), so when V-5 lands: replace the hex
  values, don't reorder or renumber existing slots that generation has
  already started depending on.
- **`config/loudness_targets.placeholder.json`** — TODO(**AU-2**). Real
  per-bus-class LUFS targets aren't decided; current values are
  conservative EBU R128 defaults.

## Deferred (needs real assets or an unresolved design question)

- **Transition adjacency / cell fit / frame consistency** are exercised
  in tests with tiny synthetic tiles, but haven't been run against a real
  tileset or character sheet yet — that's T-0070+.
- **Orphan-pixel and frame-consistency thresholds** are parameters, not
  hardcoded, pending **P-B** (tune on first real set).
- **True-peak / loudness measurement** hasn't been cross-checked against
  a reference implementation (e.g. `ffmpeg -af loudnorm`/`ebur128`) on a
  real mastered asset — the synthetic sine fixtures validate the check's
  pass/fail logic, not its absolute numerical accuracy against a
  broadcast-certified meter.
- **Format table** (`check_format`) is a general-purpose function; no
  CLI flag wires it into `audio-gate` yet, since the expected
  sample-rate/bit-depth pair depends on the asset's class (one-shot WAV
  vs. streamed Ogg) which the generic CLI command doesn't know. Call it
  directly once T-0101/T-0083 know their own expected format.
