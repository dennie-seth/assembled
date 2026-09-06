# T-0273 — player profile reference set (curated)

## What this is

The direction-approved PROFILE-view reference set for the player character
(the profile analogue of [T-0209](T-0209)'s front-view concept sheet).
[T-0272](T-0272) established that the §24-e ComfyUI/ControlNet stack cannot
produce a true side profile by construction — `player_identity_v2` and
`_POSE_KEYPOINTS_NORM` both encode front-facing topology that ControlNet's
structural conditioning enforces over the prompt. Per @DennieSeth's
2026-09-01 decision, the sourcing approach is an agent searching the open
internet through [T-0276](T-0276)'s scoped, licence-enforcing wrapper
(`tools/board/scripts/referenceFetch.js`) instead.

## 2026-09-03 — fresh fetch after the transport fix, superseding all prior sets

Five prior sessions (T-0281's original pass plus four T-0273 VALIDATION
cycles) were blocked by the same pair of failures: `upload.wikimedia.org`
byte-fetches 429ing and Openverse's search backend 504ing, tracked down to a
contact-less `User-Agent` header in `referenceTransport.js`. That defect was
fixed and merged as **PR #312** on `develop` (confirmed live 2026-09-03: 3/3
probe byte-fetches succeeded, including the exact asset that 429'd
repeatedly on 2026-09-02). This branch was **94 commits behind
`origin/develop`** and had never picked up that fix — the first step this
session took was `git merge origin/develop`, which brought in PR #312 (and
everything else that had landed since), with no conflicts.

With the transport fix live, this session ran `referenceFetch.js` fresh
against **both `wikimedia` and `openverse`**, per the card's "RE-FETCH
FRESH" amendment — not a curation pass over any prior attachment.

## Candidates: fetched 7, kept 6

| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |
|---|---|---|---|---|---|
| `0817eaf501...` | Animal Locomotion pl. 555 — side view of old man walking | wikimedia | Public domain (pdm) | 2026-09-03T17:06:14.867Z | **KEPT** — 12-frame true side-on walk cycle |
| `b13423a1f5...` | Animal Locomotion pl. 546 — side and rear views of man walking | wikimedia | Public domain (pdm) | 2026-09-03T17:06:16.229Z | **KEPT** — top row is a 12-frame true side-on walk cycle (different build than pl. 555); bottom row is rear-view and not used as profile evidence |
| `4ef2fcbe5b...` | Animal Locomotion pl. 552 — side and rear views of man walking with cane | wikimedia | Public domain (pdm) | 2026-09-03T17:06:20.311Z | **KEPT** — 12-frame true side-on walk cycle with a cane prop |
| `3b9ee3bc20...` | Silhouette walking man illustration | openverse | cc0 | 2026-09-03T17:06:41.677Z | **KEPT** — clean flat side-on silhouette, mid-stride |
| `09511dbc54...` | Silhouette walking man illustration | openverse | cc0 | 2026-09-03T17:06:46.074Z | **KEPT** — clean flat side-on silhouette, distinct leg phase |
| `8b5318f88e...` | Silhouette walking man illustration | openverse | cc0 | 2026-09-03T17:06:48.214Z | **KEPT** — clean flat side-on silhouette, distinct leg phase |
| `fc7fbd13ce...` | Man walking in silhouette | openverse | by | 2026-09-03T17:06:21.433Z | REJECTED on content grounds — the figure is tiny, distant, and dim in a dark interior; does not read as a legible profile at any usable scale (not a licence rejection — `by` would have been usable) |

I opened every kept image myself and re-checked each against the card's own
edge case ("a 'profile' that is actually three-quarter is not a profile" —
[T-0259](T-0259)): all six are unambiguous 90-degree side-on poses, not
three-quarter. Character-likeness was correctly not a factor in either
direction (per the card's own instruction) — this is anonymous pose/form
reference, not a costume match; [T-0209](T-0209) remains the identity
authority.

**The three Muybridge plates are three different subjects/gaits**
(pl. 555: older subject, plain walk; pl. 546: different subject, plain walk;
pl. 552: walk with a cane), each a 12-frame side-on walk-cycle sequence
within a single photographic plate. Combined with three independently
sourced flat-silhouette illustrations at different points in the stride, the
set gives real gait-phase and build variety, not six near-duplicates of one
pose.

## Superseded: the 2026-09-01/02 single-image set

The `b1006b0a72...` image promoted from [T-0281](T-0281)'s candidates in the
earlier sessions has been **removed from this set**. Its committed
provenance sidecar could never carry a `sourceUrl` or `assetId` — the
original `referenceFetch.js` sidecar lived only in T-0281's gitignored
quarantine directory and was destroyed when that worktree was reclaimed —
and the card's acceptance criteria are explicit that "a kept image without a
resolvable `sourceUrl` fails this card." Every image in the set above was
fetched by this session directly, so every `sourceUrl` is live and
independently verifiable right now.

## Coverage

**Six images kept**, covering three independent photographic gait-cycle
sequences (each itself a multi-frame walk cycle) plus three flat-silhouette
illustrations at different stride phases — multiple distinct
angles/subjects/renderings of a true side profile, not a single picture.

## What I did not do

Synthesize, mirror, shear, or squash a front view to pad the count. That is
the exact failure mode [T-0272](T-0272) proved impossible and correctly
declined to fake, and doing it here would poison whatever T-0274 trains on
this set. Every kept file above was fetched through
`tools/board/scripts/referenceFetch.js search|fetch` only — no raw `curl`,
no alternate host, no browser grant.

## Parked for approval

Per `requires_approval: true`, this card parks for @DennieSeth's review
before [T-0274](T-0274) trains on anything here. No approval record is
written by this card.
