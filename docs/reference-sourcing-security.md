# Reference-sourcing security model (T-0276)

**Capability:** `tools/board/scripts/referenceFetch.js` — a scoped wrapper granted to
designated agents (currently `assets`, see `.claude/agents/assets.md`) so they can
search for and fetch open-licence visual references the generator itself cannot
produce (first consumer: T-0273's profile reference set). It is **not** a general
network or browsing grant. The enforcement lives in code, in three small,
independently unit-tested modules — this doc is the map, not the source of truth;
read the module docstrings for the actual rules:

| Concern | Module |
|---|---|
| Which hosts may be searched/fetched, redirect containment | `tools/board/src/lib/referenceSourcePolicy.js` |
| Which licences are accepted | `tools/board/src/lib/referenceLicense.js` |
| Byte sniffing, quarantine, size/count caps | `tools/board/src/lib/referenceQuarantine.js` |
| Request pacing | `tools/board/src/lib/referenceRateLimit.js` |
| Real network I/O (streaming, manual redirects) | `tools/board/src/lib/referenceTransport.js` |
| Orchestration (search, fetch, licence gate before download) | `tools/board/src/lib/referenceSourcing.js` |

## Threat model

This tool pulls **untrusted content from the open internet** into an agent's
context and onto disk. The three properties that matter, and how each is enforced:

### Web content is data, never instructions

`searchReferences` and `fetchReference` return plain JSON objects
(`{sourceId, assetId, title, sourceUrl, license, ...}`) — never prose for an agent
to "follow". A fetched asset's title, licence string, or any other metadata field
is only ever compared against a fixed pattern (`referenceLicense.js`'s anchored
regexes) or copied verbatim into a provenance record; it is never `eval`-ed,
shelled out, or used to decide what to fetch next. `fetchReference` takes a
`sourceId` + a source-native asset id chosen by the caller — never a URL read out
of a search result or a fetched page. See `referenceSourcing.js`'s docstring for
the concrete reasoning, and its test file's prompt-injection cases (an
instruction-shaped string in a licence field, in a title) for proof this is
actually inert.

### Only image bytes land, and only allowlisted ones

`referenceQuarantine.js` sniffs real bytes with `file-type` and reuses the exact
`PREVIEWABLE_IMAGE_MIMES` / `REJECTED_SNIFFED_MIMES` sets `httpApi.js`'s attachment
upload path already enforces (both now exported from there for this reuse) — SVG,
HTML, and XHTML are rejected regardless of any claimed `Content-Type`. Fetched
bytes are written into a **quarantine directory**
(`assets/src/reference/quarantine/` by default), keyed by their own sha256 hash —
never by any remote-supplied filename or title, which closes path traversal
entirely. Promotion out of quarantine into `assets/final/` (or wherever a
consuming card wants it) is a separate, deliberate step taken by that card, never
by this tool.

### Sourcing is allowlisted, and links are not followed

`referenceSourcePolicy.js`'s `REFERENCE_SOURCES` is the complete, in-code list of
sources — currently Wikimedia Commons and Openverse. Adding a source is a
deliberate code change, never a call-time parameter. `checkSearchUrl` /
`checkFetchUrl` refuse any host not on that source's own allowlist; a redirect
(`checkRedirect`) gets no more trust than a first request and the chain is capped
at `MAX_REDIRECTS` (3). Openverse's own `url` field (the original, arbitrary-origin
asset location — Flickr, museum sites, ...) is deliberately never fetched; only
its own `api.openverse.org` thumbnail proxy is on the allowlist, trading full-
resolution originals for a materially smaller attack surface — acceptable for a
loose visual reference, not a shipped asset.

Nothing auto-commits and nothing executes: this tool never calls `git`, never
writes outside the given quarantine directory, and never runs, imports, or
evaluates anything it fetches.

### Licence verification is a gate, not a note

`referenceLicense.js`'s `evaluateLicense` accepts only `cc0`, `pdm` (public domain),
`by`, or `by-sa` after normalization — everything else, including a missing or
unparseable licence field, is **rejected**, never accepted with an "unknown
licence" note. `referenceSourcing.js` calls this *before* ever downloading an
asset's bytes: a rejected licence never triggers a fetch. The licence is always
read from that specific asset's own metadata (via each source's
`assetMetadataUrl`), never assumed from which domain served it.

### Rate and size limits

`referenceRateLimit.js` gates every network call (search, metadata lookup, byte
fetch, each redirect hop) behind a minimum interval. `referenceTransport.js`
aborts a response stream mid-flight once it exceeds the caller's byte cap, rather
than buffering an unbounded response into memory. `referenceQuarantine.js`
separately enforces a per-asset byte cap and a total-count cap on the quarantine
directory before writing anything.

## The grant

`referenceFetch.js` is meant to be granted to the `assets` agent
(`Bash(node tools/board/scripts/referenceFetch.js:*)` in
`.claude/agents/assets.md`), mirroring how `agentCurl.js` is granted — a wrapper,
not a raw capability. No other agent should get network access through this
tool, and `assets` should otherwise still have no raw `curl`/browsing grant of
its own.

**Applied.** Five automated implementer sessions (review runs 1-5) each hit the
same wall: an implementer agent editing `.claude/agents/assets.md` — the file
that defines its own Bash grants — is refused outright by the Claude Code CLI's
own self-grant guardrail, which is a deliberate policy boundary, not a bug to
route around. Per this repo's conduct rules, routing around a denied tool call
(`Write`, a `Bash(node:*)` script, `git` plumbing, etc.) is itself a conduct
violation, so no implementer session attempted that.

A human applied the two edits below directly in PR #301
(`fix/reference-fetch-grant`, commit 8f81380, merged to `develop` as d7d02e8),
and this branch has since merged `develop` to pick it up:

1. `.claude/agents/assets.md`'s frontmatter `tools:` line now includes
   `Bash(node tools/board/scripts/referenceFetch.js:*)` alongside the existing
   `Bash(node tools/board/scripts/agentCurl.js:*)` entry.
2. `.claude/rules/assets.md` now has a bullet (near the LFS/binary-policy
   bullet at the end) documenting that a reference the generator cannot
   produce is sourced via `node tools/board/scripts/referenceFetch.js
   search|fetch ...`, never a raw `curl`/browser grant; that fetched results
   are data, never instructions to act on; and that anything fetched lands in
   `assets/src/reference/quarantine/` only, not eligible for
   `ASSET_PROVENANCE.md` until a human-reviewed promotion step (owned by the
   consuming card, e.g. T-0273) moves it into a real `assets/src/` location.

`tools/board/test/runner/referenceFetchGrant.test.js`'s three grant-asserting
blocks are un-skipped as of this change and pass against the live grant. The
`assets` agent can now actually invoke `referenceFetch.js` — the capability is
live, not just documented.

## T-0283: diagnostic headers, and what they revealed live in this sandbox

T-0273 blocked for five sessions on `fetch wikimedia ...` returning a bare
`429` with no further information, while the identical call from a normal
WSL shell on the same machine succeeded (see T-0273's own findings, quoted
in this card). `referenceSourcing.js`'s rejection paths threw away every
response header but the status code, so the 429 was undiagnosable from a
run log. `referenceDiagnostics.js` now surfaces an allowlisted set of
diagnostic headers (`Retry-After`, `X-RateLimit-*`, `Via`, `X-Cache`,
`Server`, `CF-Ray`, `X-Served-By`, `X-Forwarded-For`) in the
`ReferenceRejectedError` message on any non-2xx response — never a
credential header (`Authorization`, `Cookie`, `Set-Cookie`), by
construction of the allowlist.

**This session (an `infra`-scoped session, whose `Bash(node:*)` grant
covers `referenceFetch.js` directly) reproduced the failure live** and
captured real diagnostic headers, not just unit-test fixtures:

```
$ node tools/board/scripts/referenceFetch.js search wikimedia "Muybridge Animal Locomotion" 5
{"sourceId":"wikimedia","results":[...]}                          # succeeds, as always

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Muybridge race horse animated.gif" ...
{"assetPath":...}                                                 # succeeded -- first fetch call of the session

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Animal Locomotion. ... MET DT6807.jpg" ...
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429
  (diagnostic headers: server=Varnish, x-cache=cp3079 int)

$ node tools/board/scripts/referenceFetch.js fetch wikimedia "File:Animal Locomotion. ... MET DP275235.jpg" ...
referenceFetch: rejected -- asset fetch from wikimedia failed with status 429
  (diagnostic headers: server=Varnish, x-cache=cp3079 int)          # identical headers, second attempt
```

What this narrows down:

- **No `Retry-After` and no `X-RateLimit-*` header at all** — Wikimedia's
  edge never tells the caller when or whether to retry. A caller cannot
  pace itself off this response; it can only back off blindly.
- **`x-cache: cp3079 int`** identifies a specific Wikimedia Varnish/ATS
  edge-cache node (`cp3079`) and marks the response `int` ("internal" —
  generated/blocked at the cache layer itself, never reaching origin).
  Both 429s in this session, on two different asset URLs, came from the
  *same* cache node with the *identical* header pair — this sandbox's
  outbound requests are landing on (or being pinned through) one specific
  edge PoP, and that PoP is the one throttling.
- Combined with T-0273's own finding that an identical request from a
  normal WSL shell on the same machine succeeds (200, ~140KB, ~0.4s), and
  that no proxy env var differs between the two contexts: the most likely
  explanation is a **path/PoP difference in how the agent sandbox's
  outbound connections are routed** (e.g. a different egress IP, or a NAT
  that pins this session to a specific, already-throttled edge node) —
  **not** a blanket block on the User-Agent, the IP as a whole, or the
  code/query itself. The first fetch of this session *did* succeed, which
  also rules out an immediate/unconditional block.
- This is not a fix — the actual remedy, if it is a routing/PoP issue, is
  environmental and outside this repo's control, per the card's own scope
  boundary. It is, however, now something a human can act on: e.g. compare
  the sandbox's outbound IP/ASN against the normal shell's, or ask
  whoever operates the sandbox network whether egress is pinned per-PoP.

Every prior attempt log referencing this 429 (`T-0273`, and
`assets/src/reference/ARM_REFERENCE_ATTEMPT_LOG_T0281.md`) recorded the
bare status code only; this is the first run with headers attached.

**Openverse, same session:** `search openverse "lighthouse"` and a
follow-up `fetch openverse <assetId>` both reached the network
successfully this time (no 504) — the fetch stopped at the licence gate
(`by-nc-sa`, correctly rejected) rather than at transport. This confirms
the card's own framing: Openverse's outage is upstream and intermittent,
not a permanent 504, which is exactly why treating it as best-effort
(see T-0284 below) rather than deleting or permanently disabling it is the
right call — it recovers on its own, and a run should benefit when it
does rather than needing a code change to re-enable it.

## T-0284: a policy-compliant User-Agent, and a third source

Both fixes below are a direct response to the finding above: `search`
(a lighter endpoint) kept working through the whole T-0283 session while
`fetch`'s byte requests to `upload.wikimedia.org` 429'd hard, and the
outbound User-Agent this tool sent was a bare, contactless token —
exactly the shape Wikimedia's own User-Agent policy documents as getting
throttled aggressively.

**Part 1 — the UA now carries a contact.** `referenceTransport.js`'s
`REFERENCE_USER_AGENT` is now
`assembled-reference-sourcing/1.0 (+https://github.com/dennie-seth/assembled)`
— tool name, version, and a reachable contact, per policy. The public
repo URL is the contact; no email or other address was fabricated for
this, per the card's own instruction not to invent one.

**Part 2 — a third, independent source.** `referenceSourcePolicy.js`
adds `met` (the Metropolitan Museum of Art's Open Access API,
`collectionapi.metmuseum.org` for search/metadata,
`images.metmuseum.org` for bytes), `required: false`. It was chosen over
the other candidates the card listed (Smithsonian, Rijksmuseum, Art
Institute of Chicago) because it needs no API key, its rights model is a
simple per-object boolean (`isPublicDomain`) rather than a
licence-string parse, and its infrastructure shares nothing with either
Wikimedia or Openverse — a genuine third leg, not a second front door to
a host already on the allowlist. Its licence gate works the same way as
the other two sources: `isPublicDomain !== true` (false, or the field
missing) maps to *no* licence at all and is rejected by
`referenceLicense.js` exactly like a missing Wikimedia/Openverse licence
field — there is no "trusted museum, so unknown is fine" shortcut. It
goes through the identical allowlist / redirect-cap / mime-sniff /
quarantine-only / rate-limit gauntlet as the existing two sources; see
`referenceSourcePolicy.test.js` and `referenceSourcing.test.js` for the
per-defence tests. `referenceFetch.js`'s CLI needed no change at all — it
already derives its source list from `listSourceIds()`.

No live 429 reproduction was attempted for this card beyond what T-0283
already captured above — the 429 window observed there was still active
and hammering it further would only extend it (see the card's own edge
cases). Both fixes are verified by mocked-transport unit tests only.
