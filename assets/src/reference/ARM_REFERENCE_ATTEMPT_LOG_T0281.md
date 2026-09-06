# T-0281 attempt log — reference sourcing for profile/sitting/hide/action

This is not a full blocker (all four poses were sourced to some degree — see
the per-pose summaries alongside this file), but one recurring issue is worth
recording per `.claude/rules/assets.md`'s "a blocked generation/fetch must be
written down before the run ends" rule.

## Wikimedia binary fetch: persistent HTTP 429

`node tools/board/scripts/referenceFetch.js search wikimedia ...` worked
throughout the session — `commons.wikimedia.org`'s search API never failed.

`node tools/board/scripts/referenceFetch.js fetch wikimedia <assetId>`
failed with HTTP 429 on every attempt after the first couple of calls,
across roughly 15 minutes of the session with other (Openverse) work
interleaved in between attempts:

```
$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Benjamin Robert Haydon - Figure Study of Women in Various Sitting and Standing Poses - B1977.14.2577 - Yale Center for British Art.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429
(retried 3x over several minutes, same result each time)

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Michelangelo-Buonarroti-Crouching Boy-3-Hermitage.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429
(retried 3x over the session, same result each time, including one retry after
~15 minutes of unrelated Openverse work)

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Michelangelo-Buonarroti-Crouching Boy-5-Hermitage.jpg"
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429
```

Not a single Wikimedia binary fetch succeeded this session — every kept image
in the four attached candidate sets came from `openverse` (which, for the
Michelangelo pieces, serves the same Commons-hosted photographs through its
own `api.openverse.org` thumbnail proxy — see the hide summary). Per the
card's own edge case ("rate limits are paced, not fatal ... a slow batch is
expected, not an error to route around"), this was treated as pacing, not
routed around with any other mechanism (no raw `curl`, no alternate host) —
just deprioritized in favor of Openverse once the pattern was clear.

**Left for whoever revisits Wikimedia fetching:** `upload.wikimedia.org`'s
per-caller-or-per-project rate limit appears considerably stricter than
`commons.wikimedia.org`'s search API, at least under whatever load this
session's IP/UA was already carrying. A future session spacing fetches over a
longer wall-clock window, or fetching earlier in a session before other
network activity, may fare better.

## Openverse: transient HTTP 424s, not license-related

A handful of `fetch openverse` calls failed with HTTP 424 rather than a
license rejection — the source asset simply couldn't be retrieved through
Openverse's own thumbnail proxy at that moment (`assetId`s
`1c994e27-45a4-4fe8-a8c8-451983e6c277` — "The Dutch Reach" door-opening
diagram, retried 3x, and `4cc2e911-40a7-4b6f-93cd-bb0224e85eff` — a seated
profile photograph, retried 2x). Neither ever succeeded; both are noted in
the relevant per-pose summary (`T-0281-profile-summary.md`,
`T-0281-action-summary.md`) as attempted-but-unobtainable rather than
silently dropped from the candidate count.

## Outcome

All four poses have at least one kept, licence-verified candidate attached to
their own card (T-0273, T-0278, T-0279, T-0280) with a per-pose summary. See
those summaries for exactly what's missing and why (most notably: `touch`
is thinly sourced, and hide's crouch-*descent* motion was not found under an
acceptable licence this pass).
