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
import { launchCardRun, CardLaunchError } from "../runner/cardLaunch.js";
import { artifactCacheRootFor, clearPreservedArtifacts } from "../runner/artifactPreservation.js";
import {
  actorFromHeaders,
  approvalRecord,
  approvalRecordedComment,
  approvalVerdict,
  isAgentActor,
  isApprovalMarker,
  needsApproval,
  resolveAuthor,
  resolveHumanActor,
  ApprovalRequiredError,
  APPROVAL_RECORD_FIELDS,
  PARKED_STATUS,
  REQUIRES_APPROVAL_FIELD
} from "../lib/approvalGate.js";
import { approvalProvenanceStaleNotice } from "../lib/approvalProvenanceNotice.js";

const TASK_ID_PATH_RE = /^\/api\/tasks\/([^/]+)$/;
const TASK_APPROVAL_PATH_RE = /^\/api\/tasks\/([^/]+)\/approval$/;
const TASK_RUN_PATH_RE = /^\/api\/tasks\/([^/]+)\/run$/;
const TASK_CANCEL_PATH_RE = /^\/api\/tasks\/([^/]+)\/cancel$/;
const TASK_COMMENTS_PATH_RE = /^\/api\/tasks\/([^/]+)\/comments$/;
const TASK_ATTACHMENTS_PATH_RE = /^\/api\/tasks\/([^/]+)\/attachments$/;
const TASK_ATTACHMENT_FILE_PATH_RE = /^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/;
const AGENTS_PATH = "/api/agents";
const BACKLOG_EXPORT_PATH = "/api/tasks/export/backlog";
const DONE_EXPORT_PATH = "/api/tasks/export/done";
const GIT_STATUS_PATH = "/api/git/status";
const HEALTH_PATH = "/api/health";
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
// Exported for reuse by tools/board/src/lib/referenceQuarantine.js (T-0276) -- the
// reference-sourcing wrapper's byte-quarantine gate reuses this exact allowlist rather than
// defining a second one, per that card's design pointer to this module.
export const PREVIEWABLE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const REJECTED_SNIFFED_MIMES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml"]);
const MARKUP_SNIFF_RE = /<\s*(?:svg|script|html|!doctype\s+html)/i;

const DEFAULTS = {
  status: "backlog",
  priority: "P2",
  agent: "generic",
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
    // Accepted at create time so a direction card can be gated in one call rather than the
    // POST-then-PATCH dance `deliverable_type` still needs. Only the *flag* is read from the
    // request: the approval record below is pinned to null regardless of what was sent, so a
    // card can never be born pre-approved.
    [REQUIRES_APPROVAL_FIELD]: body[REQUIRES_APPROVAL_FIELD] === true,
    approved_by: null,
    approved_at: null,
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
 * The board's single, authoritative approval verdict for a card (T-0286, docs/decision-log.md
 * DL-27, approvalGate.js's `approvalVerdict`). A consumer that needs "is this asset/card
 * approved?" calls this instead of mirroring the board's approval into -- and then having to
 * keep in sync with -- a second record such as `ASSET_PROVENANCE.md`'s prose.
 */
async function handleGetApproval(store, id, res) {
  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }
  sendJson(res, 200, approvalVerdict(task));
}

/** Statuses a card never comes back from, and so never needs its preserved artifacts again. */
const ARTIFACT_TERMINAL_STATUSES = new Set(["done", "retired"]);

/**
 * Drops a card's preserved-artifact cache once it reaches a terminal status. Non-throwing: a card
 * must never fail to move to Done because a cache directory could not be removed -- the worst
 * case is disk that pruneArtifactCache's LRU bound reclaims later.
 *
 * Reads `worktreesDir` off the orchestrator rather than deriving it from repoRoot, so a board
 * configured with a non-default worktrees location purges the cache it actually writes to.
 */
async function purgeArtifactCacheIfTerminal({ orchestrator, id, status }) {
  if (!ARTIFACT_TERMINAL_STATUSES.has(status)) return;
  const worktreesDir = orchestrator?.worktreesDir;
  if (!worktreesDir) return;
  try {
    await clearPreservedArtifacts({ cacheRoot: artifactCacheRootFor({ worktreesDir }), cardId: id });
  } catch (err) {
    console.warn(`Board: failed to clear the preserved-artifact cache for ${id}:`, err.message);
  }
}

/**
 * The HTTP half of the human direction-approval gate (`approvalGate.js`), applied to every
 * `PATCH /api/tasks/:id` before the update is written. Three rules, in order:
 *
 * 1. `approved_by` / `approved_at` are *derived*, never supplied. A request that sets them is
 *    rejected outright rather than trusted -- the whole point of the record is that it says
 *    what actually happened, so the only writer is this file's own approval paths.
 * 2. An agent may not flip `requires_approval` off. Removing the gate is the same act as
 *    approving through it, and neither is an agent's to make.
 * 3. Moving an unapproved `requires_approval` card to `done` is the approval. From a human it
 *    is allowed and stamped with who did it; from an agent it is a 409. This is the rule that
 *    keeps dependents blocked: `dependencyGuard` counts only `done`/`retired`, so this handler
 *    deciding who may write `done` *is* the gate on when downstream cards unblock.
 *
 * Mutates `body` in place to add the approval record, so the single `store.update` below still
 * writes the status and the record together -- there is no window where a card is `done` with
 * no recorded approver.
 */
async function applyApprovalGateToPatch({ store, id, body, actor }) {
  for (const field of APPROVAL_RECORD_FIELDS) {
    if (field in body) {
      throw new HttpError(
        400,
        `Cannot set ${field} directly -- the approval record is written by the board when a human approves the card`
      );
    }
  }

  const agentActor = isAgentActor(actor);
  if (agentActor && REQUIRES_APPROVAL_FIELD in body) {
    throw new HttpError(
      409,
      `Cannot change ${REQUIRES_APPROVAL_FIELD} on ${id}: only a human may add or remove a card's approval gate`
    );
  }

  if (body.status !== "done") return;

  const task = await store.get(id);
  // A missing card is store.update's 404 to report, not this gate's -- fall through untouched.
  if (!task || !needsApproval(task)) return;

  if (agentActor) {
    throw new HttpError(409, new ApprovalRequiredError(id).message);
  }
  // `actor` here is a transport identity (`board-ui` for a drag in the UI, `unknown` for a
  // bare curl). Recording either verbatim says as little as "Anonymous" did -- resolve it to
  // the configured operator. `resolveHumanActor` cannot return null on this line: the agent
  // case threw above.
  Object.assign(body, approvalRecord({ actor: resolveHumanActor(actor) }));
}

/**
 * The live counterpart to `checkApprovalProvenanceDrift.js`'s CI check (T-0286, docs/decision-log.md
 * DL-27), called right after either approval write path (AP-3's drag-to-Done, AP-4's "APPROVED"
 * comment) records a fresh approval on `task`. Reads the real `ASSET_PROVENANCE.md` in `repoRoot`
 * -- the one thing CI's fresh-checkout runner can never do for a card that lives only in this
 * board's own db -- and, if its prose still contradicts the approval that was just recorded,
 * returns a ready-to-append informational comment. Returns `null` when there's nothing to flag.
 * Never touches `ASSET_PROVENANCE.md`, never blocks or alters the approval itself: a failure here
 * is swallowed by the caller exactly like every other best-effort side effect on this path
 * (see `commitTaskFile`'s call sites above).
 */
async function approvalProvenanceNoticeComment({ repoRoot, task }) {
  const notice = await approvalProvenanceStaleNotice({ repoRoot, task });
  if (!notice) return null;
  return { author: "assembled-board", text: notice, timestamp: new Date().toISOString() };
}

/**
 * Handles ordinary card edits (drag between board columns, editing title/priority/agent/etc.
 * via the UI) -- the one route every routine field/status change goes through, including the
 * Review -> Done flip. Commits the updated card file the same way create/comments/attachments
 * do (see their matching rationale), so an update never leaves repoRoot's working tree dirty.
 * That matters here specifically: the Done-triggered `pullDevelop` below needs a clean tree to
 * merge, and a prior update's uncommitted diff was exactly what made that pull start failing
 * with "local changes ... would be overwritten by merge" once origin touched the same file.
 *
 * This is also the *manual approval* path of the human direction-approval gate
 * (`approvalGate.js`): dragging a `requires_approval` card into the Done column is a human act
 * and counts as the approval, which this handler records on the card as `approved_by` /
 * `approved_at`. An agent-originated PATCH doing the same thing is refused with 409 -- see
 * `applyApprovalGateToPatch`.
 */
async function handlePatchTask(store, id, req, res, repoRoot, tasksDir, orchestrator, restartCoordinator, taskStoreKind, hub) {
  const body = requireJsonObject(await readJsonBody(req));
  if ("id" in body && body.id !== id) {
    throw new HttpError(400, "Cannot change a task's id");
  }
  const actor = actorFromHeaders(req.headers);
  await applyApprovalGateToPatch({ store, id, body, actor });

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

  if ("approved_by" in body && repoRoot) {
    try {
      const notice = await approvalProvenanceNoticeComment({ repoRoot, task: updated });
      if (notice) {
        updated = await store.update(id, { comments: [...(updated.comments ?? []), notice] });
      }
    } catch (err) {
      // Same posture as the commit try/catch below: a check against a *human-readable* prose
      // file must never fail the approval it's reporting on.
      console.warn(`Board: failed to check ASSET_PROVENANCE.md staleness for ${id}:`, err.message);
    }
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

  await applyTerminalStatusEffects({
    orchestrator,
    restartCoordinator,
    id,
    status: updated.status,
    repoRoot
  });

  sendJson(res, 200, updated);
}

async function handleRunTask(orchestrator, id, res) {
  // Thin adapter over the one shared launch path (`cardLaunch.js`): every guard -- runnable
  // status, the non-executable `dispatch` sentinel, the already-running check, and
  // `assertCanMoveToInProgress` -- lives there, so the in-process auto-launch poller starts a
  // card through the exact same code this endpoint does rather than a parallel implementation.
  let task;
  try {
    task = await launchCardRun({ orchestrator, id });
  } catch (err) {
    if (err instanceof CardLaunchError) {
      throw new HttpError(err.statusCode, err.message);
    }
    throw err;
  }

  // 202: the run (implementer + reviewer) takes minutes and is already in flight; the client
  // follows progress over the board WS, not this response.
  sendJson(res, 202, task);
}

/**
 * Decides whether an incoming comment is a human approval of an approval-gated card, and if so
 * builds the extra patch that completes it. Every condition has to hold, and each one is here
 * for its own reason:
 *
 * - the card is flagged `requires_approval` and not already approved -- otherwise there is
 *   nothing to approve, and the marker is just a word someone typed;
 * - the card is sitting in the parked status -- an "APPROVED" on a card that is still being
 *   worked on approves nothing, and silently completing a `ready`/`in-progress` card out from
 *   under its own run would be worse than ignoring the comment;
 * - the comment's first non-empty line is exactly the marker (`isApprovalMarker`);
 * - **and both the request actor and the comment's author are human.** Both, not either: the
 *   actor catches an agent posting under a human's name, the author catches the board's own
 *   `assembled-board` comments (the parked notice itself contains the word "APPROVE") and any
 *   future in-process writer.
 *
 * Returns `null` when the comment is an ordinary comment, which is the overwhelmingly common
 * case and stays entirely unaffected.
 */
function approvalPatchForComment({ task, text, author, actor }) {
  if (!needsApproval(task)) return null;
  if (task.status !== PARKED_STATUS) return null;
  if (!isApprovalMarker(text)) return null;
  if (isAgentActor(actor) || isAgentActor(author)) return null;
  return approvalRecord({ actor: author });
}

/**
 * Fires the side effects that follow a card reaching a terminal status, shared by the two
 * routes that can put it there: a `PATCH {status: "done"}` and a comment that approves an
 * approval-gated card. Extracted when the second route appeared -- an approval that skipped
 * the deploy pull would be a silently different kind of "done" than a drag to the Done column
 * (docs/board-invariants.md PULL-1 is exactly the bug that shape of divergence causes).
 */
async function applyTerminalStatusEffects({ orchestrator, restartCoordinator, id, status, repoRoot }) {
  // A card that has landed is never going to be re-run, so the untracked artifacts held for it
  // across worktree reclaims (LoRA checkpoints, generated output -- see artifactPreservation.js)
  // have no further purpose and are the largest thing the board keeps on disk per card. This is
  // the primary cleanup; pruneArtifactCache's LRU bound is only the backstop for cards that
  // never reach a terminal status at all.
  await purgeArtifactCacheIfTerminal({ orchestrator, id, status });

  // Done-triggered pullDevelop exists to fetch code that OTHER merged PRs have pushed to
  // origin/develop, so it must fire in every task-store mode: `repoRoot` is still a real
  // git checkout of develop even in db mode (docs/design/cards-to-database.md, Phase 2
  // keeps tasks/ git-tracked alongside the DB). Whether *this card's own write* touches
  // git is unrelated and handled separately by each caller -- conflating the two previously
  // gated this off entirely in db mode, silently killing the live board's only auto-deploy
  // path after the 2026-08-07 cutover (docs/board-invariants.md PULL-1).
  if (status !== "done" || !repoRoot) return;
  // Fire-and-forget: pull (and any restart it triggers) must not block the response.
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

/**
 * Appends a human comment to a card (Feature A). Read by the implementer on a re-run
 * (see promptBuilder's `comments` section) so a human can say "CI failed on X, please
 * fix" and have it reach the agent. Committed to git the same way card creation is,
 * so it's tracked immediately instead of sitting as untracked local state.
 *
 * This is also the *comment* approval path of the human direction-approval gate: a human
 * commenting `APPROVED` (or `/approve`) on a parked approval-gated card completes it, which is
 * the explicit, logged act Dennie asked for -- the approval and its reasoning end up in the
 * same place, on the card, rather than as an anonymous drag between columns. See
 * `approvalPatchForComment` for exactly what counts.
 */
async function handleAddComment(
  store,
  id,
  req,
  res,
  repoRoot,
  tasksDir,
  taskStoreKind,
  hub,
  orchestrator,
  restartCoordinator
) {
  const body = requireJsonObject(await readJsonBody(req));
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    throw new HttpError(400, "text is required and must be a non-empty string");
  }
  // The board UI sends text only, so this default is what a person's comment is filed under --
  // and, for an approval comment, what lands in `approved_by`. It used to be the literal
  // "Anonymous", which recorded an approval as having come from nobody in particular and so
  // defeated the point of recording who approved. `resolveAuthor` resolves a UI action to the
  // configured operator; an agent-originated one can never inherit that name.
  const author = resolveAuthor({ author: body.author, actor: actorFromHeaders(req.headers) });

  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }

  const text = body.text.trim();
  const comment = { author, text, timestamp: new Date().toISOString() };
  const comments = [...(task.comments ?? []), comment];

  const approval = approvalPatchForComment({
    task,
    text,
    author,
    actor: actorFromHeaders(req.headers)
  });
  if (approval) {
    // The approval is written in the SAME update as the comment that granted it, so the card
    // can never be `done` with no record of who approved it (nor the reverse).
    comments.push({
      author: "assembled-board",
      text: approvalRecordedComment({ actor: author, approvedAt: approval.approved_at }),
      timestamp: approval.approved_at
    });

    if (repoRoot) {
      try {
        const notice = await approvalProvenanceNoticeComment({ repoRoot, task: { ...task, ...approval } });
        if (notice) comments.push(notice);
      } catch (err) {
        // Same posture as handlePatchTask's matching check: never fail the approval itself.
        console.warn(`Board: failed to check ASSET_PROVENANCE.md staleness for ${id}:`, err.message);
      }
    }
  }

  let updated;
  try {
    updated = await store.update(id, approval ? { comments, status: "done", ...approval } : { comments });
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

  if (approval) {
    // An approval-by-comment lands the card in `done` exactly as a drag to the Done column
    // does, so it owes the same follow-through -- artifact-cache purge and the deploy pull.
    await applyTerminalStatusEffects({
      orchestrator,
      restartCoordinator,
      id,
      status: updated.status,
      repoRoot
    });
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

  // Same resolution as a comment's author (see handleAddComment): a UI upload is the operator,
  // an agent upload never is. Agents already pass `uploaded_by` explicitly on the one mutating
  // route they hold, so this only changes what an omitted value falls back to.
  const uploadedBy = resolveAuthor({
    author: fields.uploaded_by,
    actor: actorFromHeaders(req.headers)
  });
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

/**
 * Liveness probe. Answers from process state ONLY -- no store read, no git call, no
 * filesystem access.
 *
 * That constraint is the whole design. The two callers that ask "is the board up?" are a
 * human at a terminal and the deploy/restart tooling, and both ask precisely when the board
 * is least healthy. A probe that read the task store would report the board *down* every time
 * SQLite is briefly locked -- the nightly backup, an integrity-check sweep -- flapping on
 * something with no bearing on whether the process is serving requests. So it reports only
 * what is already in memory:
 *
 *  - `taskStore`   the configured mode (fs/db), so a probe can tell which one it is talking
 *                  to without querying it.
 *  - `activeRuns`  the orchestrator's in-process run-set size as a boolean -- the same idle
 *                  signal `deploy.sh` and the orphan reaper care about. Previously the only
 *                  way to ask was to fetch and parse all ~200 cards from `/api/tasks` and
 *                  scan for `in-progress`/`validation`; this is that answer for free, and
 *                  from the orchestrator's own state rather than inferred from statuses.
 *  - `uptimeSeconds`  distinguishes "up" from "just restarted", which is exactly what you
 *                  want to know after a deploy.
 *
 * `orchestrator` is optional (plenty of callers construct the API without one), hence the
 * guard rather than an assumption.
 */
function handleHealth(res, { taskStoreKind, orchestrator }) {
  sendJson(res, 200, {
    status: "ok",
    taskStore: taskStoreKind,
    activeRuns: Boolean(orchestrator && orchestrator.hasActiveRuns()),
    uptimeSeconds: Math.round(process.uptime())
  });
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
      const approvalMatch = TASK_APPROVAL_PATH_RE.exec(pathname);
      const runMatch = TASK_RUN_PATH_RE.exec(pathname);
      const cancelMatch = TASK_CANCEL_PATH_RE.exec(pathname);
      const commentsMatch = TASK_COMMENTS_PATH_RE.exec(pathname);
      const attachmentsMatch = TASK_ATTACHMENTS_PATH_RE.exec(pathname);
      const attachmentFileMatch = TASK_ATTACHMENT_FILE_PATH_RE.exec(pathname);

      // First route in the chain, deliberately: a liveness probe should do the least work of
      // anything the server serves, and should not sit behind any check that could itself be
      // what is unhealthy. Nothing above it does any work either, so this is cheap ordering
      // rather than a load-bearing guarantee -- but it is the ordering to keep.
      if (pathname === HEALTH_PATH && req.method === "GET") {
        return handleHealth(res, { taskStoreKind, orchestrator });
      }
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
      if (approvalMatch && req.method === "GET") {
        return await handleGetApproval(store, approvalMatch[1], res);
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
        return await handleAddComment(
          store,
          commentsMatch[1],
          req,
          res,
          repoRoot,
          tasksDir,
          taskStoreKind,
          hub,
          orchestrator,
          restartCoordinator
        );
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
        pathname === HEALTH_PATH ||
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
