# assets/archive/

Superseded assets kept for reference and git history. Nothing under here is
consumed by the game client or by any generator script's own output path.

**It IS still globbed by three of the six asset-gate sweeps.**
`character-gate`, `transparency-sweep`, and `visibility-sweep` are rooted at
`assets/final` (a sibling of `assets/archive/`, never a parent of it), so
those three never see anything archived. But `provenance-sweep`,
`generator-sweep`, and `generator-hash-sweep` (`.github/workflows/ci-asset-gate.yml`
`:60`, `:84`, `:105`) are rooted at the whole `assets/` tree — `archive/` is
inside that root, so every `.provenance.json` sidecar moved here is still
swept. **Any pre-existing baseline exemption for a moved sidecar
(`provenance_baseline.txt`, `generator_baseline.txt`) must be re-keyed to
its new `archive/...` path in the same move**, or the sweep re-fails on a
gap that never changed, just because the path it's keyed to no longer
matches (T-0424 round 2 learned this the hard way — see
`docs/decision-log.md` DL-32).

## What belongs here

An asset that:

- was once a curated final under `assets/final/`,
- has been measurably superseded (on merit — a gate check, a benchmark
  comparison, an explicit replacement that shipped or is planned), and
- is worth keeping around for provenance / history / comparison,

moves here with `git mv`, preserving its file history, never `git rm` +
re-add. Its `.provenance.json` sidecar (and any other companion file that
references it — a `.gate_report.json`, a preview image) moves with it.

## What does not belong here

- An asset still referenced by `client/`, a generator script's committed
  output path, or any other `assets/final/**` asset. Archiving must never
  leave a dangling reference.
- A first draft that was never promoted to `assets/final/` in the first
  place — that's just an unpromoted attempt, not an archived final.
- Anything a human hasn't already recorded a reason to retire in
  `docs/decision-log.md`. An archive entry with no decision-log entry reads
  as a cover-up, not hygiene — see DL-32 (T-0424) for the shape that entry
  should take: the measured numbers, why the asset lost, and what (if
  anything) replaces it.

## Example

T-0424 archived six legacy `player_{crouch_hide,die,move}_sheet_v{1,2}`
character sheets here: each measurably failed the character gate's
pose-fidelity/identity-stability checks, nothing in `client/` referenced
any of them, and their poses are superseded by T-0338's per-state
compositor. See `docs/decision-log.md` DL-32.
