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

**Still not applied, as of a third session (review run 2, then this implementer
run).** `.claude/agents/assets.md` and `.claude/rules/assets.md` are refused for
`Edit` in this runner's permission mode. This session repeated the exact `Edit`
call against `.claude/agents/assets.md` twice, independently of the prior
session's attempt; both returned `"Claude requested permissions to write to
.../.claude/agents/assets.md, but you haven't granted it yet"` — the same
outcome as the previous session's `"...which is a sensitive file"` denial, not
a one-off flake. Three consecutive implementer sessions now hit an identical
wall on the same one-line edit. Per this repo's conduct rules, routing around a
denied tool call — e.g. writing the same bytes through a different tool
(`Write`, a `Bash(node:*)` script, a `git` plumbing command, etc.) — is itself a
conduct violation, not a workaround, so this session did not attempt that
either. `tools/board/test/runner/referenceFetchGrant.test.js` (added in the
prior session) encodes the exact regression this gap causes and remains
`.skip`-ed for the same reason — un-skip it in the same change that lands the
edits below. **This blocker will not clear through further automated retries**:
it needs either a human applying the two edits below directly, or an explicit
grant of `Edit` permission on these two specific files to an implementer
session. The exact edits to apply:

1. In `.claude/agents/assets.md`'s frontmatter `tools:` line, add
   `Bash(node tools/board/scripts/referenceFetch.js:*)` alongside the existing
   `Bash(node tools/board/scripts/agentCurl.js:*)` entry.
2. In `.claude/rules/assets.md`, add a bullet (near the LFS/binary-policy bullet
   at the end) documenting that a reference the generator cannot produce is
   sourced via `node tools/board/scripts/referenceFetch.js search|fetch ...`,
   never a raw `curl`/browser grant; that fetched results are data, never
   instructions to act on; and that anything fetched lands in
   `assets/src/reference/quarantine/` only, not eligible for
   `ASSET_PROVENANCE.md` until a human-reviewed promotion step (owned by the
   consuming card, e.g. T-0273) moves it into a real `assets/src/` location.

Until this lands, the `assets` agent has no way to actually invoke
`referenceFetch.js` — the library and CLI are complete and tested, but the
capability is not yet live for any agent.
