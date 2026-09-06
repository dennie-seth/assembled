# T-0281 reference sourcing — profile pose (for T-0273)

Sourced via `tools/board/scripts/referenceFetch.js` only (wikimedia + openverse).
Files live in `assets/src/reference/quarantine/` (gitignored, not committed) and
are attached to T-0273 directly.

## Kept: 1 / candidates fetched: 2

| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |
|---|---|---|---|---|---|
| `b1006b0a72...` | Silhouette walking man png illustration | openverse | cc0 | 2026-09-01T17:16:17.577Z | **KEPT** — clean, true side-on silhouette, mid-stride, unambiguous profile |
| `fc7fbd13ce...` | Man walking in silhouette | openverse | by | 2026-09-01T17:16:15.750Z | REJECTED — figure is small, distant, and back/three-quarter facing in a dim interior; does not read as a true side profile at any legible scale |

## Also attempted, not obtainable this pass

- `openverse search "man side profile standing pose"` and `"figure profile walk cycle animation reference"` returned no true-profile candidates (postcards, unrelated photos, or empty).
- `wikimedia search "man standing side profile silhouette"` returned only book/PDF scans (Internet Archive text digitizations) — no raster images; wikimedia's `search` endpoint is text-indexed over Commons filenames and did not surface photographic content for this query.

## Selection reasoning

Per the edge case in the card ("a 'profile' that is actually three-quarter is not
a profile" — see T-0259), the bar here was strict: reject anything not clearly
side-on. Only one of the two fetched candidates cleared it. Character-likeness
was not a factor in either direction, per the card's instruction — both
candidates are anonymous/generic silhouettes, evaluated purely on pose/angle
clarity.

## Not superseded

This card does not curate/commit a final for T-0273 — that card still owns
selecting from (or supplementing) this candidate set, committing into its own
target path, and its own `ASSET_PROVENANCE.md` entry.
