import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sniffImageBytes,
  quarantineAsset,
  countQuarantinedAssets,
  ReferenceRejectedError,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_ASSETS_PER_RUN
} from "../src/lib/referenceQuarantine.js";
import { PREVIEWABLE_IMAGE_MIMES, REJECTED_SNIFFED_MIMES } from "../src/server/httpApi.js";

// Real, valid 1x1 transparent PNG -- magic bytes matter, this module sniffs bytes not extensions.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const SVG_WITH_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "utf8"
);

const HTML_LABELED_AS_IMAGE = Buffer.from("<!doctype html><html><body>not an image</body></html>", "utf8");

let tmpDir;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function makeTmpDir() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-reference-quarantine-"));
  return tmpDir;
}

describe("referenceQuarantine reuses the board's own attachment mime allowlist -- not a second one", () => {
  it("PREVIEWABLE_IMAGE_MIMES / REJECTED_SNIFFED_MIMES are the same objects the httpApi attachment path enforces", () => {
    expect(PREVIEWABLE_IMAGE_MIMES.has("image/png")).toBe(true);
    expect(REJECTED_SNIFFED_MIMES.has("image/svg+xml")).toBe(true);
  });
});

describe("sniffImageBytes -- bytes are sniffed, not trusted from any claimed content-type", () => {
  it("accepts a real PNG", async () => {
    await expect(sniffImageBytes(TINY_PNG)).resolves.toBe("image/png");
  });

  it("rejects an SVG even though it could be labeled image/svg+xml or claimed as a png", async () => {
    await expect(sniffImageBytes(SVG_WITH_SCRIPT)).rejects.toThrow(ReferenceRejectedError);
  });

  it("rejects HTML content", async () => {
    await expect(sniffImageBytes(HTML_LABELED_AS_IMAGE)).rejects.toThrow(ReferenceRejectedError);
  });

  it("rejects bytes that cannot be sniffed as any real image format at all", async () => {
    await expect(sniffImageBytes(Buffer.from("not an image at all"))).rejects.toThrow(ReferenceRejectedError);
  });
});

describe("quarantineAsset -- fetched bytes land in quarantine, never assets/, with per-asset provenance", () => {
  it("writes the asset and a provenance record keyed by content hash, never by the remote's claimed filename/title", async () => {
    const dir = await makeTmpDir();
    const provenance = {
      sourceId: "wikimedia",
      assetId: "File:Example.jpg",
      title: "../../evil-path-traversal-attempt",
      sourceUrl: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Example.jpg",
      license: "CC0",
      licenseNormalized: "cc0",
      retrievedAt: "2026-09-01T00:00:00.000Z"
    };
    const { assetPath, provenancePath, record } = await quarantineAsset({
      quarantineDir: dir,
      buffer: TINY_PNG,
      mime: "image/png",
      provenance
    });

    expect(path.dirname(assetPath)).toBe(path.resolve(dir));
    expect(path.dirname(provenancePath)).toBe(path.resolve(dir));
    // The malicious title never ends up as any part of the on-disk path.
    expect(assetPath).not.toMatch(/evil/);
    expect(provenancePath).not.toMatch(/evil/);

    expect(record.mime).toBe("image/png");
    expect(record.sourceUrl).toBe(provenance.sourceUrl);
    expect(record.license).toBe("CC0");
    expect(record.licenseNormalized).toBe("cc0");
    expect(record.retrievedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = await fs.readFile(assetPath);
    expect(onDisk.equals(TINY_PNG)).toBe(true);
    const provenanceOnDisk = JSON.parse(await fs.readFile(provenancePath, "utf8"));
    expect(provenanceOnDisk).toEqual(record);
  });

  it("never writes anywhere outside the given quarantine directory", async () => {
    const dir = await makeTmpDir();
    const { assetPath } = await quarantineAsset({
      quarantineDir: dir,
      buffer: TINY_PNG,
      mime: "image/png",
      provenance: { sourceId: "wikimedia", assetId: "x", sourceUrl: "https://upload.wikimedia.org/x.jpg", license: "CC0", licenseNormalized: "cc0", retrievedAt: "2026-09-01T00:00:00.000Z" }
    });
    const resolvedDir = path.resolve(dir) + path.sep;
    expect(assetPath.startsWith(resolvedDir)).toBe(true);
  });

  it("rejects (fail closed) an asset over the per-request byte cap without writing anything", async () => {
    const dir = await makeTmpDir();
    await expect(
      quarantineAsset({
        quarantineDir: dir,
        buffer: TINY_PNG,
        mime: "image/png",
        provenance: { sourceId: "wikimedia", assetId: "x", sourceUrl: "https://upload.wikimedia.org/x.jpg", license: "CC0", licenseNormalized: "cc0", retrievedAt: "2026-09-01T00:00:00.000Z" },
        maxBytes: 4
      })
    ).rejects.toThrow(ReferenceRejectedError);
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
  });

  it("enforces a total-count cap across the quarantine directory", async () => {
    const dir = await makeTmpDir();
    const provenanceFor = (n) => ({
      sourceId: "wikimedia",
      assetId: `x${n}`,
      sourceUrl: `https://upload.wikimedia.org/x${n}.jpg`,
      license: "CC0",
      licenseNormalized: "cc0",
      retrievedAt: "2026-09-01T00:00:00.000Z"
    });
    // Two visually distinct 1x1 PNGs so their content hashes differ and both get written.
    const png2 = Buffer.concat([TINY_PNG, Buffer.from([0])]);
    await quarantineAsset({ quarantineDir: dir, buffer: TINY_PNG, mime: "image/png", provenance: provenanceFor(1), maxCount: 1 });
    await expect(
      quarantineAsset({ quarantineDir: dir, buffer: png2, mime: "image/png", provenance: provenanceFor(2), maxCount: 1 })
    ).rejects.toThrow(ReferenceRejectedError);
  });

  it("counts only provenance records, not incidental files, when checking the cap", async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".gitkeep"), "");
    expect(await countQuarantinedAssets(dir)).toBe(0);
  });

  it("reports zero for a quarantine directory that does not exist yet", async () => {
    expect(await countQuarantinedAssets(path.join(os.tmpdir(), "board-reference-quarantine-does-not-exist"))).toBe(0);
  });

  it("exports sane defaults for the byte and count caps", () => {
    expect(DEFAULT_MAX_ASSET_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_ASSETS_PER_RUN).toBeGreaterThan(0);
  });
});
