/**
 * Byte-safety and quarantine gate for fetched references (T-0276).
 *
 * Reuses the board's own attachment mime allowlist (`PREVIEWABLE_IMAGE_MIMES` /
 * `REJECTED_SNIFFED_MIMES` from `../server/httpApi.js`) rather than defining a second one, per
 * the card's explicit design pointer: bytes are sniffed with `file-type`, never trusted from a
 * claimed `Content-Type` or a URL's extension, and SVG/HTML/XHTML are rejected outright because
 * they carry script and get rendered.
 *
 * Everything this module writes lands under the caller's `quarantineDir` -- never `assets/`, and
 * this module never calls `git`. Promotion out of quarantine is a separate, deliberate step taken
 * by whichever card consumes the reference (T-0273 and onward), not something this module does.
 * The on-disk filename is always derived from the content's own sha256 hash, never from any
 * remote-supplied title/filename -- a hostile "../../evil" title cannot influence the path at
 * all, since it is never read for that purpose in the first place.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { PREVIEWABLE_IMAGE_MIMES, REJECTED_SNIFFED_MIMES } from "../server/httpApi.js";

export class ReferenceRejectedError extends Error {}

export const DEFAULT_MAX_ASSET_BYTES = 15 * 1024 * 1024;
export function maxAssetBytesFromEnv() {
  const raw = Number(process.env.REFERENCE_MAX_ASSET_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ASSET_BYTES;
}

export const DEFAULT_MAX_ASSETS_PER_RUN = 20;
export function maxAssetsPerRunFromEnv() {
  const raw = Number(process.env.REFERENCE_MAX_ASSETS_PER_RUN);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ASSETS_PER_RUN;
}

const EXT_BY_MIME = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
});

/**
 * Sniffs `buffer`'s real type. Resolves to a mime string on the `PREVIEWABLE_IMAGE_MIMES`
 * allowlist, or rejects (fail closed) for anything else -- an explicitly-rejected type (SVG/
 * HTML/XHTML), an unsniffable byte stream, or a real-but-not-image format.
 */
export async function sniffImageBytes(buffer) {
  const sniffed = await fileTypeFromBuffer(buffer);
  const mime = sniffed?.mime ?? null;
  if (!mime) {
    throw new ReferenceRejectedError("could not sniff a real image type from the fetched bytes");
  }
  if (REJECTED_SNIFFED_MIMES.has(mime)) {
    throw new ReferenceRejectedError(`rejected mime type "${mime}" (SVG/HTML/XHTML are never accepted)`);
  }
  if (!PREVIEWABLE_IMAGE_MIMES.has(mime)) {
    throw new ReferenceRejectedError(`mime type "${mime}" is not on the previewable-image allowlist`);
  }
  return mime;
}

/** Number of assets already quarantined in `quarantineDir` (0 if the directory doesn't exist yet). */
export async function countQuarantinedAssets(quarantineDir) {
  let entries;
  try {
    entries = await fs.readdir(quarantineDir);
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  return entries.filter((name) => name.endsWith(".provenance.json")).length;
}

/**
 * Writes `buffer` (already sniffed, already mime-allowlisted) into `quarantineDir`, alongside a
 * `.provenance.json` sidecar recording `provenance` plus the mime/hash/size this module itself
 * establishes. Enforces the per-asset byte cap and the total quarantine count cap before writing
 * anything -- both fail closed, and a rejection here never leaves a partial file behind.
 *
 * @param {object} args
 * @param {string} args.quarantineDir
 * @param {Buffer} args.buffer
 * @param {string} args.mime one of PREVIEWABLE_IMAGE_MIMES
 * @param {object} args.provenance source URL, licence, retrieval date, etc. -- merged verbatim
 *   into the written record alongside mime/sha256/byteLength.
 * @param {number} [args.maxBytes]
 * @param {number} [args.maxCount]
 */
export async function quarantineAsset({
  quarantineDir,
  buffer,
  mime,
  provenance,
  maxBytes = maxAssetBytesFromEnv(),
  maxCount = maxAssetsPerRunFromEnv()
}) {
  if (buffer.length > maxBytes) {
    throw new ReferenceRejectedError(`asset is ${buffer.length} bytes, over the ${maxBytes}-byte cap`);
  }
  const existing = await countQuarantinedAssets(quarantineDir);
  if (existing >= maxCount) {
    throw new ReferenceRejectedError(`quarantine already holds ${existing} asset(s), at the ${maxCount} cap`);
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const ext = EXT_BY_MIME[mime] ?? "bin";

  await fs.mkdir(quarantineDir, { recursive: true });
  const resolvedDir = path.resolve(quarantineDir);
  const assetPath = path.join(resolvedDir, `${sha256}.${ext}`);
  const provenancePath = path.join(resolvedDir, `${sha256}.provenance.json`);

  const record = { ...provenance, mime, sha256, byteLength: buffer.length };

  await fs.writeFile(assetPath, buffer);
  await fs.writeFile(provenancePath, JSON.stringify(record, null, 2));

  return { assetPath, provenancePath, record };
}
