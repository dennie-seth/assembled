# T-0281 reference sourcing — hide pose (for T-0279)

Sourced via `tools/board/scripts/referenceFetch.js` only (wikimedia + openverse).
Files live in `assets/src/reference/quarantine/` (gitignored, not committed) and
are attached to T-0279 directly.

## Kept: 1 / candidates fetched: 4 (+2 unfetchable)

| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |
|---|---|---|---|---|---|
| `376ea0b5e1...` | MICHELANGELO, Buonarroti Crouching Boy, c1524 | openverse (Commons-sourced photo of the Hermitage sculpture) | by | 2026-09-01T17:24:59.751Z | **KEPT** — the single strongest match to the brief: knees drawn fully in, torso curled over them, arms tucked, weight settled low. Silhouette compression is dramatic and the pose reads as genuinely "holdable" |
| `986df17e0e...` | Sketches of Crouching and Standing Figures... by Paul Gauguin | openverse | by | 2026-09-01T17:18:03.647Z | REJECTED — a loose watercolour sketchbook page with several small, overlapping figures; the one crouching figure is too small and too sketchy to read as clean pose reference |
| `7fd81c048c...` | Animal locomotion. Plate 236 [296] (Muybridge) | openverse | by | 2026-09-01T17:25:43.407Z | REJECTED — the query surfaced this by keyword coincidence; the plate is a walking/marching sequence, not a crouch. No silhouette compression at all |
| `01d593f780...` | Man in pelvis cloth kneeling, firing a bayonet and rising (Muybridge) | openverse | by | 2026-09-01T17:27:40.304Z | REJECTED — a kneeling *shooting stance* with an arm extended holding a weapon; body stays open/extended rather than compressed, and the weapon silhouette would mislead the pose read |

## Also attempted, not obtainable this pass

- Two Wikimedia Commons fetches for other Crouching Boy angles (`File:Michelangelo-Buonarroti-Crouching Boy-3-Hermitage.jpg` and `-5-...`) were retried several times across the session and consistently rejected with HTTP 429 from `upload.wikimedia.org` — the wrapper's own search endpoint (`commons.wikimedia.org`) stayed responsive throughout, so this looks like a stricter, separate rate limit on Wikimedia's binary/imageinfo path rather than a wrapper malfunction. Per the card's edge case ("rate limits are paced, not fatal"), this was treated as a pacing issue, not an error to route around — the equivalent artwork was still obtained through Openverse's own proxy of the same Commons content (the kept file above), so no reference was lost, only a second angle.
- Openverse-side searches for "crouching pose silhouette", "hiding behind wall crouch", "cowering figure", "duck and cover" (title match, but licensed `by-nc-sa` — rejected by the licence gate), and a Heiligenkreuz slave-statue photo (licensed `by-sa-at`, an Austrian CC BY-SA variant string not on the wrapper's exact allowlist — rejected, correctly, rather than assumed-equivalent) did not yield an additional keepable candidate.

## What's missing, and why it's reported rather than silently dropped

The brief asks for both **the descent into hiding** and **a settled, compact
pose**. Only the settled pose was sourced with an open licence this pass — no
open-licence photographic or illustrated sequence of a person *lowering into*
a compact hide was found; the Muybridge kneel-and-rise sequence that looked
promising turned out to be a shooting stance, not a hide, on inspection (see
rejection above). T-0279 should treat the descent motion as unsourced from
this pass and either source it separately or condition a generated
in-between frame on the kept Crouching Boy still as the compressed end pose.

## Selection reasoning

The card's edge case is explicit: "a crouch is not a sit and a sit is not a
hide — only the hide compresses the silhouette." That was the deciding
criterion throughout — several superficially on-topic "crouching" results
(sketchy, mid-stride, or holding a weapon) were rejected specifically because
they did not compress the silhouette the way the brief requires.
Character-likeness was not a factor — a Renaissance marble nude has nothing
to do with the player's costume, only its pose data was extracted.

## Not superseded

This card does not curate/commit a final for T-0279 — that card still owns
selecting from (or supplementing) this candidate set, committing into its own
target path, and its own `ASSET_PROVENANCE.md` entry.
