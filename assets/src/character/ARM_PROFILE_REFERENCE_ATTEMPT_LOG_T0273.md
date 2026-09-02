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
