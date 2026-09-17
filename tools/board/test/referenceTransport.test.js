import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { requestUrl, TransportSizeExceededError } from "../src/lib/referenceTransport.js";

let server;
let baseUrl;

async function startServer(handler) {
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
});

describe("requestUrl -- the transport this repo's tools use for outbound reference fetches", () => {
  it("returns status, headers, and body for a plain 200 response", async () => {
    await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const res = await requestUrl(`${baseUrl}/thing`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ ok: true });
  });

  it("never auto-follows a redirect -- it returns the 3xx and Location header for the caller to validate", async () => {
    await startServer((req, res) => {
      if (req.url === "/redirect-me") {
        res.writeHead(302, { location: `${baseUrl}/final` });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("should never be reached automatically");
    });
    const res = await requestUrl(`${baseUrl}/redirect-me`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${baseUrl}/final`);
  });

  it("aborts and rejects once a response exceeds the given byte cap, instead of buffering it all into memory", async () => {
    await startServer((req, res) => {
      res.writeHead(200);
      // Stream well past the cap; a well-behaved transport must stop reading long before this ends.
      const chunk = Buffer.alloc(1024, 1);
      const interval = setInterval(() => {
        if (res.destroyed) {
          clearInterval(interval);
          return;
        }
        res.write(chunk);
      }, 1);
      res.on("close", () => clearInterval(interval));
    });
    await expect(requestUrl(`${baseUrl}/firehose`, { maxBytes: 2048 })).rejects.toThrow(TransportSizeExceededError);
  });

  it("respects a byte cap large enough for a normal small response", async () => {
    await startServer((req, res) => {
      res.writeHead(200);
      res.end("small");
    });
    const res = await requestUrl(`${baseUrl}/small`, { maxBytes: 1024 });
    expect(res.body.toString("utf8")).toBe("small");
  });

  it("(T-0284) sends a policy-compliant User-Agent -- tool name, version, AND a contact URL, never a bare token", async () => {
    let receivedUserAgent;
    await startServer((req, res) => {
      receivedUserAgent = req.headers["user-agent"];
      res.writeHead(200);
      res.end("ok");
    });
    await requestUrl(`${baseUrl}/thing`);
    // Wikimedia's UA policy requires <client>/<version> (<contact>) -- a UA with no reachable
    // contact is throttled aggressively, which is exactly what T-0284 investigated. Assert the
    // shape so it cannot silently regress back to a bare, contactless token.
    expect(receivedUserAgent).toMatch(/^assembled-reference-sourcing\/\d+(\.\d+)*\s+\(.+\)$/);
    expect(receivedUserAgent).toMatch(/github\.com\/dennie-seth\/assembled/);
    expect(receivedUserAgent).not.toBe("assembled-reference-sourcing/1.0");
  });
});
