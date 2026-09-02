# T-0273 attempt log — supplementing the profile reference set

[T-0281](T-0281) attached one kept candidate for the profile pose
(`b1006b0a72...jpg`, openverse, cc0) to this card. The card's acceptance
criteria call for "multiple images/angles around the profile, not a single
picture," so this session tried to supplement that one image via
`tools/board/scripts/referenceFetch.js` (the only sourcing surface this
agent has — no raw `curl`, no browser grant) before promoting and curating
the final set.

## Wikimedia: search works, fetch does not (persistent HTTP 429)

`referenceFetch.js search wikimedia ...` succeeded on every call and
surfaced strong candidates — three Eadweard Muybridge "Animal Locomotion"
plates, all clearly multi-frame, true side-on (or side-and-rear) walking
gait studies, 1887, public domain:

- `File:Animal Locomotion - side view of old man walking (pl. 555) LCCN2005697037.jpg`
- `File:Animal Locomotion - side and rear views of man walking (pl. 546) LCCN2005697038.jpg`
- `File:Animal Locomotion - side and rear views of man walking with cane (pl. 552) LCCN2005697040.jpg`

Every `referenceFetch.js fetch wikimedia <assetId>` call for these failed
identically:

```
$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Animal Locomotion - side view of old man walking (pl. 555) LCCN2005697037.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429
```

Retried on `pl. 555` **8 times** and on `pl. 546` **once**, spaced across
roughly 25 minutes of wall-clock time (individual gaps of 15s, 20s, 20s,
30s, 60s, 60s, 90s, 150s, 180s, 200s — increasing backoff, not a tight
retry loop), with unrelated openverse search attempts and file-writing work
interleaved. Every attempt returned the same HTTP 429. Not a single
Wikimedia binary fetch succeeded in this session.

This matches [T-0281](T-0281)'s own attempt log
(`ARM_REFERENCE_ATTEMPT_LOG_T0281.md`, attached to T-0281): "Not a single
Wikimedia binary fetch succeeded this session ... `upload.wikimedia.org`'s
per-caller-or-per-project rate limit appears considerably stricter than
`commons.wikimedia.org`'s search API." This session's evidence confirms that
finding was not a one-off — the same asymmetry (search fine, fetch
423/429) reproduced a full day later against different asset IDs.

## Openverse: persistent HTTP 504 on search itself

Unlike T-0281's session (which saw occasional 424s on `fetch` but a working
`search`), this session's `referenceFetch.js search openverse ...` failed
outright on every call:

```
$ node tools/board/scripts/referenceFetch.js search openverse "man standing profile silhouette" 10
referenceFetch: rejected -- search request to openverse failed with status 504
```

Retried **7 times** with different queries ("man standing profile
silhouette", "silhouette walking", "man profile walk", "silhouette walking
man illustration", "man standing side profile", ×2 repeats), spaced across
the same ~25-minute window. Every attempt returned HTTP 504 (gateway
timeout) — Openverse's own backend, not a licence or content rejection.
Since `search` never returned results, no further `fetch` calls against
Openverse were possible this session (there was no assetId to fetch).

## What was not done

- No raw `curl`, no alternate host, no browser grant — the two
  `referenceFetch.js` subcommands are the entire surface, per
  `.claude/rules/assets.md`, and every failure above is that wrapper's own
  passthrough of the upstream HTTP status. A 429/504 is the correct outcome
  to record, not route around.
- No mirrored/sheared/squashed front view substituted to pad the set — see
  the "Still forbidden: generating them" section of the card body and
  [T-0272](T-0272)'s finding that this specific failure mode poisons
  anything trained on it.
- No fake or placeholder file written in place of the unfetched Muybridge
  plates.

## Outcome

The final curated set for this card is the single already-attached,
already-vetted openverse image. The Muybridge plates above are a concrete,
already-identified lead for whoever revisits sourcing once Wikimedia's
`upload.wikimedia.org` and Openverse's search backend are healthy — their
asset IDs are recorded above so a future session does not have to redo the
`search` step. See `../concept/player_profile_reference_SUMMARY.md` for the
full curation writeup and the disclosed coverage shortfall.

## 2026-09-02T11:07Z re-verification — outage persists, both endpoints, third session

This is a fresh (not cached, not re-narrated) re-verification session, run per
the reviewer's "re-fetch fresh" instruction and the 2026-09-02T11:00Z card
comment. Six independent live calls, spread across the two endpoints, all
reproduce the identical signature the two prior VALIDATION runs already
recorded:

```
$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Animal Locomotion - side view of old man walking (pl. 555) LCCN2005697037.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:A naked man walking. Collotype after Muybridge, 1887. Wellcome L0075728.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Animal Locomotion - side and rear views of man walking (pl. 546) LCCN2005697038.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:A naked man walking. Collotype after Muybridge, 1887. Wellcome L0075726.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Animal locomotion. Plate 470 - DPLA - ff7a3fecd28d7f97f340abcbdb1af1c6.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429

$ node tools/board/scripts/referenceFetch.js search openverse "man walking side profile silhouette" 20
referenceFetch: rejected -- search request to openverse failed with status 504

$ node tools/board/scripts/referenceFetch.js search openverse "silhouette man side profile" 15
referenceFetch: rejected -- search request to openverse failed with status 504

$ node tools/board/scripts/referenceFetch.js search openverse "walking man" 5
referenceFetch: rejected -- search request to openverse failed with status 504
```

`referenceFetch.js search wikimedia` itself still works fine (confirmed
again this session — it is only `upload.wikimedia.org`'s byte-fetch path
that 429s) and surfaced five new, previously-unlisted Muybridge/Wellcome
plates beyond the three already logged above, all genuinely side-on or
side-and-rear multi-frame walking-gait studies, all 1887/public-domain by
title. They are not listed individually here because none of them could
actually be fetched either — the blocker is identical regardless of which
specific asset is requested.

**Observation worth escalating, not just re-stating:** this is the third
independent session (T-0281 on 2026-09-01, this card's first two VALIDATION
runs, and now this one) to hit the *exact same pair* of failures —
`upload.wikimedia.org` 429 and Openverse search 504 — spanning more than 24
hours of wall-clock time, across two unrelated third-party services, with
every fetch attempt failing regardless of which specific asset or query is
used. Two independent public services coincidentally being down in the same
way for over a day is a much less likely explanation than this sandbox's own
network egress not actually reaching (or being rate-limited ahead of) these
two specific hosts. This agent has no tooling to distinguish "real upstream
outage" from "this environment's egress is blocked/throttled for these
hosts" — `referenceFetch.js` is the entire network surface available, and it
only reports the HTTP status it receives, not where in the path the failure
originates. Flagging this explicitly so a human with visibility into the
sandbox's network policy can check that distinction before a fourth retry
reproduces the same result for the same underlying reason.

No new image was fetched this session as a result. Nothing was mirrored,
synthesized, or substituted to force progress. The committed set is
unchanged from the prior run: still the single already-promoted openverse
image, still missing its exact `sourceUrl`/`assetId` for the reason recorded
in its provenance JSON (Openverse search — the only way to recover them — is
itself down).
