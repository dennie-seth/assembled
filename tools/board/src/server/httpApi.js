import path from "node:path";
import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import busboy from "busboy";
import { fileTypeFromBuffer } from "file-type";
import {
  assertCanMoveToInProgress,
  UnmetDependencyError,
  DependencyCycleError
} from "../lib/dependencyGuard.js";
import { listAssignableAgents } from "../lib/agentCatalog.js";
import { pullDevelop, commitTaskFile, commitPaths, autoCommitCardsOnCreateFromEnv } from "../runner/gitOps.js";

const TASK_ID_PATH_RE = /^\/api\/tasks\/([^/]+)$/;
const TASK_RUN_PATH_RE = /^\/api\/tasks\/([^/]+)\/run$/;
const TASK_CANCEL_PATH_RE = /^\/api\/tasks\/([^/]+)\/cancel$/;
const TASK_COMMENTS_PATH_RE = /^\/api\/tasks\/([^/]+)\/comments$/;
const TASK_ATTACHMENTS_PATH_RE = /^\/api\/tasks\/([^/]+)\/attachments$/;
const TASK_ATTACHMENT_FILE_PATH_RE = /^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/;
const RUNNABLE_STATUSES = new Set(["ready", "review", "blocked"]);
const AGENTS_PATH = "/api/agents";
const BACKLOG_EXPORT_PATH = "/api/tasks/export/backlog";
const DONE_EXPORT_PATH = "/api/tasks/export/done";
const GIT_STATUS_PATH = "/api/git/status";
const LIVE_RUN_STATUSES = new Set(["in-progress", "validation"]);

/**
 * Attachment upload policy (see handleUploadAttachment): a denylist, not a strict allowlist --
 * the LoRA/reference-image tasks that drive this endpoint via curl may send arbitrary binary
 * blobs (e.g. .safetensors) that `file-type` can't identify by magic bytes, and those must go
 * through. What must NEVER go through is active markup that a browser could execute if it were
 * ever rendered: SVG and HTML. `file-type` sniffs real binary image formats reliably, but SVG/
 * HTML/XML are text formats with no magic number it can detect -- so the second, text-pattern
 * check below is the actual defense for those, not the REJECTED_SNIFFED_MIMES set (which is
 * cheap insurance in case a future file-type version ever learns to sniff them).
 */
const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** BOARD_ATTACHMENT_MAX_BYTES env var: default 25 MB; read per-request (like autoCommitCardsOnCreateFromEnv). */
function attachmentMaxBytesFromEnv() {
  const raw = Number(process.env.BOARD_ATTACHMENT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ATTACHMENT_MAX_BYTES;
}
const PREVIEWABLE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const REJECTED_SNIFFED_MIMES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml"]);
const MARKUP_SNIFF_RE = /<\s*(?:svg|script|html|!doctype\s+html)/i;

const DEFAULTS = {
  status: "backlog",
  priority: "P2",
  agent: null,
  depends_on: [],
  body: ""
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function requireJsonObject(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body;
}

function sendJson(res, status, payload) {
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw)
  });
  res.end(raw);
}

/** Strips any directory components and rejects empty/"."/".."/control-char names. */
function sanitizeFilename(rawFilename) {
  if (typeof rawFilename !== "string") return null;
  const base = path.basename(rawFilename.replace(/\\/g, "/")).trim();
  if (base.length === 0 || base === "." || base === "..") return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(base)) return null;
  return base;
}

/**
 * Root directory attachment files live under: `<dataDir>/attachments/` in db mode (rooted under
 * the same out-of-repo data directory as the SQLite file itself, so `git pull`/checkout on the
 * repo can never touch attachments either), `<tasksDir>/attachments/` in fs mode (unchanged --
 * see docs/design/cards-to-database.md, "Attachments stay files on disk").
 */
function attachmentsRootDir({ taskStoreKind, tasksDir, dataDir }) {
  if (taskStoreKind === "db") {
    if (!dataDir) {
      throw new HttpError(500, "Server misconfigured: db mode requires dataDir for attachment storage");
    }
    return path.join(dataDir, "attachments");
  }
  return path.join(tasksDir, "attachments");
}

/** Resolves `filename` to a path guaranteed to live inside `cardAttachmentsDir`, or null. */
function resolveAttachmentPath(cardAttachmentsDir, filename) {
  const safeName = sanitizeFilename(filename);
  if (!safeName) return null;
  const resolved = path.resolve(cardAttachmentsDir, safeName);
  const dirResolved = path.resolve(cardAttachmentsDir) + path.sep;
  if (!resolved.startsWith(dirResolved)) return null;
  return resolved;
}

/** Resolves `id`'s attachment directory to a path guaranteed to live inside `root`, or null. */
function resolveCardAttachmentsDir(root, id) {
  if (typeof id !== "string" || id.length === 0) return null;
  const resolved = path.resolve(root, id);
  const rootResolved = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootResolved)) return null;
  return resolved;
}

/**
 * Best-effort removal of a card's on-disk attachment directory, called after the store's row
 * delete has already committed (see handleDeleteTask): a filesystem failure here must never
 * block or appear to fail the delete the user asked for -- it only risks leaving an orphaned
 * directory behind for the periodic integrity checker to flag, which beats refusing to delete a
 * card because of an unrelated disk/permission problem. Skips entirely (no warning) when the
 * server wasn't given enough config to know where attachments would live -- that's a handful of
 * tests that construct a bare server without tasksDir/dataDir, not a real deployment.
 */
async function removeCardAttachments({ taskStoreKind, tasksDir, dataDir, id }) {
  if (taskStoreKind === "db" ? !dataDir : !tasksDir) return;
  const root = attachmentsRootDir({ taskStoreKind, tasksDir, dataDir });
  const dir = resolveCardAttachmentsDir(root, id);
  if (!dir) {
    console.warn(`Board: refusing to remove attachments for invalid task id "${id}"`);
    return;
  }
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`Board: failed to remove attachments directory for ${id} (leaving it orphaned):`, err.message);
  }
}

/** Sniffs `buffer`'s real type and rejects active markup (SVG/HTML) regardless of what the uploader claimed. */
async function resolveMimeType(buffer) {
  const sniffed = await fileTypeFromBuffer(buffer);
  const sniffedMime = sniffed?.mime ?? null;
  if (sniffedMime && REJECTED_SNIFFED_MIMES.has(sniffedMime)) {
    throw new HttpError(415, `Attachment type "${sniffedMime}" is not allowed`);
  }
  if (sniffedMime) return sniffedMime;
  if (MARKUP_SNIFF_RE.test(buffer.subarray(0, 4096).toString("utf8"))) {
    throw new HttpError(415, "Attachment content looks like markup (SVG/HTML), which is not allowed");
  }
  // file-type can't sniff plain-text/unstructured binary formats (e.g. .safetensors, .json,
  // .txt) by magic bytes -- these pass through as opaque binary. Downloads always set
  // X-Content-Type-Options: nosniff and a Content-Disposition, so the browser never executes
  // them regardless of the label.
  return "application/octet-stream";
}

/** Parses a single-file multipart/form-data body (field "file", optional field "uploaded_by") from a raw Node request. */
function parseMultipartUpload(req, { maxBytes }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      // busboy decodes multipart filename/field params as latin1 by default (RFC 2388), which
      // mangles non-ASCII filenames sent as UTF-8 (the browser/curl default) -- force utf8.
      bb = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 }, defParamCharset: "utf8" });
    } catch {
      reject(new HttpError(400, "Request must be multipart/form-data"));
      return;
    }

    let settled = false;
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    let fileResult = null;
    let truncated = false;
    let sawFile = false;
    const fields = {};

    bb.on("file", (_name, stream, info) => {
      sawFile = true;
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => {
        truncated = true;
      });
      stream.on("close", () => {
        fileResult = { filename: info.filename, buffer: Buffer.concat(chunks) };
      });
    });

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("error", (err) => settleReject(new HttpError(400, `Malformed upload: ${err.message}`)));

    bb.on("close", () => {
      if (settled) return;
      if (truncated) {
        settleReject(new HttpError(413, `Attachment exceeds the ${maxBytes}-byte limit`));
        return;
      }
      if (!sawFile || !fileResult || !fileResult.filename) {
        settleReject(new HttpError(400, 'Request must include a file part named "file"'));
        return;
      }
      settled = true;
      resolve({ file: fileResult, fields });
    });

    req.pipe(bb);
  });
}

const RFC5987_UNRESERVED_RE = /['()*]/g;
function encodeRfc5987ValueChars(str) {
  return encodeURIComponent(str)
    .replace(RFC5987_UNRESERVED_RE, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** ASCII-only fallback for the legacy `filename=` parameter (RFC 6266 recommends pairing it with `filename*=`). */
function asciiFallbackFilename(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return ascii.length > 0 ? ascii : "attachment";
}

async function handleListTasks(store, res) {
  const tasks = await store.list();
  sendJson(res, 200, tasks);
}

async function handleCreateTask(store, idAllocator, req, res, repoRoot, tasksDir, taskStoreKind, hub) {
  const body = requireJsonObject(await readJsonBody(req));
  if (typeof body.title !== "string" || body.title.length === 0) {
    throw new HttpError(400, "title is required and must be a non-empty string");
  }
  if (typeof body.phase !== "number" || !Number.isInteger(body.phase)) {
    throw new HttpError(400, "phase is required and must be an integer");
  }

  const id = await idAllocator.allocate();
  const task = {
    id,
    title: body.title,
    status: body.status ?? DEFAULTS.status,
    priority: body.priority ?? DEFAULTS.priority,
    phase: body.phase,
    agent: body.agent ?? DEFAULTS.agent,
    depends_on: body.depends_on ?? DEFAULTS.depends_on,
    created: body.created ?? todayIso(),
    body: body.body ?? DEFAULTS.body
  };

  let created;
  try {
    created = await store.create(task);
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  if (taskStoreKind !== "db" && repoRoot && tasksDir && autoCommitCardsOnCreateFromEnv()) {
    try {
      const relativePath = path.relative(repoRoot, path.join(tasksDir, `${id}.md`));
      await commitTaskFile({ repoRoot, filePath: relativePath, message: `chore(board): add card ${id}` });
    } catch (err) {
      // Card creation must never fail because git couldn't commit it -- the id allocator's
      // git-history scan is what actually prevents id reuse; this commit is a fast-follow so
      // sibling worktrees/branches see it sooner. Leaving it untracked here just means the old
      // failure mode (until the next `git log --all` picks it up post-commit elsewhere) persists
      // for this one card.
      console.warn(`Board: failed to commit card file for ${id} (leaving it untracked):`, err.message);
    }
  }

  // In db mode there is no tasks/*.md file for a watcher to notice, so this route broadcasts
  // directly -- the fs-mode equivalent of this event comes from TaskWatcher picking up the write.
  if (taskStoreKind === "db" && hub) {
    hub.broadcast({ type: "added", id, task: created });
  }

  sendJson(res, 201, created);
}

async function handleGetTask(store, id, res) {
  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }
  sendJson(res, 200, task);
}

/**
 * Handles ordinary card edits (drag between board columns, editing title/priority/agent/etc.
 * via the UI) -- the one route every routine field/status change goes through, including the
 * Review -> Done flip. Commits the updated card file the same way create/comments/attachments
 * do (see their matching rationale), so an update never leaves repoRoot's working tree dirty.
 * That matters here specifically: the Done-triggered `pullDevelop` below needs a clean tree to
 * merge, and a prior update's uncommitted diff was exactly what made that pull start failing
 * with "local changes ... would be overwritten by merge" once origin touched the same file.
 */
async function handlePatchTask(store, id, req, res, repoRoot, tasksDir, orchestrator, restartCoordinator, taskStoreKind, hub) {
  const body = requireJsonObject(await readJsonBody(req));
  if ("id" in body && body.id !== id) {
    throw new HttpError(400, "Cannot change a task's id");
  }

  if (body.status === "in-progress") {
    try {
      await assertCanMoveToInProgress(store, id);
    } catch (err) {
      if (err instanceof UnmetDependencyError || err instanceof DependencyCycleError) {
        throw new HttpError(409, err.message);
      }
      throw err;
    }
  }

  let updated;
  try {
    updated = await store.update(id, body);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 400;
    throw new HttpError(status, err.message);
  }

  if (taskStoreKind !== "db" && repoRoot && tasksDir && autoCommitCardsOnCreateFromEnv()) {
    try {
      const relativePath = path.relative(repoRoot, path.join(tasksDir, `${id}.md`));
      const changedFields = Object.keys(body).filter((key) => key !== "id");
      const message =
        changedFields.length > 0
          ? `chore(board): update card ${id} (${changedFields.join(", ")})`
          : `chore(board): update card ${id}`;
      await commitTaskFile({ repoRoot, filePath: relativePath, message });
    } catch (err) {
      // An update must never fail to save because git couldn't commit it -- see the matching
      // rationale on handleAddComment's commitTaskFile call. Leaving it untracked here just
      // reverts to the old drift-until-next-write behavior for this one update.
      console.warn(`Board: failed to commit update for ${id} (leaving it untracked):`, err.message);
    }
  }

  if (taskStoreKind === "db" && hub) {
    hub.broadcast({ type: "changed", id, task: updated });
  }

  // Done-triggered pullDevelop exists to fetch code that card commits (this repo's own, and
  // others') had pushed -- meaningless in db mode, since card writes never touch git there
  // (docs/design/cards-to-database.md, Phase 2).
  if (taskStoreKind !== "db" && updated.status === "done" && repoRoot) {
    // Fire-and-forget: pull (and any restart it triggers) must not block this response.
    pullDevelop({ repoRoot })
      .then((result) => {
        if (restartCoordinator && result && result.advanced) {
          restartCoordinator.notifyPulled({ hasActiveRuns: Boolean(orchestrator && orchestrator.hasActiveRuns()) });
        }
      })
      .catch((err) => {
        console.error("pullDevelop failed after card moved to done:", err);
      });
  }

  sendJson(res, 200, updated);
}

async function handleRunTask(orchestrator, id, res) {
  if (!orchestrator) {
    throw new HttpError(501, "Agent Runner is not configured on this server");
  }
  const task = await orchestrator.store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }
  if (!RUNNABLE_STATUSES.has(task.status)) {
    throw new HttpError(409, `Cannot run ${id}: status is "${task.status}", expected "ready", "review", or "blocked"`);
  }
  if (orchestrator.isRunning(id)) {
    throw new HttpError(409, `Task ${id} already has an active run`);
  }

  // Fire-and-forget: a run (implementer + reviewer) can take minutes. The
  // client follows progress over the board WS, not this response.
  orchestrator.runCard(id).catch((err) => {
    console.error(`Agent Runner: run failed for ${id}:`, err);
  });

  sendJson(res, 202, task);
}

/**
 * Appends a human comment to a card (Feature A). Read by the implementer on a re-run
 * (see promptBuilder's `comments` section) so a human can say "CI failed on X, please
 * fix" and have it reach the agent. Committed to git the same way card creation is,
 * so it's tracked immediately instead of sitting as untracked local state.
 */
async function handleAddComment(store, id, req, res, repoRoot, tasksDir, taskStoreKind, hub) {
  const body = requireJsonObject(await readJsonBody(req));
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    throw new HttpError(400, "text is required and must be a non-empty string");
  }
  const author = typeof body.author === "string" && body.author.trim().length > 0 ? body.author.trim() : "Anonymous";

  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }

  const comment = { author, text: body.text.trim(), timestamp: new Date().toISOString() };
  const comments = [...(task.comments ?? []), comment];

  let updated;
  try {
    updated = await store.update(id, { comments });
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  if (taskStoreKind !== "db" && repoRoot && tasksDir && autoCommitCardsOnCreateFromEnv()) {
    try {
      const relativePath = path.relative(repoRoot, path.join(tasksDir, `${id}.md`));
      await commitTaskFile({ repoRoot, filePath: relativePath, message: `chore(board): comment on card ${id}` });
    } catch (err) {
      // A comment must never fail to save because git couldn't commit it -- see the
      // matching rationale on handleCreateTask's commitTaskFile call.
      console.warn(`Board: failed to commit comment for ${id} (leaving it untracked):`, err.message);
    }
  }

  if (taskStoreKind === "db" && hub) {
    hub.broadcast({ type: "changed", id, task: updated });
  }

  sendJson(res, 201, updated);
}

/**
 * Uploads a file attachment to a card (works from a browser's FormData POST or from
 * `curl -F file=@path`). Parses the multipart body with busboy (raw Node http, no express),
 * sniffs the real mime type and rejects active markup (see resolveMimeType), writes the file
 * to `tasks/attachments/<id>/<filename>`, and records `{ filename, size, mimetype, uploaded_by,
 * uploaded_at }` metadata on the card (mirrors handleAddComment's `comments` pattern). Re-uploading
 * an existing filename REPLACES that entry in place (the file on disk is overwritten, and the
 * single matching `attachments[]` entry is updated with the new size/mimetype/uploaded_by/
 * uploaded_at) rather than appending a second, stale entry pointing at the same path -- exactly
 * one metadata entry per stored filename is an invariant. Commits both the card file and the
 * attachment in one commit either way.
 */
async function handleUploadAttachment(store, id, req, res, repoRoot, tasksDir, taskStoreKind, hub, dataDir) {
  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new HttpError(400, "Content-Type must be multipart/form-data");
  }

  const { file, fields } = await parseMultipartUpload(req, { maxBytes: attachmentMaxBytesFromEnv() });

  const safeName = sanitizeFilename(file.filename);
  if (!safeName) {
    throw new HttpError(400, "Invalid filename");
  }

  const mimetype = await resolveMimeType(file.buffer);

  const cardAttachmentsDir = path.join(attachmentsRootDir({ taskStoreKind, tasksDir, dataDir }), id);
  await fs.mkdir(cardAttachmentsDir, { recursive: true });
  const destPath = resolveAttachmentPath(cardAttachmentsDir, safeName);
  if (!destPath) {
    throw new HttpError(400, "Invalid filename");
  }
  await fs.writeFile(destPath, file.buffer);

  const uploadedBy =
    typeof fields.uploaded_by === "string" && fields.uploaded_by.trim().length > 0
      ? fields.uploaded_by.trim()
      : "Anonymous";
  const attachment = {
    filename: safeName,
    size: file.buffer.length,
    mimetype,
    uploaded_by: uploadedBy,
    uploaded_at: new Date().toISOString()
  };
  const existing = task.attachments ?? [];
  const existingIndex = existing.findIndex((a) => a.filename === safeName);
  const isReplace = existingIndex !== -1;
  const attachments = isReplace
    ? existing.map((a, i) => (i === existingIndex ? attachment : a))
    : [...existing, attachment];

  let updated;
  try {
    updated = await store.update(id, { attachments });
  } catch (err) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw new HttpError(400, err.message);
  }

  if (taskStoreKind !== "db" && repoRoot && tasksDir && autoCommitCardsOnCreateFromEnv()) {
    try {
      const cardRelPath = path.relative(repoRoot, path.join(tasksDir, `${id}.md`));
      const attachmentRelPath = path.relative(repoRoot, destPath);
      const message = isReplace
        ? `chore(board): replace attachment ${safeName} on card ${id}`
        : `chore(board): attach ${safeName} to card ${id}`;
      await commitPaths({
        repoRoot,
        filePaths: [cardRelPath, attachmentRelPath],
        message
      });
    } catch (err) {
      // An attachment must never fail to save because git couldn't commit it -- see the
      // matching rationale on handleAddComment's commitTaskFile call.
      console.warn(`Board: failed to commit attachment for ${id} (leaving it untracked):`, err.message);
    }
  }

  if (taskStoreKind === "db" && hub) {
    hub.broadcast({ type: "changed", id, task: updated });
  }

  sendJson(res, 201, updated);
}

/** Streams an attachment's bytes with the correct headers; path-traversal-safe via resolveAttachmentPath. */
async function handleDownloadAttachment(store, id, filenameRaw, tasksDir, res, taskStoreKind, dataDir) {
  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }

  let filename;
  try {
    filename = decodeURIComponent(filenameRaw);
  } catch {
    throw new HttpError(400, "Invalid filename encoding");
  }

  const cardAttachmentsDir = path.join(attachmentsRootDir({ taskStoreKind, tasksDir, dataDir }), id);
  const filePath = resolveAttachmentPath(cardAttachmentsDir, filename);
  if (!filePath) {
    throw new HttpError(400, "Invalid attachment filename");
  }

  const meta = (task.attachments ?? []).find((a) => a.filename === path.basename(filePath));
  if (!meta) {
    throw new HttpError(404, `Attachment "${filename}" not found on ${id}`);
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new HttpError(404, `Attachment "${filename}" not found on ${id}`);
    }
    throw err;
  }

  const disposition = PREVIEWABLE_IMAGE_MIMES.has(meta.mimetype) ? "inline" : "attachment";
  const encodedFilename = encodeRfc5987ValueChars(meta.filename);
  res.writeHead(200, {
    "Content-Type": meta.mimetype || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": stat.size,
    "Content-Disposition": `${disposition}; filename="${asciiFallbackFilename(meta.filename)}"; filename*=UTF-8''${encodedFilename}`
  });

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    res.on("finish", resolve);
    stream.pipe(res);
  });
}

/** Removes an attachment's file (git rm) and its metadata entry, then commits both changes together. */
async function handleRemoveAttachment(store, id, filenameRaw, res, repoRoot, tasksDir, taskStoreKind, hub, dataDir) {
  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }

  let filename;
  try {
    filename = decodeURIComponent(filenameRaw);
  } catch {
    throw new HttpError(400, "Invalid filename encoding");
  }

  const cardAttachmentsDir = path.join(attachmentsRootDir({ taskStoreKind, tasksDir, dataDir }), id);
  const filePath = resolveAttachmentPath(cardAttachmentsDir, filename);
  if (!filePath) {
    throw new HttpError(400, "Invalid attachment filename");
  }

  const existing = task.attachments ?? [];
  const meta = existing.find((a) => a.filename === path.basename(filePath));
  if (!meta) {
    throw new HttpError(404, `Attachment "${filename}" not found on ${id}`);
  }

  const attachments = existing.filter((a) => a.filename !== meta.filename);

  let updated;
  try {
    updated = await store.update(id, { attachments });
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (taskStoreKind !== "db" && repoRoot && tasksDir && autoCommitCardsOnCreateFromEnv()) {
    try {
      const cardRelPath = path.relative(repoRoot, path.join(tasksDir, `${id}.md`));
      const attachmentRelPath = path.relative(repoRoot, filePath);
      await commitPaths({
        repoRoot,
        filePaths: [cardRelPath, attachmentRelPath],
        message: `chore(board): remove attachment ${meta.filename} from card ${id}`
      });
    } catch (err) {
      console.warn(`Board: failed to commit attachment removal for ${id} (leaving it untracked):`, err.message);
    }
  }

  if (taskStoreKind === "db" && hub) {
    hub.broadcast({ type: "changed", id, task: updated });
  }

  sendJson(res, 200, updated);
}

async function handleListAgents(agentsDir, res) {
  const agents = agentsDir ? await listAssignableAgents(agentsDir) : [];
  sendJson(res, 200, agents);
}

function formatBacklogExport(tasks, date) {
  const backlog = tasks.filter((t) => t.status === "backlog");
  const count = backlog.length;
  const lines = [
    `# Backlog Export — ${date}`,
    ``,
    `Total: ${count} task${count === 1 ? "" : "s"}`,
    ``
  ];
  for (const t of backlog) {
    lines.push(`## ${t.id}: ${t.title}`);
    lines.push(`- Priority: ${t.priority}`);
    lines.push(`- Agent: ${t.agent ?? "unassigned"}`);
    lines.push(`- Phase: ${t.phase}`);
    lines.push(`- Status: ${t.status}`);
    lines.push(`- Depends on: ${t.depends_on.length > 0 ? t.depends_on.join(", ") : "none"}`);
    lines.push(``);
  }
  return lines.join("\n");
}

async function handleGitStatus(gitInfoImpl, res) {
  if (!gitInfoImpl) {
    return sendJson(res, 200, { branch: null, head: null, headTimestamp: null });
  }
  const info = await gitInfoImpl();
  sendJson(res, 200, info);
}

async function handleExportBacklog(store, res) {
  const date = todayIso();
  const tasks = await store.list();
  const text = formatBacklogExport(tasks, date);
  const filename = `backlog-${date}.txt`;
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function formatDoneExport(tasks, date) {
  const done = tasks.filter((t) => t.status === "done");
  const count = done.length;
  const lines = [
    `# Done Export — ${date}`,
    ``,
    `Total: ${count} task${count === 1 ? "" : "s"}`,
    ``
  ];
  for (const t of done) {
    lines.push(`## ${t.id}: ${t.title}`);
    lines.push(`- Priority: ${t.priority}`);
    lines.push(`- Agent: ${t.agent ?? "unassigned"}`);
    lines.push(`- Phase: ${t.phase}`);
    lines.push(``);
  }
  return lines.join("\n");
}

async function handleExportDone(store, res) {
  const date = todayIso();
  const tasks = await store.list();
  const text = formatDoneExport(tasks, date);
  const filename = `done-${date}.txt`;
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

async function handleDeleteTask(store, id, res, taskStoreKind, hub, tasksDir, dataDir) {
  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }
  if (LIVE_RUN_STATUSES.has(task.status)) {
    throw new HttpError(409, `Cannot delete ${id}: status is "${task.status}" (active run)`);
  }
  await store.remove(id);
  await removeCardAttachments({ taskStoreKind, tasksDir, dataDir, id });
  if (taskStoreKind === "db" && hub) {
    hub.broadcast({ type: "removed", id, task: null });
  }
  sendJson(res, 200, { id, deleted: true });
}

async function handleCancelTask(orchestrator, id, res) {
  if (!orchestrator) {
    throw new HttpError(501, "Agent Runner is not configured on this server");
  }
  if (!orchestrator.isRunning(id)) {
    throw new HttpError(409, `No active run for ${id}`);
  }
  await orchestrator.cancelRun(id);
  const task = await orchestrator.store.get(id);
  sendJson(res, 200, task);
}

export function createRequestListener({
  store,
  idAllocator,
  orchestrator,
  agentsDir,
  repoRoot,
  tasksDir,
  dataDir,
  taskStoreKind = "fs",
  hub,
  restartCoordinator,
  gitInfoImpl
}) {
  return async function requestListener(req, res) {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      const idMatch = TASK_ID_PATH_RE.exec(pathname);
      const runMatch = TASK_RUN_PATH_RE.exec(pathname);
      const cancelMatch = TASK_CANCEL_PATH_RE.exec(pathname);
      const commentsMatch = TASK_COMMENTS_PATH_RE.exec(pathname);
      const attachmentsMatch = TASK_ATTACHMENTS_PATH_RE.exec(pathname);
      const attachmentFileMatch = TASK_ATTACHMENT_FILE_PATH_RE.exec(pathname);

      if (pathname === GIT_STATUS_PATH && req.method === "GET") {
        return await handleGitStatus(gitInfoImpl, res);
      }
      if (pathname === AGENTS_PATH && req.method === "GET") {
        return await handleListAgents(agentsDir, res);
      }
      if (pathname === BACKLOG_EXPORT_PATH && req.method === "GET") {
        return await handleExportBacklog(store, res);
      }
      if (pathname === DONE_EXPORT_PATH && req.method === "GET") {
        return await handleExportDone(store, res);
      }
      if (pathname === "/api/tasks" && req.method === "GET") {
        return await handleListTasks(store, res);
      }
      if (pathname === "/api/tasks" && req.method === "POST") {
        return await handleCreateTask(store, idAllocator, req, res, repoRoot, tasksDir, taskStoreKind, hub);
      }
      if (idMatch && req.method === "GET") {
        return await handleGetTask(store, idMatch[1], res);
      }
      if (idMatch && req.method === "PATCH") {
        return await handlePatchTask(
          store,
          idMatch[1],
          req,
          res,
          repoRoot,
          tasksDir,
          orchestrator,
          restartCoordinator,
          taskStoreKind,
          hub
        );
      }
      if (idMatch && req.method === "DELETE") {
        return await handleDeleteTask(store, idMatch[1], res, taskStoreKind, hub, tasksDir, dataDir);
      }
      if (runMatch && req.method === "POST") {
        return await handleRunTask(orchestrator, runMatch[1], res);
      }
      if (cancelMatch && req.method === "POST") {
        return await handleCancelTask(orchestrator, cancelMatch[1], res);
      }
      if (commentsMatch && req.method === "POST") {
        return await handleAddComment(store, commentsMatch[1], req, res, repoRoot, tasksDir, taskStoreKind, hub);
      }
      if (attachmentsMatch && req.method === "POST") {
        return await handleUploadAttachment(store, attachmentsMatch[1], req, res, repoRoot, tasksDir, taskStoreKind, hub, dataDir);
      }
      if (attachmentFileMatch && req.method === "GET") {
        return await handleDownloadAttachment(
          store,
          attachmentFileMatch[1],
          attachmentFileMatch[2],
          tasksDir,
          res,
          taskStoreKind,
          dataDir
        );
      }
      if (attachmentFileMatch && req.method === "DELETE") {
        return await handleRemoveAttachment(
          store,
          attachmentFileMatch[1],
          attachmentFileMatch[2],
          res,
          repoRoot,
          tasksDir,
          taskStoreKind,
          hub,
          dataDir
        );
      }
      if (
        pathname === GIT_STATUS_PATH ||
        pathname === AGENTS_PATH ||
        pathname === "/api/tasks" ||
        pathname === BACKLOG_EXPORT_PATH ||
        pathname === DONE_EXPORT_PATH ||
        idMatch ||
        runMatch ||
        cancelMatch ||
        commentsMatch ||
        attachmentsMatch ||
        attachmentFileMatch
      ) {
        throw new HttpError(405, `Method ${req.method} not allowed on ${pathname}`);
      }
      throw new HttpError(404, "Not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) {
        console.error(err);
      }
      sendJson(res, status, { error: err.message || "Internal server error" });
    }
  };
}

export function startHttpServer({
  store,
  idAllocator,
  orchestrator,
  agentsDir,
  repoRoot,
  tasksDir,
  dataDir,
  taskStoreKind = "fs",
  hub,
  restartCoordinator,
  gitInfoImpl,
  port = 0,
  host = "127.0.0.1"
}) {
  if (host !== "127.0.0.1") {
    throw new Error("HTTP API must bind to 127.0.0.1 only");
  }
  const server = http.createServer(
    createRequestListener({
      store,
      idAllocator,
      orchestrator,
      agentsDir,
      repoRoot,
      tasksDir,
      dataDir,
      taskStoreKind,
      hub,
      restartCoordinator,
      gitInfoImpl
    })
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
