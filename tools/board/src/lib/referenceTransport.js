/**
 * Real network transport for the reference-sourcing wrapper (T-0276). Deliberately dumb: issues
 * one GET, never auto-follows a redirect (the 3xx status and `Location` header are handed back
 * to the caller, which is `referenceSourcing.js` -- it re-validates every redirect target against
 * the source allowlist before ever requesting it), and aborts mid-stream once the response body
 * exceeds `maxBytes` rather than buffering an unbounded response into memory first.
 *
 * This is the only place in the reference-sourcing code that performs real I/O; every other
 * module takes an injected `transport` function so its tests run fully offline.
 */

import http from "node:http";
import https from "node:https";

export class TransportSizeExceededError extends Error {}

/**
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.maxBytes] abort once the response body would exceed this many bytes
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
export function requestUrl(url, { maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;

    let settled = false;
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = client.request(
      url,
      { method: "GET", headers: { "User-Agent": "assembled-reference-sourcing/1.0" } },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            req.destroy();
            settleReject(new TransportSizeExceededError(`response exceeded ${maxBytes}-byte cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          settleResolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", settleReject);
      }
    );
    req.on("error", settleReject);
    req.end();
  });
}

export const defaultTransport = requestUrl;
