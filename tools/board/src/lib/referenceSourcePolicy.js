/**
 * Policy for `tools/board/scripts/referenceFetch.js` -- the scoped web search/fetch wrapper
 * granted to designated agents (see `.claude/agents/assets.md`) in place of a raw network or
 * browsing grant (T-0276).
 *
 * Threat model: this wrapper pulls untrusted content from the open internet into an agent's
 * context and onto disk. A fetched page, search result, or asset's own metadata (title, licence
 * string, EXIF) must never be treated as an instruction -- see referenceSourcing.js, which
 * returns everything as structured data and never lets a fetched value pick the next thing to
 * fetch. This module is the narrower, mirror-of-agentCurlPolicy.js piece: it answers exactly one
 * question, "is this host allowed for this source, at this point in the flow", for every network
 * call the wrapper makes.
 *
 * Design choices that follow directly from the card:
 *  - **Sourcing is a small, in-code allowlist**, not a config file or a call-time parameter --
 *    `REFERENCE_SOURCES` below is the only way to add a source, and doing so is a deliberate,
 *    reviewed code change, not something a search result or a CLI flag can expand.
 *  - **`fetch` never accepts a raw URL from its caller.** The wrapper's `fetch` command takes a
 *    `sourceId` + a source-native asset id (a Wikimedia Commons file title, an Openverse UUID).
 *    The actual byte URL is resolved from that source's own metadata API
 *    (`assetMetadataUrl`), inside `referenceSourcing.js` -- so nothing a fetched result contains
 *    can ever be handed back in as "the next URL to fetch". Outbound links are never followed.
 *  - **Openverse's own `url` field (the original, arbitrary-origin asset location -- Flickr,
 *    museum sites, ...) is deliberately never fetched.** Only Openverse's own thumbnail proxy,
 *    served from `api.openverse.org` itself, is on that source's `fetchHosts`. This keeps
 *    Openverse's effective attack surface to one host this project actually trusts, at the cost
 *    of thumbnail-resolution images rather than full originals -- an acceptable trade for a
 *    reference, not a deliverable asset.
 *  - **Every redirect hop is re-checked against the same `fetchHosts` allowlist** and the chain
 *    is capped at `MAX_REDIRECTS`; a hop that leaves the allowlist is a rejection, not a
 *    best-effort follow (`checkRedirect`).
 *  - **https only.** A downgrade to plain http is refused even for an otherwise-allowlisted host.
 *
 * Licence verification (referenceLicense.js) and byte quarantine (referenceQuarantine.js) are
 * separate, equally load-bearing modules -- this one only decides which hosts a request may
 * reach.
 */

/** Redirect hops beyond this are refused outright, regardless of destination. */
export const MAX_REDIRECTS = 3;

function encode(value) {
  return encodeURIComponent(String(value));
}

/**
 * The complete, in-code allowlist of reference sources. Adding a source means adding an entry
 * here -- never a call-time parameter, per the card's "configured in code rather than supplied
 * at call time" requirement.
 */
export const REFERENCE_SOURCES = Object.freeze({
  wikimedia: Object.freeze({
    id: "wikimedia",
    label: "Wikimedia Commons",
    apiHost: "commons.wikimedia.org",
    fetchHosts: Object.freeze(["upload.wikimedia.org", "commons.wikimedia.org"]),
    searchUrl: (query, limit = 10) =>
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&format=json&srlimit=${encode(
        limit
      )}&srsearch=${encode(query)}`,
    assetMetadataUrl: (assetId) =>
      `https://commons.wikimedia.org/w/api.php?action=query&titles=${encode(
        assetId
      )}&prop=imageinfo&iiprop=url%7Cextmetadata&format=json`
  }),
  openverse: Object.freeze({
    id: "openverse",
    label: "Openverse",
    apiHost: "api.openverse.org",
    // Deliberately just the thumbnail proxy host -- see module docstring above.
    fetchHosts: Object.freeze(["api.openverse.org"]),
    searchUrl: (query, limit = 10) =>
      `https://api.openverse.org/v1/images/?q=${encode(query)}&page_size=${encode(limit)}`,
    assetMetadataUrl: (assetId) => `https://api.openverse.org/v1/images/${encode(assetId)}/`
  })
});

export function listSourceIds() {
  return Object.keys(REFERENCE_SOURCES);
}

/** Fail closed: an unknown id resolves to `null`, never a default source. */
export function getSource(sourceId) {
  return REFERENCE_SOURCES[sourceId] ?? null;
}

function deny(reason) {
  return { allowed: false, reason };
}

const ALLOW = Object.freeze({ allowed: true, reason: null });

function safeParseHttpsUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return parsed;
}

/** Is `url` a valid https request to `sourceId`'s own search/metadata API host? */
export function checkSearchUrl({ sourceId, url }) {
  const source = getSource(sourceId);
  if (!source) return deny(`unknown reference source "${sourceId}"`);
  const parsed = safeParseHttpsUrl(url);
  if (!parsed) return deny(`URL is not a parseable https URL: ${url}`);
  if (parsed.host !== source.apiHost) {
    return deny(`search host "${parsed.host}" is not the allowlisted host for "${sourceId}" ("${source.apiHost}")`);
  }
  return ALLOW;
}

/** Is `url` a valid https request to one of `sourceId`'s declared byte-fetch hosts? */
export function checkFetchUrl({ sourceId, url }) {
  const source = getSource(sourceId);
  if (!source) return deny(`unknown reference source "${sourceId}"`);
  const parsed = safeParseHttpsUrl(url);
  if (!parsed) return deny(`URL is not a parseable https URL: ${url}`);
  if (!source.fetchHosts.includes(parsed.host)) {
    return deny(
      `fetch host "${parsed.host}" is not on the allowlist for "${sourceId}" (${source.fetchHosts.join(", ")})`
    );
  }
  return ALLOW;
}

/**
 * Is following a redirect to `targetUrl` allowed? `hopIndex` is the zero-based index of this
 * redirect within the chain (0 for the first redirect after the initial request). Denies once
 * the chain would exceed `MAX_REDIRECTS`, and otherwise applies the exact same host allowlist as
 * the initial fetch -- a redirect gets no more trust than a first request would.
 */
export function checkRedirect({ sourceId, targetUrl, hopIndex }) {
  if (hopIndex >= MAX_REDIRECTS) {
    return deny(`redirect chain exceeded ${MAX_REDIRECTS} hops`);
  }
  return checkFetchUrl({ sourceId, url: targetUrl });
}
