# T-0281 reference sourcing — sitting pose (for T-0278)

Sourced via `tools/board/scripts/referenceFetch.js` only (wikimedia + openverse).
Files live in `assets/src/reference/quarantine/` (gitignored, not committed) and
are attached to T-0278 directly.

## Kept: 5 / candidates fetched: 5 (+1 unfetchable)

All five are consecutive frames from the same 1887 Eadweard Muybridge motion
study, "Woman in long dress placing a chair, sitting and reading"
(`rbm-QP301M8-1887-241b`), indexed by Openverse from a public-domain archival
scan. Same subject, same side-on camera angle, same plain backdrop across the
whole sequence — this is a genuine multi-frame descent, not four unrelated
poses:

| File (sha256 prefix) | Frame | Licence | Retrieved | What it shows | Verdict |
|---|---|---|---|---|---|
| `f2781f5597...` | `~2` | pdm | 2026-09-01T17:26:00.859Z | Standing, carrying the chair into place, upright | **KEPT** — pre-sit approach |
| `bbc76d355d...` | `~7` | pdm | 2026-09-01T17:26:32.697Z | Standing beside the placed chair, hand on its back, weight still upright | **KEPT** — pre-descent |
| `98d68ccab4...` | `~9` | pdm | 2026-09-01T17:26:46.295Z | Knees visibly bending, torso lowering | **KEPT** — mid-descent (the frame the card specifically asked for) |
| `5121ef2f5e...` | `~10` | pdm | 2026-09-01T17:26:48.467Z | Weight landing on the seat, torso still forward-leaning | **KEPT** — settling |
| `f63ebf3408...` | `~12` | pdm | 2026-09-01T17:25:58.899Z | Fully seated, settled, reading | **KEPT** — settled seated pose |

## Also attempted, not obtainable this pass

- `openverse fetch` on a promising still ("Auf dem Boden sitzende junge Frau im
  Profil nach links" / "young woman sitting on the floor in profile facing
  left", asset id `4cc2e911-...`) failed twice with an upstream HTTP 424 from
  Openverse's own thumbnail proxy — not a licence rejection, the asset itself
  could not be retrieved. Not counted in the candidate/kept tally above since
  no bytes were ever received.
- `openverse search "sitting down pose silhouette"` and `"seated figure
  illustration"` returned no on-topic matches (unrelated museum objects,
  statues, maps).

## Selection reasoning

The card's edge case is explicit: "a crouch is not a sit and a sit is not a
hide — only the sit settles the weight." The Muybridge sequence was preferred
over single stock stills specifically because it shows the actual weight
transfer (upright -> knee bend -> seat contact -> settled) rather than only a
before/after pair. Frame `~12`'s slight forward lean (reading) also works as
the card's requested "small seated variation" relative to a neutral
straight-backed seated silhouette. Character-likeness was not a factor — the
figure's period dress is irrelevant to the pose data being extracted.

**Caveat the card itself calls out:** "seated figures are often occluded by
furniture ... the game's character sits without a chair drawn into the
sprite." Every kept frame here includes the actual wooden chair the subject is
using — it wasn't avoidable without giving up the one genuine multi-frame
descent sequence found. The body's hip/knee line stays visible past the chair
in all five frames, so the pose itself reads, but whoever curates from this
set for T-0267/T-0268/T-0269 should condition on the body only and disregard
the furniture, not treat the chair as part of the reference.

## Not superseded

This card does not curate/commit a final for T-0278 — that card still owns
selecting from (or supplementing) this candidate set, committing into its own
target path, and its own `ASSET_PROVENANCE.md` entry.
