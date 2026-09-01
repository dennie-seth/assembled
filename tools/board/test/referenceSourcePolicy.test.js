import { describe, it, expect } from "vitest";
import {
  REFERENCE_SOURCES,
  MAX_REDIRECTS,
  listSourceIds,
  getSource,
  checkSearchUrl,
  checkFetchUrl,
  checkRedirect
} from "../src/lib/referenceSourcePolicy.js";

describe("referenceSourcePolicy -- in-code allowlist of reputable open-licence sources", () => {
  it("lists exactly the configured sources", () => {
    expect(listSourceIds().sort()).toEqual(["openverse", "wikimedia"]);
  });

  it("exposes each source's fetch host allowlist as a small, explicit, in-code set", () => {
    expect(REFERENCE_SOURCES.wikimedia.fetchHosts).toEqual(["upload.wikimedia.org", "commons.wikimedia.org"]);
    expect(REFERENCE_SOURCES.openverse.fetchHosts).toEqual(["api.openverse.org"]);
  });

  it("getSource returns null for an unknown id (fail closed, no default source)", () => {
    expect(getSource("some-random-cdn")).toBeNull();
  });
});

describe("checkSearchUrl -- search only ever talks to the source's own API host", () => {
  it("allows a wikimedia search URL built from the source's own template", () => {
    const url = REFERENCE_SOURCES.wikimedia.searchUrl("lighthouse", 10);
    expect(checkSearchUrl({ sourceId: "wikimedia", url }).allowed).toBe(true);
  });

  it("allows an openverse search URL built from the source's own template", () => {
    const url = REFERENCE_SOURCES.openverse.searchUrl("lighthouse", 10);
    expect(checkSearchUrl({ sourceId: "openverse", url }).allowed).toBe(true);
  });

  it("denies an unknown source id", () => {
    const verdict = checkSearchUrl({ sourceId: "google-images", url: "https://images.google.com/search?q=x" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/unknown reference source/);
  });

  it("denies a search URL whose host does not match the source's api host, even for a listed source id", () => {
    const verdict = checkSearchUrl({ sourceId: "wikimedia", url: "https://evil.example.com/api.php?srsearch=x" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not the allowlisted host/);
  });

  it("denies plain http (no TLS downgrade) even to an otherwise-allowlisted host", () => {
    const verdict = checkSearchUrl({ sourceId: "wikimedia", url: "http://commons.wikimedia.org/w/api.php?srsearch=x" });
    expect(verdict.allowed).toBe(false);
  });

  it("denies an unparseable URL", () => {
    const verdict = checkSearchUrl({ sourceId: "wikimedia", url: "not a url" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not a parseable/);
  });
});

describe("checkFetchUrl -- byte fetches only ever land on the source's declared fetch hosts", () => {
  it("allows a wikimedia upload.wikimedia.org URL", () => {
    expect(
      checkFetchUrl({ sourceId: "wikimedia", url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Example.jpg" })
        .allowed
    ).toBe(true);
  });

  it("allows an openverse api.openverse.org thumbnail URL", () => {
    expect(
      checkFetchUrl({ sourceId: "openverse", url: "https://api.openverse.org/v1/images/abc-123/thumb/" }).allowed
    ).toBe(true);
  });

  it("denies a fetch host outside the allowlist even when it looks like a plausible CDN", () => {
    const verdict = checkFetchUrl({ sourceId: "wikimedia", url: "https://sketchy-mirror.example.net/Example.jpg" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not on the allowlist/);
  });

  it("denies openverse's own arbitrary third-party 'url' field host (flickr, museum sites, ...) -- only the openverse-hosted thumbnail proxy is allowlisted", () => {
    const verdict = checkFetchUrl({ sourceId: "openverse", url: "https://live.staticflickr.com/123/456.jpg" });
    expect(verdict.allowed).toBe(false);
  });

  it("denies an unknown source id", () => {
    expect(checkFetchUrl({ sourceId: "nope", url: "https://upload.wikimedia.org/x.jpg" }).allowed).toBe(false);
  });
});

describe("checkRedirect -- redirects are capped and must stay within the same source's allowlist", () => {
  it("allows a redirect within the allowlist under the cap", () => {
    const verdict = checkRedirect({
      sourceId: "wikimedia",
      targetUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/Example.jpg/800px-Example.jpg",
      hopIndex: 0
    });
    expect(verdict.allowed).toBe(true);
  });

  it("denies a redirect that leaves the allowlist", () => {
    const verdict = checkRedirect({ sourceId: "wikimedia", targetUrl: "https://attacker.example.com/payload.jpg", hopIndex: 0 });
    expect(verdict.allowed).toBe(false);
  });

  it(`denies once the hop index reaches MAX_REDIRECTS (${MAX_REDIRECTS})`, () => {
    const verdict = checkRedirect({
      sourceId: "wikimedia",
      targetUrl: "https://upload.wikimedia.org/x.jpg",
      hopIndex: MAX_REDIRECTS
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/redirect chain/);
  });
});
