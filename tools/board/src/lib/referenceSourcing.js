/**
 * Orchestrates search + fetch for the reference-sourcing wrapper (T-0276), tying together
 * referenceSourcePolicy.js (host allowlist), referenceLicense.js (fail-closed licence gate), and
 * referenceQuarantine.js (mime-sniffed, size/count-capped quarantine writes).
 *
 * Untrusted-content handling, concretely:
 *  - `searchReferences` returns a plain `{sourceId, results: [{sourceId, assetId, title}]}` --
 *    structured data only. Nothing in a result is ever interpreted as an instruction, and no
 *    field from a result is used to build the next request without the caller's own decision:
 *    `fetchReference` takes a `sourceId` + `assetId` chosen by the caller, not a URL scraped from
 *    a result.
 *  - `fetchReference` resolves the actual byte URL itself, from the source's own metadata API,
 *    and evaluates that same metadata's licence field *before* ever downloading bytes -- a
 *    rejected licence never triggers a fetch. This is also why the licence check happens here and
 *    not only in referenceLicense.js: the metadata that carries the licence is itself fetched
 *    content, so extracting it is this module's job, evaluating it fail-closed is
 *    referenceLicense.js's.
 *  - Every redirect the underlying transport reports is re-validated against the same host
 *    allowlist as the initial request, and the chain is capped -- see referenceSourcePolicy.js's
 *    `checkRedirect`. A redirect is never auto-followed by the transport itself.
 *  - A rate limiter (referenceRateLimit.js) gates every network call this module makes, search
 *    and fetch and every redirect hop alike, when the caller supplies one.
 */

import {
  getSource,
  checkSearchUrl,
  checkFetchUrl,
  checkRedirect,
  isSourceRequired,
  listSourceIds,
  MAX_REDIRECTS
} from "./referenceSourcePolicy.js";
import { evaluateLicense } from "./referenceLicense.js";
import { sniffImageBytes, quarantineAsset, maxAssetBytesFromEnv, maxAssetsPerRunFromEnv, ReferenceRejectedError } from "./referenceQuarantine.js";
import { defaultTransport } from "./referenceTransport.js";
import { formatDiagnosticHeaders } from "./referenceDiagnostics.js";

/** Appends `" (diagnostic headers: ...)"` to a non-2xx failure message when any are present. */
function describeFailure(message, headers) {
  const diagnostics = formatDiagnosticHeaders(headers);
  return diagnostics ? `${message} (diagnostic headers: ${diagnostics})` : message;
}

function parseJsonBody(res, context) {
  if (res.status !== 200) {
    throw new ReferenceRejectedError(describeFailure(`${context} failed with status ${res.status}`, res.headers));
  }
  try {
    return JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new ReferenceRejectedError(`${context} did not return valid JSON`);
  }
}

/**
 * Maps one source's raw search-response JSON to the wrapper's plain result shape. `limit` is only
 * used for `met`: unlike wikimedia's `srlimit`/openverse's `page_size`, the Met's own search
 * endpoint has no result-count parameter and always returns every matching objectID.
 */
function parseSearchResults(sourceId, json, limit) {
  if (sourceId === "wikimedia") {
    const hits = Array.isArray(json?.query?.search) ? json.query.search : [];
    return hits.map((hit) => ({ sourceId, assetId: String(hit.title), title: String(hit.title) }));
  }
  if (sourceId === "openverse") {
    const hits = Array.isArray(json?.results) ? json.results : [];
    return hits.map((hit) => ({ sourceId, assetId: String(hit.id), title: hit.title != null ? String(hit.title) : null }));
  }
  if (sourceId === "met") {
    const hits = Array.isArray(json?.objectIDs) ? json.objectIDs : [];
    return hits.slice(0, limit).map((objectId) => ({ sourceId, assetId: String(objectId), title: null }));
  }
  return [];
}

/**
 * Extracts { rawLicense, url, title } from one source's per-asset metadata response. `url` is
 * always drawn from a field this source's own `fetchHosts` allowlist covers -- for Openverse this
 * is deliberately the `thumbnail` field (served from api.openverse.org itself), never the
 * arbitrary-origin `url` field the API also returns. See referenceSourcePolicy.js's docstring.
 */
function extractAssetMetadata(sourceId, json, assetId) {
  if (sourceId === "wikimedia") {
    const pages = json?.query?.pages ?? {};
    const page = Object.values(pages)[0];
    const info = page?.imageinfo?.[0];
    if (!info) return { rawLicense: null, url: null, title: assetId };
    const rawLicense = info.extmetadata?.LicenseShortName?.value ?? info.extmetadata?.UsageTerms?.value ?? null;
    return { rawLicense, url: info.url ?? null, title: page?.title ?? assetId };
  }
  if (sourceId === "openverse") {
    return { rawLicense: json?.license ?? null, url: json?.thumbnail ?? null, title: json?.title ?? assetId };
  }
  if (sourceId === "met") {
    // The Met has no per-asset licence *string* -- `isPublicDomain` is the per-object rights
    // signal its API actually publishes. `true` is mapped to a "Public Domain" label that
    // referenceLicense.js's own normalizer already recognizes (the same "pdm" bucket as an
    // explicit Public Domain Mark elsewhere); anything else (false, missing) becomes `null`, which
    // evaluateLicense fails closed on exactly like a missing Wikimedia/Openverse licence field --
    // never "accepted because the source is a trusted museum".
    const rawLicense = json?.isPublicDomain === true ? "Public Domain" : null;
    const url = typeof json?.primaryImage === "string" && json.primaryImage.length > 0 ? json.primaryImage : null;
    return { rawLicense, url, title: json?.title ?? assetId };
  }
  return { rawLicense: null, url: null, title: assetId };
}

/**
 * @param {object} args
 * @param {string} args.sourceId
 * @param {string} args.query
 * @param {number} [args.limit]
 * @param {(url: string) => Promise<{status:number, headers:object, body:Buffer}>} [args.transport]
 * @param {{take: () => void}} [args.rateLimiter]
 * @returns {Promise<{sourceId: string, results: Array<{sourceId:string, assetId:string, title:string|null}>}>}
 */
export async function searchReferences({ sourceId, query, limit = 10, transport = defaultTransport, rateLimiter }) {
  const source = getSource(sourceId);
  if (!source) {
    throw new ReferenceRejectedError(`unknown reference source "${sourceId}"`);
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ReferenceRejectedError("search query must be a non-empty string");
  }

  const url = source.searchUrl(query, limit);
  const verdict = checkSearchUrl({ sourceId, url });
  if (!verdict.allowed) {
    throw new ReferenceRejectedError(verdict.reason);
  }

  await rateLimiter?.take();
  const res = await transport(url);
  const json = parseJsonBody(res, `search request to ${sourceId}`);
  return { sourceId, results: parseSearchResults(sourceId, json, limit) };
}

/**
 * Searches every given source for `query` and merges their results, treating a required
 * source's failure as fatal (propagates) and a best-effort source's failure as recorded, not
 * fatal (T-0283) -- see `referenceSourcePolicy.js`'s `required` flag, the single place this
 * "must have" vs "nice to have" distinction is decided so every caller inherits it. Openverse
 * being down is exactly the case this exists for: Wikimedia alone can meet the multi-image bar,
 * so a caller building a reference set no longer needs to treat "both sources returned results"
 * as a precondition for success.
 *
 * @param {object} args
 * @param {string[]} [args.sourceIds] defaults to every allowlisted source
 * @param {string} args.query
 * @param {number} [args.limit]
 * @param {(url: string) => Promise<{status:number, headers:object, body:Buffer}>} [args.transport]
 * @param {{take: () => void}} [args.rateLimiter]
 * @returns {Promise<{results: Array<{sourceId:string, assetId:string, title:string|null}>, failures: Array<{sourceId:string, reason:string}>}>}
 */
export async function searchAcrossSources({ sourceIds = listSourceIds(), query, limit = 10, transport = defaultTransport, rateLimiter }) {
  const results = [];
  const failures = [];
  for (const sourceId of sourceIds) {
    try {
      const { results: sourceResults } = await searchReferences({ sourceId, query, limit, transport, rateLimiter });
      results.push(...sourceResults);
    } catch (err) {
      if (isSourceRequired(sourceId)) {
        throw err;
      }
      failures.push({ sourceId, reason: err.message });
    }
  }
  return { results, failures };
}

/**
 * @param {object} args
 * @param {string} args.sourceId
 * @param {string} args.assetId source-native id (a Wikimedia Commons file title, an Openverse UUID)
 * @param {string} args.quarantineDir
 * @param {(url: string, opts?: object) => Promise<{status:number, headers:object, body:Buffer}>} [args.transport]
 * @param {{take: () => void}} [args.rateLimiter]
 * @param {number} [args.maxBytes]
 * @param {number} [args.maxCount]
 */
export async function fetchReference({
  sourceId,
  assetId,
  quarantineDir,
  transport = defaultTransport,
  rateLimiter,
  maxBytes = maxAssetBytesFromEnv(),
  maxCount = maxAssetsPerRunFromEnv()
}) {
  const source = getSource(sourceId);
  if (!source) {
    throw new ReferenceRejectedError(`unknown reference source "${sourceId}"`);
  }
  if (typeof assetId !== "string" || assetId.trim().length === 0) {
    throw new ReferenceRejectedError("assetId must be a non-empty string");
  }

  const metadataUrl = source.assetMetadataUrl(assetId);
  const metadataVerdict = checkSearchUrl({ sourceId, url: metadataUrl });
  if (!metadataVerdict.allowed) {
    throw new ReferenceRejectedError(metadataVerdict.reason);
  }
  await rateLimiter?.take();
  const metadataRes = await transport(metadataUrl);
  const metadataJson = parseJsonBody(metadataRes, `metadata request to ${sourceId}`);
  const { rawLicense, url: assetUrl, title } = extractAssetMetadata(sourceId, metadataJson, assetId);

  // Licence gate BEFORE any byte fetch: fail closed, and cheaper for a source that turns out to
  // be non-free -- no bytes are ever requested for a rejected asset.
  const licenseVerdict = evaluateLicense(rawLicense);
  if (!licenseVerdict.accepted) {
    throw new ReferenceRejectedError(`rejected: ${licenseVerdict.reason}`);
  }
  if (typeof assetUrl !== "string" || assetUrl.length === 0) {
    throw new ReferenceRejectedError("source metadata did not include a resolvable, allowlisted asset URL");
  }

  let currentUrl = assetUrl;
  let bytesRes;
  for (let hop = 0; ; hop += 1) {
    const fetchVerdict =
      hop === 0 ? checkFetchUrl({ sourceId, url: currentUrl }) : checkRedirect({ sourceId, targetUrl: currentUrl, hopIndex: hop - 1 });
    if (!fetchVerdict.allowed) {
      throw new ReferenceRejectedError(fetchVerdict.reason);
    }

    await rateLimiter?.take();
    bytesRes = await transport(currentUrl, { maxBytes });

    if (bytesRes.status >= 300 && bytesRes.status < 400) {
      const location = bytesRes.headers?.location;
      if (!location) {
        throw new ReferenceRejectedError(`redirect from ${sourceId} had no Location header`);
      }
      if (hop >= MAX_REDIRECTS) {
        throw new ReferenceRejectedError(`redirect chain exceeded ${MAX_REDIRECTS} hops`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }

  if (bytesRes.status !== 200) {
    throw new ReferenceRejectedError(
      describeFailure(`asset fetch from ${sourceId} failed with status ${bytesRes.status}`, bytesRes.headers)
    );
  }

  const mime = await sniffImageBytes(bytesRes.body);

  const provenance = {
    sourceId,
    assetId,
    title,
    sourceUrl: currentUrl,
    license: rawLicense,
    licenseNormalized: licenseVerdict.normalized,
    retrievedAt: new Date().toISOString()
  };

  return quarantineAsset({ quarantineDir, buffer: bytesRes.body, mime, provenance, maxBytes, maxCount });
}
