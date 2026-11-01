/**
 * T-0461 — commit the Claude + Codex working agreement (v2) at
 * `docs/design/working-agreement.md`, governance only, no behavioural change.
 *
 * The card's own acceptance criteria are the spec: the committed file must be
 * byte-identical to the v2 source attached to the card (9249 bytes, 71 lines,
 * UTF-8, sha256 `4916fcd4e0735cea9190e97db2d208d3e4e91c959f26d69773ac5c23135f1eda`),
 * must be v2 (not the superseded draft hashing
 * `09c95ac10639e2ac363c858f12c3f0283a63ad6fcfe4993b2ec1b5f1c6d66eff`), and must
 * carry its own unresolved "Open decision for Dennie" section verbatim rather
 * than having it silently answered or dropped by a later edit.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const AGREEMENT_DOC = path.join(REPO_ROOT, "docs", "design", "working-agreement.md");

const V2_SHA256 = "4916fcd4e0735cea9190e97db2d208d3e4e91c959f26d69773ac5c23135f1eda";
const V1_SUPERSEDED_SHA256 = "09c95ac10639e2ac363c858f12c3f0283a63ad6fcfe4993b2ec1b5f1c6d66eff";

describe("docs/design/working-agreement.md is the committed v2 working agreement", () => {
  let buf;
  let text;
  beforeAll(() => {
    buf = fs.existsSync(AGREEMENT_DOC) ? fs.readFileSync(AGREEMENT_DOC) : Buffer.alloc(0);
    text = buf.toString("utf8");
  });

  it("exists on the branch head", () => {
    expect(fs.existsSync(AGREEMENT_DOC), `missing file: ${AGREEMENT_DOC}`).toBe(true);
  });

  it("is byte-identical to the attached v2 source (sha256 match)", () => {
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    expect(hash).toBe(V2_SHA256);
  });

  it("is not the superseded v1 draft", () => {
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    expect(hash).not.toBe(V1_SUPERSEDED_SHA256);
  });

  it("is UTF-8 with no BOM and no CRLF line endings", () => {
    expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf).toBe(false);
    expect(text.includes("\r")).toBe(false);
  });

  it("has 71 lines", () => {
    const lines = text.split("\n");
    // a trailing newline after the last content line produces one empty
    // trailing element from split("\n") -- 71 content lines + that element.
    expect(lines.length).toBe(72);
    expect(lines.at(-1)).toBe("");
  });

  it("names Codex on the first line (not the earlier draft's 'Chat')", () => {
    const firstLine = text.split("\n")[0];
    expect(firstLine).toContain("Codex");
    expect(firstLine).not.toContain("Chat");
  });

  it("Status line marks it v2, revised to incorporate Codex's design review", () => {
    expect(text).toContain("Status: v2, 21 October 2026");
    expect(text).toContain("revised to incorporate Codex's design review");
  });

  it("names `develop` as the integration branch and says there is no `dev`", () => {
    expect(text).toContain("**`develop`** is the integration branch");
    expect(text).toContain("there is no `dev`");
  });

  it("states plan-conformance is necessary but not sufficient for auto-merge", () => {
    expect(text).toContain("Plan-conformance is **necessary but not sufficient.**");
    expect(text).toContain("explicit human approval for low-risk auto-merge");
  });

  it("carries the unresolved 'Open decision for Dennie' section verbatim", () => {
    expect(text).toContain("## Open decision for Dennie");
    expect(text).toContain(
      "Does the pilot auto-merge directly to the live `develop`"
    );
    expect(text).toContain("Claude's lean: isolate the pilot");
  });
});
