# assets/archive/

Superseded assets kept for reference and git history. Nothing under here is
consumed by the game client, by any generator script's own output path, or
by the asset gate (`tools/asset-gate`) — the gate is only ever pointed at
`assets/final`, and `assets/archive/` is a sibling directory, never a
subdirectory of it, so it is never globbed.

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
