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

## Provenance chain

[T-0281](T-0281) ran the actual `referenceFetch.js search` / `fetch` calls
for this pose (among three others) and attached its results to this card:
one kept image (`b1006b0a7269...jpg`) plus a per-pose summary
(`T-0281-profile-summary.md`, also attached to this card). This card
(T-0273) is the human-reviewed promotion step named in
`.claude/rules/assets.md`'s reference-sourcing bullet: it reviews, curates,
and promotes the candidate out of the (now-gone) quarantine directory into
a committed `assets/src/concept/` location with its own provenance record.

## Candidates: fetched 2, kept 1

| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |
|---|---|---|---|---|---|
| `b1006b0a72...` | Silhouette walking man png illustration | openverse | cc0 | 2026-09-01T17:16:17.577Z | **KEPT** |
| `fc7fbd13ce...` | Man walking in silhouette | openverse | by | 2026-09-01T17:16:15.750Z | REJECTED — small, distant, back/three-quarter facing figure; does not read as a true side profile at any legible scale |

I re-opened the kept image before promoting it and re-checked it against the
card's own edge case ("a 'profile' that is actually three-quarter is not a
profile" — [T-0259](T-0259)): it is a clean, unambiguous, mid-stride side-on
silhouette — head, torso lean, both arms and legs read as a true 90°
profile, not a three-quarter angle. Character-likeness was correctly not a
factor in either direction (per the card's own instruction) — this is
anonymous pose/form reference, not a costume match; [T-0209](T-0209)
remains the identity authority.

## Coverage — disclosed shortfall, not papered over

**This set is one image.** The card's acceptance criteria ask for "enough
coverage to be useful for training — multiple images/angles around the
profile, not a single picture." This pass does not clear that bar, and I am
not overstating it as if it did. What happened:

- T-0281's own pass tried four additional openverse queries and one
  wikimedia query for profile-pose material and came back empty (documented
  in `T-0281-profile-summary.md`, "Also attempted, not obtainable this
  pass").
- This card (T-0273) then spent roughly 25 minutes making further attempts
  to supplement the set — three promising Muybridge "Animal Locomotion"
  plates were located via `wikimedia search` (true side-view / side-and-rear
  multi-frame walk-cycle photographs, clearly public domain, exactly the
  kind of additional side-profile gait coverage this card needs) but every
  `wikimedia fetch` of them failed with a persistent HTTP 429, and every
  `openverse search` retried in parallel failed with HTTP 504. See
  `../character/ARM_PROFILE_REFERENCE_ATTEMPT_LOG_T0273.md` for the full,
  timestamped attempt log — both sources were still down as of this card's
  last retry.
- This mirrors a pattern [T-0281](T-0281)'s own attempt log already
  recorded: Wikimedia's `upload.wikimedia.org` binary-fetch path is far more
  rate-limit-prone than its search API, "not a single Wikimedia binary fetch
  succeeded" in that session either.

**What I did not do:** synthesize, mirror, shear, or squash a front view to
pad the count. That is the exact failure mode [T-0272](T-0272) proved
impossible and correctly declined to fake, and doing it here would poison
whatever T-0274 trains on this set.

## Re-verified fresh 2026-09-02T11:07Z — outage confirmed still live, third session

Per the card's "RE-FETCH FRESH" amendment, this pass did not curate from
T-0281's leftovers — it re-ran `referenceFetch.js` live against both
`wikimedia` and `openverse` before touching anything already committed.
Both endpoints reproduced the identical 429 (`upload.wikimedia.org` fetch)
/ 504 (Openverse search) failures the two prior VALIDATION runs already
recorded, across five newly-tried Wikimedia assets and three newly-tried
Openverse queries — see
`../character/ARM_PROFILE_REFERENCE_ATTEMPT_LOG_T0273.md`'s
"2026-09-02T11:07Z re-verification" section for the exact commands and
errors. No new image could be fetched or recovered as a result; the set
below is unchanged from the prior run.

This is now the third independent session (T-0281, two prior T-0273 runs,
this one) to hit the exact same pair of failures across more than 24 hours
of wall-clock time. The attempt log flags a hypothesis worth a human
checking directly: two unrelated third-party services failing identically
for over a day is less likely than this sandbox's own egress not reaching
(or being throttled ahead of) these two specific hosts — something this
agent's tooling (`referenceFetch.js` only reports the HTTP status it
receives) cannot distinguish from the outside.

## Re-verified fresh 2026-09-02 (fourth session) — root cause narrowed, still blocked

A fourth live session re-ran both `search wikimedia` (still works) and
`fetch wikimedia`/`search openverse` (still 429 / 504 respectively),
including fetching three *new* Wikimedia assets across two file extensions
to test whether the 429 was per-asset — it isn't; every asset and every
extension fails identically. That, plus VALIDATION run 3's finding that
`referenceTransport.js:41` sends a bare, contact-less User-Agent (which
Wikimedia's UA policy is known to reject on `upload.wikimedia.org`), points
at a specific, fixable bug in T-0276's transport code rather than a
continuing external outage. See the attempt log's "fourth session" section
for the full evidence and commands.

That fix is outside this card's `assets/**` path scope and this agent's
grant — it belongs to a follow-up card against T-0276. No new image was
fetched or recovered this session; the committed set is still the single
image below.

## Recommendation for @DennieSeth's approval decision

Five options, not a recommendation to pick one over the other:

1. **Approve this single-image set as a seed**, with T-0274 (or a follow-up
   sourcing pass once Wikimedia/Openverse recover) expected to supplement it
   before or during training.
2. **Hold approval** and re-run sourcing once the two source APIs are
   healthy again — the Muybridge plates identified in the attempt log are a
   strong, already-located lead (public-domain, multi-frame, genuine side
   profile) that could not be fetched only because of the outage, not
   because they don't exist or aren't licensed cleanly.
3. **Reject and request a different sourcing strategy** if a single image is
   not an acceptable seed at any coverage level.
4. **File a follow-up card against T-0276** to give
   `referenceTransport.js`'s fetch path a compliant, contact-bearing
   User-Agent (see the attempt log's fourth-session section) — the most
   likely actual fix, based on this session's asset/extension-independent
   429 evidence.
5. **Check whether this is actually a sandbox egress restriction** rather
   than a genuine outage or UA-policy rejection — if so, no amount of
   further agent retries against `referenceFetch.js` will succeed until
   that's addressed, regardless of which of options 1–4 is also chosen.

This card parks for approval either way per `requires_approval: true` — no
approval record is written by this card regardless of which of the above
@DennieSeth picks.
