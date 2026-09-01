#!/usr/bin/env node
/**
 * Scoped web search/fetch wrapper for open-source visual references (T-0276) -- the capability
 * granted to designated agents (see `.claude/agents/assets.md`) in place of a raw network or
 * browsing grant. Mirrors `tools/board/scripts/agentCurl.js`'s shape: agents get a wrapper with a
 * fixed, narrow surface, not a raw capability, because the Claude Code `--allowedTools` grammar
 * (a command-prefix match) cannot express "any request, but only to these hosts".
 *
 * Only two things are possible -- nothing else is exposed by this CLI:
 *
 *   node tools/board/scripts/referenceFetch.js search <sourceId> <query> [limit]
 *   node tools/board/scripts/referenceFetch.js fetch  <sourceId> <assetId> [quarantineDir]
 *
 * `sourceId` must be one of the sources hard-coded in `src/lib/referenceSourcePolicy.js`.
 * `fetch` never takes a raw URL -- only a source-native asset id (a Wikimedia Commons file
 * title, an Openverse UUID) resolved from a prior `search` call's structured output. This is
 * deliberate: it is what makes "never follow outbound links" true at the CLI surface, not just
 * inside the library -- there is no argv shape that means "fetch this arbitrary URL a page told
 * you about". See `docs/reference-sourcing-security.md` for the full threat model, and
 * `src/lib/referenceSourcePolicy.js` / `src/lib/referenceLicense.js` for the enforcement this
 * wrapper delegates to.
 *
 * Both commands print a single JSON object to stdout -- structured data only, never prose for
 * the caller to "follow". Exit codes: 0 success, 2 rejected (policy/licence/quarantine/rate
 * limit), 64 bad usage, 1 unexpected error.
 */
import { searchReferences, fetchReference } from "../src/lib/referenceSourcing.js";
import { createRateLimiter, DEFAULT_MIN_INTERVAL_MS, RateLimitExceededError } from "../src/lib/referenceRateLimit.js";
import { listSourceIds } from "../src/lib/referenceSourcePolicy.js";
import { ReferenceRejectedError } from "../src/lib/referenceQuarantine.js";

const DEFAULT_QUARANTINE_DIR = "assets/src/reference/quarantine";

const USAGE = [
  "usage: node tools/board/scripts/referenceFetch.js search <sourceId> <query> [limit]",
  "       node tools/board/scripts/referenceFetch.js fetch  <sourceId> <assetId> [quarantineDir]",
  `sources: ${listSourceIds().join(", ")}`
].join("\n");

function fail(code, message) {
  console.error(message);
  process.exitCode = code;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const rateLimiter = createRateLimiter({
    minIntervalMs: Number(process.env.REFERENCE_MIN_INTERVAL_MS) || DEFAULT_MIN_INTERVAL_MS
  });

  if (command === "search") {
    const [sourceId, query, limit] = rest;
    if (!sourceId || !query) {
      fail(64, `referenceFetch: missing arguments\n${USAGE}`);
      return;
    }
    const result = await searchReferences({
      sourceId,
      query,
      limit: limit ? Number(limit) : undefined,
      rateLimiter
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (command === "fetch") {
    const [sourceId, assetId, quarantineDir] = rest;
    if (!sourceId || !assetId) {
      fail(64, `referenceFetch: missing arguments\n${USAGE}`);
      return;
    }
    const result = await fetchReference({
      sourceId,
      assetId,
      quarantineDir: quarantineDir || DEFAULT_QUARANTINE_DIR,
      rateLimiter
    });
    console.log(JSON.stringify(result));
    return;
  }

  fail(64, `referenceFetch: unknown command "${command ?? ""}"\n${USAGE}`);
}

main().catch((err) => {
  if (err instanceof ReferenceRejectedError || err instanceof RateLimitExceededError) {
    fail(2, `referenceFetch: rejected -- ${err.message}`);
    return;
  }
  fail(1, `referenceFetch: unexpected error -- ${err.message}`);
});
