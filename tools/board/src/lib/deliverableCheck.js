import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { checkFindingWithEvidence, readSection, parseFindingEvidencePaths } from "./preRegisteredFinding.js";
import { DEFAULT_EVIDENCE_ROOT } from "./evidencePromotion.js";

const execFileAsync = promisify(execFile);

async function defaultFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** `git`'s own blob content hash -- `sha1("blob " + byteLength + "\0" + content)`. */
function gitBlobHash(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const LFS_POINTER_SIGNATURE = "version https://git-lfs.github.com/spec/v1";
/** Real Git LFS pointer files are ~130 bytes; this is a generous ceiling before bothering to read blob content. */
const LFS_POINTER_MAX_BYTES = 1024;

/**
 * Extracts the `oid sha256:<hex>` a Git LFS pointer file declares, or `null` if `content` isn't
 * one. `git`'s own committed blob for an LFS-tracked path is this pointer text, not the real
 * asset bytes (those live in LFS storage) -- see `defaultListCommittedBlobs`'s docstring for why
 * that makes plain blob-hash matching miss every genuine LFS deliverable.
 */
function parseLfsPointerOid(content) {
  if (!content.startsWith(LFS_POINTER_SIGNATURE)) return null;
  const match = content.match(/^oid sha256:([0-9a-f]{64})$/m);
  return match ? match[1] : null;
}

/**
 * T-0352 fix: every blob `git` has actually committed under `repoRoot`, on the current branch
 * (`git ls-tree -r HEAD`), as `{ hash, path }` pairs -- path is load-bearing, not incidental, see
 * `isUnderEvidenceRoot` below. Failing/erroring (not a git repo, `git` unavailable) returns `[]`
 * rather than throwing -- fail closed, since an empty set makes the non-opt-in fallback check
 * below FAIL rather than silently skip, which is the safer default for a gate whose whole point
 * is refusing to take "some attachment exists somewhere" as proof of a deliverable.
 *
 * Content hashes, not filenames: an earlier version of this fallback matched by basename alone
 * and was caught empirically on the real T-0351 card -- one of its evidence attachments happens
 * to be named `README.md` (a generic evidence-summary name, uploaded from
 * `docs/assets/evidence/T-0351/README.md`), which coincidentally collided with this repo's own
 * committed root `README.md` and made the gate pass for the wrong reason. Matching by content
 * closes that hole: a same-named-but-different file can never satisfy it, only a byte-identical
 * one can.
 *
 * Git-LFS-tracked paths get an extra `lfsOid` field. This repo puts several genuine deliverable
 * kinds under LFS (`assets/final/audio/**`, `assets/final/lora/*.safetensors`, see
 * `.gitattributes`), and for those, the blob `git` actually committed is the LFS *pointer* text
 * (`version https://git-lfs.github.com/spec/v1\noid sha256:...\nsize ...`), never the real asset
 * bytes -- those live in LFS storage, not the git object database. A plain blob-hash comparison
 * against an attachment holding the real bytes can never match a pointer blob, so a genuinely
 * produced, genuinely committed LFS deliverable would FAIL this gate for the same reason it's
 * supposed to catch a *missing* one -- the T-0352 iter-3 reviewer's false positive. Entries under
 * `LFS_POINTER_MAX_BYTES` get their content read and sniffed for the pointer signature so
 * `hasCommittedAttachment` can additionally match an attachment by sha256 against the oid the
 * pointer declares, which is the real asset's actual content hash.
 */
async function defaultListCommittedBlobs(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "ls-tree", "-r", "-l", "HEAD"]);
    const entries = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tabIndex = line.indexOf("\t");
        if (tabIndex === -1) return null;
        const fields = line.slice(0, tabIndex).trim().split(/\s+/);
        const hash = fields[2];
        const size = Number(fields[3]);
        const filePath = line.slice(tabIndex + 1);
        return hash && filePath ? { hash, path: filePath, size } : null;
      })
      .filter(Boolean);

    return await Promise.all(
      entries.map(async ({ hash, path: filePath, size }) => {
        if (!Number.isFinite(size) || size > LFS_POINTER_MAX_BYTES) {
          return { hash, path: filePath };
        }
        try {
          const { stdout: content } = await execFileAsync("git", ["-C", repoRoot, "cat-file", "-p", hash]);
          const lfsOid = parseLfsPointerOid(content);
          return lfsOid ? { hash, path: filePath, lfsOid } : { hash, path: filePath };
        } catch {
          return { hash, path: filePath };
        }
      })
    );
  } catch {
    return [];
  }
}

/**
 * Whether `filePath` (a `git ls-tree` path, always `/`-separated) lives under `evidenceRoot`
 * (`docs/assets/evidence` by default -- `evidencePromotion.js`'s own `DEFAULT_EVIDENCE_ROOT`,
 * T-0314's committed-evidence convention). This is the fix for the fallback's actual T-0351
 * false positive: T-0314's evidence-promotion mechanism routinely commits a run's cited attempt
 * frames under this root so they survive worktree removal, so "some attachment's content matches
 * a committed blob" is true for nearly every card that follows that convention, evidence or not.
 * Excluding the evidence root is what makes the fallback mean "a deliverable was committed
 * *somewhere other than evidence*", not merely "evidence was promoted" -- the two routinely
 * coincide in exactly the case this check exists to catch.
 */
function isUnderEvidenceRoot(filePath, evidenceRoot) {
  return filePath === evidenceRoot || filePath.startsWith(`${evidenceRoot}/`);
}

/**
 * T-0352: `checkDeliverable` used to treat "some attachments recorded and present on disk" as
 * proof a card's deliverable existed -- but an attachment is board-side evidence storage, not a
 * claim about what's actually committed. A run that attaches its failed-attempt/evidence PNGs
 * (exactly what the board attachments API is *for* -- see .claude/rules/assets.md and T-0314's
 * evidence-promotion mechanism) satisfies that check with no deliverable ever produced; this is
 * the T-0351 regression -- the gate exited 0 on six evidence PNGs with no master sheet ever
 * committed, and it took a human reading the filesystem by hand to catch it twice in one day.
 *
 * Two routes now distinguish the deliverable from evidence, in order of precision:
 *
 * 1. `"## Deliverable"` (opt-in, precise): reuses the exact citation convention T-0342's
 *    `"## Finding"` section already established (`parseFindingEvidencePaths`: a backtick-quoted,
 *    extensioned path) -- a card names the committed path(s) its deliverable is expected to land
 *    at, and this check verifies each one is a real file under `repoRoot`, independent of how
 *    many attachments are recorded.
 * 2. The non-opt-in fallback below (`hasCommittedAttachment`), used whenever a card has no
 *    parseable `"## Deliverable"` section: at least one recorded attachment's *content* must
 *    match a blob `git` actually has committed somewhere under `repoRoot`, at a path outside the
 *    evidence root (`docs/assets/evidence`, `evidencePromotion.js`'s `DEFAULT_EVIDENCE_ROOT`) --
 *    not merely its filename (an earlier version of this fallback matched by basename and was
 *    caught empirically colliding on the real T-0351 card, see `defaultListCommittedBlobs`'s own
 *    docstring), and not merely *any* committed content (a still-later version matched content
 *    with no path awareness at all and was caught empirically failing to actually fail on the
 *    real T-0351 card a second time: T-0314's own evidence-promotion mechanism routinely commits
 *    a run's cited attempt frames under the evidence root, so "some attachment matches something
 *    committed" was true precisely because the evidence had been promoted, never because a
 *    deliverable existed -- see `isUnderEvidenceRoot`'s own docstring). This is what closes the
 *    hole for every card that never adopts the `"## Deliverable"` convention -- a still-earlier
 *    version of this fix made the whole check opt-in, so the exact T-0351 card (which has no
 *    `"## Deliverable"` section) still passed on attachment-count alone; see the T-0352
 *    reviewer's FAIL for that empirical repro (`checkDeliverable.js T-0351 --require-artifact`
 *    still exiting 0). Content-matching outside the evidence root, rather than requiring a
 *    declared path, is deliberately coarser than route 1 -- it only proves *something* attached
 *    was actually committed somewhere that isn't the evidence convention, not that a specific
 *    claimed path exists -- but that coarseness is exactly what makes it apply with no card-side
 *    action required, which a "necessary but not sufficient" mechanical backstop needs in order
 *    to actually backstop anything.
 */
export const DELIVERABLE_HEADING = "## Deliverable";

function parseDeclaredDeliverablePaths(body) {
  return parseFindingEvidencePaths(readSection(body, DELIVERABLE_HEADING));
}

/**
 * Whether any recorded attachment's on-disk content matches a blob `git` has actually committed
 * under `repoRoot`, at a path outside `evidenceRoot` -- see `isUnderEvidenceRoot`'s docstring for
 * why a match confined to the evidence root doesn't count.
 *
 * Two ways to match: the attachment's own git blob hash against a committed blob's hash, or (for
 * a committed path that's a Git LFS pointer, see `defaultListCommittedBlobs`'s docstring) the
 * attachment's sha256 against the oid the pointer declares -- the pointer blob's git hash can
 * never equal the real asset bytes' git hash, since git only ever committed the pointer text.
 */
async function hasCommittedAttachment(task, attachments, attachmentsDir, repoRoot, listCommittedBlobs, evidenceRoot) {
  if (!attachmentsDir) return false;
  const committedBlobs = await listCommittedBlobs(repoRoot);
  const nonEvidenceBlobs = committedBlobs.filter((blob) => !isUnderEvidenceRoot(blob.path, evidenceRoot));
  const nonEvidenceHashes = new Set(nonEvidenceBlobs.map((blob) => blob.hash));
  const nonEvidenceLfsOids = new Set(nonEvidenceBlobs.filter((blob) => blob.lfsOid).map((blob) => blob.lfsOid));
  if (nonEvidenceHashes.size === 0 && nonEvidenceLfsOids.size === 0) return false;
  for (const attachment of attachments) {
    try {
      const bytes = await fs.readFile(path.join(attachmentsDir, task.id, attachment.filename));
      if (nonEvidenceHashes.has(gitBlobHash(bytes))) return true;
      if (nonEvidenceLfsOids.size > 0 && nonEvidenceLfsOids.has(createHash("sha256").update(bytes).digest("hex"))) {
        return true;
      }
    } catch {
      // Unreadable attachment -- already reported by the attachmentsDir cross-check above; doesn't count as a match here.
    }
  }
  return false;
}

/**
 * Verifies a card whose `deliverable_type` is "artifact" actually produced
 * the artifact it claims -- not just code that could produce one. A card's
 * `attachments[]` frontmatter (populated only by a real
 * `POST /api/tasks/:id/attachments` call, never by an implementer editing
 * `tasks/**` directly -- implementers have no Write/Edit access there) is
 * the one place a real, board-recorded deliverable shows up; an "artifact"
 * card with an empty attachments list is exactly the T-0136 failure mode:
 * an uploader CLI with fully mocked, green tests that never actually
 * uploaded anything. When `attachmentsDir` is supplied, each recorded
 * attachment is additionally cross-checked against the file it claims
 * exists on disk (`tasks/attachments/<id>/<filename>`, per the attachments
 * feature) -- a frontmatter entry with no backing file is the same failure
 * mode by a different route. A `deliverable_type` other than "artifact"
 * (the default, "code") is not applicable -- this check has nothing to say
 * about code-deliverable cards -- unless `requireArtifact` is passed.
 *
 * `requireArtifact` overrides that default-"code" exemption: pass `true`
 * when the caller has independent evidence (not the card's own
 * self-reported `deliverable_type`) that this card must have a produced
 * deliverable attached. `verifyRouter.js`'s `resolveDeliverableRoute` sets
 * this when the diff itself adds/updates a file under a known
 * artifact-producing path (`assets/final/**`, `assets/src/concept/**`,
 * `assets/src/keyart/**`) -- the mechanical backstop for the pattern where
 * several art/audio cards (character sheets, concept art, an ambience bed)
 * were committed straight to the repo tagged `deliverable_type: "code"`
 * and never attached, so the plain `deliverable_type`-gated check above
 * never even ran for them.
 *
 * T-0342: when a genuine `deliverable_type: "artifact"` card (never a
 * `requireArtifact`-only diff-triggered one) has no valid attachment, it gets one more
 * chance before failing -- `checkFindingWithEvidence` (preRegisteredFinding.js), which PASSes
 * a card that pre-registered an experiment (checked against `beforeBody`, the task's body
 * *before* this run -- never the current body, so pre-registration can't be added retroactively
 * to rescue an empty run) and whose current body records a decisive, evidenced finding instead of
 * a promoted artifact. `beforeBody`/`repoRoot` are optional: omitting either simply skips this
 * route and preserves the exact pre-T-0342 failure behaviour.
 */
export async function checkDeliverable(
  task,
  {
    attachmentsDir,
    requireArtifact = false,
    beforeBody,
    repoRoot,
    fileExists = defaultFileExists,
    listCommittedBlobs = defaultListCommittedBlobs,
    evidenceRoot = DEFAULT_EVIDENCE_ROOT
  } = {}
) {
  if (!task || (task.deliverable_type !== "artifact" && !requireArtifact)) {
    return { ok: true, applicable: false, errors: [] };
  }

  const errors = [];
  const attachments = Array.isArray(task.attachments) ? task.attachments : [];
  let attachmentsOk = attachments.length > 0;

  if (attachments.length === 0) {
    errors.push(
      `Card ${task.id} is deliverable_type: "artifact" but has no attachments recorded -- code that could produce the deliverable is not the deliverable itself.`
    );
  } else if (attachmentsDir) {
    for (const attachment of attachments) {
      const filePath = path.join(attachmentsDir, task.id, attachment.filename);
      if (!(await fileExists(filePath))) {
        errors.push(
          `Attachment "${attachment.filename}" is recorded in ${task.id}'s frontmatter but the file does not exist at ${filePath}.`
        );
        attachmentsOk = false;
      }
    }
  }

  if (repoRoot) {
    const declaredPaths = parseDeclaredDeliverablePaths(task.body ?? "");
    if (declaredPaths.length > 0) {
      for (const declaredPath of declaredPaths) {
        if (!(await fileExists(path.join(repoRoot, declaredPath)))) {
          errors.push(
            `Card ${task.id} declares "${declaredPath}" under "${DELIVERABLE_HEADING}" but no committed file exists at that path -- attachments (including evidence/attempt uploads) are not a substitute for the deliverable actually existing at its stated, committed location.`
          );
          attachmentsOk = false;
        }
      }
    } else if (
      attachments.length > 0 &&
      !(await hasCommittedAttachment(task, attachments, attachmentsDir, repoRoot, listCommittedBlobs, evidenceRoot))
    ) {
      errors.push(
        `Card ${task.id} has ${attachments.length} attachment(s) recorded, but none of their content matches a file ` +
          `actually committed on the branch outside "${evidenceRoot}" -- an attachment alone (including an ` +
          `evidence/failed-attempt upload, which the board attachments API is also used for, and which T-0314's ` +
          `evidence-promotion mechanism routinely commits under "${evidenceRoot}" itself) is not proof a deliverable ` +
          `was produced, and neither is a same-named-but-different file or evidence that only ever landed in the ` +
          `evidence root. Either declare the deliverable's expected path under a "${DELIVERABLE_HEADING}" section, or ` +
          `commit the actual deliverable file (outside "${evidenceRoot}") and record it as an attachment.`
      );
      attachmentsOk = false;
    }
  }

  if (attachmentsOk) {
    return { ok: true, applicable: true, errors: [] };
  }

  if (task.deliverable_type === "artifact" && typeof beforeBody === "string") {
    const finding = await checkFindingWithEvidence({ task, beforeBody, repoRoot, fileExists });
    if (finding.applicable) {
      return { ok: finding.ok, applicable: true, errors: finding.ok ? [] : [...errors, ...finding.errors] };
    }
  }

  return { ok: false, applicable: true, errors };
}
