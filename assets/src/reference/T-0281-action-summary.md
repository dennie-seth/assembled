# T-0281 reference sourcing — action poses (for T-0280)

Sourced via `tools/board/scripts/referenceFetch.js` only (wikimedia + openverse).
Files live in `assets/src/reference/quarantine/` (gitignored, not committed) and
are attached to T-0280 directly. Reported **per interaction**, as the card
requires — pick_up, open, and touch are not interchangeable.

## pick_up — kept 1 / candidates fetched 1

| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |
|---|---|---|---|---|---|
| `87d852d29f...` | "man bending street pick scrap" (an 1827 lithograph, "I want all the Scraps I can Collect") | openverse | cc0 | 2026-09-01T17:20:13.147Z | **KEPT** — clean side-on silhouette, one leg forward, torso bent fully over, arm extended down to an object on the ground. Unambiguous pick_up read even at small scale |

`openverse search "person picking up object from ground"` and `"stooping to
pick up item"` returned mostly unrelated photos (golf, ribbon-cuttings, a
distant unclear figure); this lithograph, found via "person bending down
picking up", was the one clear hit.

## open — kept 1 / candidates fetched 3

| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |
|---|---|---|---|---|---|
| `a62120b2b3...` | Inspector opening crate | openverse | pdm | 2026-09-01T17:24:09.388Z | **KEPT** — bent-forward stance, both hands engaged at a crate lid at waist height with a pry tool. Reads clearly as an open/pry interaction; body engagement (not the literal tool) is what T-0280 needs |
| `7afa3e632d...` | "Pandora opened her box" | openverse | by | 2026-09-01T17:22:03.522Z | REJECTED — a dramatic macro shot of a box lid with mist/light effects; **no person or body in frame at all**, so it carries no pose information despite the on-topic title |
| `ad17cd3927...` | "Push Pad to Open Automatic door..." | openverse | by-sa | 2026-09-01T17:23:25.291Z | REJECTED — a photo of two signs reading "Push Pad to Open" / "Automatic door"; no figure, no pose |

Several additional "opening the door" / "lifting the lid" candidates (a stone
sarcophagus lid, a relish jar, a front door) were licensed `by-nc`, `by-nc-sa`,
or `by-nc-nd` and were correctly rejected by the licence gate before ever
reaching a content review.

## touch — kept 1 / candidates fetched 2

| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |
|---|---|---|---|---|---|
| `87ea974a94...` | "The Creation of Adam who reclines at left and touching the hand of God" (engraving after Michelangelo) | openverse | cc0 | 2026-09-01T17:22:09.871Z | **KEPT, with a caveat** — a fully extended arm reaching to a single-point fingertip contact is the clearest touch gesture found, and reads even at small scale. The pose is reclining rather than standing, and the contact target is another figure's hand rather than an object — both are compositional mismatches to an in-game standing-touches-an-object interaction |
| `1ecef852b3...` | "reach out and touch" | openverse | by | 2026-09-01T17:28:59.426Z | REJECTED — a macro close-up of a bronze memorial statue's hand between draped robe folds; no legible full-body pose |

## What's missing, and why it's reported rather than silently dropped

`touch` is the weakest-sourced of the three interactions, matching the card's
own edge-case warning that it's "the easiest to under-source." No open-licence
image of a standing figure reaching out to touch an object/surface (as
opposed to another person, or a disembodied close-up) was found across
several query angles (hand-on-machine-panel, hand-on-tree-bark, fingertip
close-ups, handshakes — the last rejected as a poor match on its own terms
since it's an interpersonal gesture, not an object interaction). The kept
Creation-of-Adam engraving is offered as the best available arm/hand
mechanics reference, not a pose-complete substitute; T-0280 should treat
`touch` as needing either further sourcing or a generated in-between frame
once art direction allows conditioning off this reference.

## Selection reasoning

Per the card: "A set that only shows generic reaching has not met the brief"
— each interaction was searched and judged independently rather than
accepting one reach/bend photo as generically standing in for all three.
Two "on-topic by title" results (Pandora's box, the door-open sign) were
rejected specifically because, on inspection, they contained no figure at
all — title text is not pose data. Character-likeness was not a factor in
any of the three interactions' selections.

## Not superseded

This card does not curate/commit a final for T-0280 — that card still owns
selecting from (or supplementing) this candidate set per-interaction,
committing into its own target path, and its own `ASSET_PROVENANCE.md` entry.
