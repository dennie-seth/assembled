import { describe, it, expect } from "vitest";
import { extractDiagnosticHeaders, formatDiagnosticHeaders } from "../src/lib/referenceDiagnostics.js";

describe("extractDiagnosticHeaders -- allowlist of response headers that explain a transport failure (T-0283)", () => {
  it("keeps Retry-After", () => {
    expect(extractDiagnosticHeaders({ "retry-after": "30" })).toEqual({ "retry-after": "30" });
  });

  it("keeps every X-RateLimit-* header regardless of suffix", () => {
    expect(
      extractDiagnosticHeaders({
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1699999999"
      })
    ).toEqual({
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1699999999"
    });
  });

  it("keeps CDN/proxy headers -- Via, X-Cache, Server, CF-Ray, X-Served-By", () => {
    expect(
      extractDiagnosticHeaders({
        via: "1.1 varnish",
        "x-cache": "HIT",
        server: "nginx",
        "cf-ray": "abc123-SEA",
        "x-served-by": "cache-sea1234"
      })
    ).toEqual({
      via: "1.1 varnish",
      "x-cache": "HIT",
      server: "nginx",
      "cf-ray": "abc123-SEA",
      "x-served-by": "cache-sea1234"
    });
  });

  it("is case-insensitive on header names", () => {
    expect(extractDiagnosticHeaders({ "Retry-After": "5" })).toEqual({ "retry-after": "5" });
  });

  it("drops any header not on the diagnostic allowlist, notably credentials -- Authorization, Cookie, Set-Cookie", () => {
    const headers = extractDiagnosticHeaders({
      authorization: "Bearer secret-token",
      cookie: "session=abc",
      "set-cookie": "session=abc; HttpOnly",
      "content-type": "application/json",
      "retry-after": "30"
    });
    expect(headers).toEqual({ "retry-after": "30" });
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("set-cookie");
  });

  it("returns an empty object for missing or empty headers", () => {
    expect(extractDiagnosticHeaders(undefined)).toEqual({});
    expect(extractDiagnosticHeaders({})).toEqual({});
  });

  it("joins an array-valued header (Node's raw-header shape) into one string", () => {
    expect(extractDiagnosticHeaders({ via: ["1.1 varnish", "1.1 squid"] })).toEqual({ via: "1.1 varnish, 1.1 squid" });
  });
});

describe("formatDiagnosticHeaders -- renders the allowlisted headers into one line for an error message", () => {
  it("formats multiple headers as comma-separated name=value pairs", () => {
    expect(formatDiagnosticHeaders({ "retry-after": "30", server: "nginx" })).toBe("retry-after=30, server=nginx");
  });

  it("returns an empty string when nothing on the allowlist is present", () => {
    expect(formatDiagnosticHeaders({ "content-type": "application/json" })).toBe("");
  });

  it("never includes a credential header even alongside diagnostic ones", () => {
    const formatted = formatDiagnosticHeaders({ "retry-after": "30", authorization: "Bearer secret-token" });
    expect(formatted).toBe("retry-after=30");
    expect(formatted).not.toMatch(/secret-token/);
  });
});
