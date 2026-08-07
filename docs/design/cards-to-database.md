# Cards to a database: moving card state out of git

**Status:** proposed, not implemented. **Owning code (today):** `tools/board/src/lib/fsTaskStore.js`,
`taskParser.js`, `taskStore.js`, `idAllocator.js`, `taskWatcher.js`; `tools/board/src/runner/gitOps.js`,
`autoPush.js`, `serviceRestart.js`, `orphanReaper.js`, `cardCreation.js`, `runOrchestrator.js`;
`tools/board/src/server/httpApi.js`, `boardServer.js`; `tools/board/scripts/validateBacklog.js`,
`checkPlannerDiffGuard.js`, `checkDeliverable.js`; `~/.local/bin/board-assets-stage.py` (outside this
repo). See [[agent-runner.md]] for the base lifecycle this changes, [[flow-stats-self-improvement.md]]
for a component this affects.

## Problem

Every card edit is a git commit today, and that one design decision is the root cause of a whole class
of incidents this project has independently hit and patched around, never fixed at the source:

- **Merge wedges.** `docs/design/agent-runner.md`'s own history (T-0138) and this doc's own
  `scripts/deploy.sh` (lines 6–20) document a real outage: `node --watch` observed a merge landing on a
  *live* working tree and relaunched mid-conflict-resolution, taking the board down 20+ minutes.
  `deploy.sh` now stops the service before ever touching the tree specifically because of this.
- **Working-tree drift / uncommitted-state risk.** Any card write that fails to commit (`httpApi.js`
  lines 246–254, 310–315, 391–394, 478–482, 590–592; `runOrchestrator.js` lines 159–163;
  `orphanReaper.js` lines 30–41 — every one of these wraps its store write in a `try { commit } catch {
  warn and leave untracked }`) leaves `repoRoot`'s working tree dirty. `handlePatchTask`'s own comment
  (`httpApi.js` lines 267–275) states plainly: "a prior update's uncommitted diff was exactly what made
  [the Done-triggered] pull start failing."
- **`develop` diverges from origin by design**, per `DEPLOY.md` line 13: the board commits runtime data
  straight to local `develop` and, until `autoPush.js` was added, never pushed it — `git pull --ff-only`
  broke on every deploy the first time that happened.
- **Auto-pull-on-`Done` is itself a failure point.** `handlePatchTask` (`httpApi.js` lines 318–329) fires
  `pullDevelop()` — a real 3-way merge against origin — as a side effect of a routine drag-to-Done. A
  concurrent card write elsewhere touching the same file is a real, not hypothetical, conflict case
  (`gitOps.js`'s own `pullDevelop` docstring, lines 141–156, names it explicitly and still has to run
  `merge --abort` on failure to avoid leaving conflict markers on disk).
- **The planner diff guard depends on cards being a git diff at all.** `plannerDiffGuard.js`'s
  `checkPlannerDiffGuard` (lines 29–72) and `collectTasksDiff` (lines 95–122) work by diffing
  `tasks/**` between `baseRef` and `HEAD` and re-parsing old/new frontmatter — a mechanism that only
  exists because cards are git-tracked files in the first place.
- **Commit-per-edit is simply the wrong cost model** for what is, functionally, a row update in a
  single-user local tool: every drag on the board, every comment, every attachment upload is a git
  commit (`handlePatchTask`, `handleAddComment`, `handleUploadAttachment` in `httpApi.js`) plus a
  scheduled push (`autoPush.js`) plus (on Done) a merge (`pullDevelop`). None of that machinery does
  anything a database transaction wouldn't do for free, safely, synchronously, with no network and no
  merge semantics at all.

The fix is not another patch on the git-coupled model (this repo has already shipped several: PR #92's
`pullDevelop` merge-abort fix, the reaper liveness fix, the attachment dedupe fix, the update-commit fix
— see project memory `project_assembled_t0138_wedge_reconcile`, `project_assembled_orphaned_run_recovery`,
`project_assembled_attachment_dup_fix`, `project_assembled_update_commit_fix`). It's to stop putting
card *state* in git at all. Code — the actual deliverable of every card — stays exactly where it is:
worktrees, branches, PRs, `develop`. Only the row of metadata describing a card's status moves.

## Current architecture

### Store layer

`TaskStore` (`src/lib/taskStore.js`) is an abstract base — `list/get/create/update/move/remove` — already
implemented once, by `FsTaskStore` (`src/lib/fsTaskStore.js`). This is the single best fact for this
refactor: **every consumer already goes through this interface**, not raw file I/O. `FsTaskStore.list()`
(lines 23–34) reads every `*.md` in `this.dir`, parses it with `taskParser.js`'s `parseTask`, and returns
an array; `create`/`update` serialize back to disk via `atomicWriteFile` (`atomicWrite.js` — write a
`.tmp` file, `fs.rename` over the target, so a reader never observes a half-written card).

`taskParser.js` defines the full schema: required fields `id, title, status, priority, phase, agent,
depends_on, created` (lines 5–14), optional `branch, commit, pr` (line 22), `deliverable_type` (default
`code`, line 23), `attempts` (numeric, default 0, line 24), and two array fields, `comments` and
`attachments` (line 25), each with their own field-level validation (`validateComments` lines 29–43,
`validateAttachments` lines 45–64). This schema is the DB's target table shape — it does not change.

### Git coupling — every write path

Four independent call sites commit a card file today, each with the identical
`if (repoRoot && tasksDir && autoCommitCardsOnCreateFromEnv()) { try { commit } catch { warn } }` shape:

| Call site | File:line | Trigger |
|---|---|---|
| `handleCreateTask` | `httpApi.js:213–257` | New card via API/UI |
| `handlePatchTask` | `httpApi.js:276–332` | Any field edit, drag between columns, the Review→Done flip |
| `handleAddComment` | `httpApi.js:364–398` | Comment posted |
| `handleUploadAttachment` / `handleRemoveAttachment` | `httpApi.js:412–486`, `540–596` | Attachment add/remove |
| `createCard` | `cardCreation.js:20–49` | Non-HTTP card creation (flow-stats self-improve loop) |
| `RunOrchestrator._updateAndBroadcast` | `runOrchestrator.js:147–166` | Every in-run status flip (ready→in-progress→validation→review/blocked) |
| `commitReapedCard` | `orphanReaper.js:30–42` | Orphan-reaper recovery to `blocked` |

All of them funnel through `gitOps.js`'s `commitTaskFile`/`commitPaths` (lines 228–275), which stages,
commits with a fixed `BOARD_COMMIT_AUTHOR` identity (line 202), and — on a real commit —
`schedulePush()`s an async push of `develop` (`gitOps.js:258–260`, implemented in `autoPush.js`). Every
outcome is fire-and-forget and best-effort by explicit design (`commitPaths`'s docstring, lines 210–227):
a git failure must never fail the card write itself, so drift is a designed-in possibility, not a bug —
which is exactly the problem.

On top of per-write commits, `handlePatchTask` fires a **3-way merge against origin** the moment a card
reaches `done` (`httpApi.js:318–329`, `pullDevelop` in `gitOps.js:157–173`), and if that pull advances
HEAD, `restartCoordinator.notifyPulled` (`serviceRestart.js:38–72`) may restart the whole board service
(deferred until no run is active). Card metadata changing status is, today, capable of triggering a
service restart.

### ID allocation

`IdAllocator` (`idAllocator.js`) computes `next = max(persisted state file, working-tree scan, **git-log
scan across every ref**) + 1` (lines 32–42). The `_gitScanMax` step (lines 83–105) exists specifically
because this repo runs many concurrent worktrees of the same clone (`~/dev/assembled`,
`~/dev/assembled-board`, and one `worktrees/T-NNNN` per in-flight card, per `git worktree list` — 15
worktrees observed live) — a card ID minted on one worktree/branch is invisible to a sibling worktree's
in-memory/on-disk state until it's committed and that commit is visible via `git log --all`. This is a
git-coupling problem that only exists because cards are git-tracked files that can independently exist on
divergent branches.

### Attachments and comments

Attachments are files under `tasks/attachments/<id>/<filename>`, committed to git alongside the card file
(`handleUploadAttachment`, `httpApi.js:412–486`; `commitPaths` call at lines 473–477). Metadata
(`filename, size, mimetype, uploaded_by, uploaded_at`) lives as a frontmatter array on the card
(`taskParser.js:27, 45–64`). Max size 25MB by default (`DEFAULT_ATTACHMENT_MAX_BYTES`, `httpApi.js:37`),
mime-sniffed via `file-type` with a markup denylist for SVG/HTML (`resolveMimeType`, lines 117–132),
streamed to disk on upload and streamed back with `createReadStream` on download
(`handleDownloadAttachment`, lines 489–538) — not buffered fully into a response. Re-uploading an
existing filename replaces the single matching metadata entry in place, never appends a duplicate (lines
451–456; `project_assembled_attachment_dup_fix`).

Comments are a plain array on the card (`author, text, timestamp`), appended and re-serialized on every
post (`handleAddComment`, `httpApi.js:364–398`).

### The planner/agent write path — cards are also edited as files by LLM subprocesses

This is the wrinkle every other part of this plan has to route around. It is not only the HTTP API that
writes card files — **the `planner` agent itself edits `tasks/*.md` directly with filesystem tools**,
inside a git worktree, as its actual mechanism of action:

- `.claude/agents/planner.md:3` grants the planner `Read, Grep, Glob, Edit, Write` plus two narrow Bash
  allowlist entries (`validateBacklog.js`, `checkPlannerDiffGuard.js`) — no HTTP client, no board API
  access of any kind.
- `promptBuilder.js`'s `buildPlannerPrompt` (lines 118–145) and the `PLANNER_EXPANSION_WORKFLOW` text it
  injects (lines 97–111) instruct the planner to "Validate the card still parses… Commit your changes…
  then stop" (steps 8–9) — i.e., edit the file, `git add -A && git commit`, same as every implementer
  agent's own workflow (`WORKFLOW_SECTION`, lines 1–9).
- `RunOrchestrator._planUnassignedCard` (`runOrchestrator.js:367–397`) runs this planner phase **inside
  the same worktree** (`worktreeDir = worktreesDir/<taskId>`) that the implementer phase runs in
  immediately afterward for the same card.
- `plannerDiffGuard.js`'s guardrails (never change `status`, never delete a card file —
  `.claude/rules/planner.md:94–115`) are enforced by diffing `tasks/**` between `baseBranch` and `HEAD`
  in that worktree (`collectTasksDiff`, `plannerDiffGuard.js:95–122`) — a git-diff mechanism that
  presumes the card is a committed file in the branch.
- `verifyRouter.js`'s `resolveVerifyRoutes` (lines 104–121) routes a reviewer's VALIDATION run to
  `validateBacklog.js` + `checkPlannerDiffGuard.js` specifically when `changedPaths` includes anything
  under `tasks/` — again presumptively git-diff-based.

Once cards are DB rows, there is no `tasks/T-NNNN.md` file for the planner's `Edit`/`Write` tools to act
on, and no git diff for `plannerDiffGuard`/`resolveVerifyRoutes` to inspect. This has to be deliberately
redesigned, not just left broken — see "The planner problem" and "Open questions" below.

### Consumers

- **Frontend** (`src/client/api.js`): talks exclusively to the HTTP JSON API (`fetch`/`FormData` against
  `/api/tasks*`, `/ws/board`) — zero direct file or git access anywhere in the client. This is the best
  news in this whole audit: **if the API's response shapes stay byte-identical, the frontend needs zero
  changes.**
- **`validate:backlog`** (`scripts/validateBacklog.js` → `backlogValidator.js`): reads `tasks/*.md`
  directly off disk (`readBacklogEntries`, lines 13–27, independent of `FsTaskStore`) and checks filename↔id
  match, duplicate ids, dangling `depends_on`, and cycles (lines 42–99).
- **Flow-stats self-improve loop** (`flowImprovementCard.js`): stores its own state — the `baseline-done`
  count and `proposed-at` timestamp — as an HTML-comment marker *inside a card body*
  (`MARKER_RE`, line 1; `flow-stats-self-improvement.md` lines 101–108 explains this was deliberate,
  "the trigger's memory can never drift out of sync with reality… it's the same `store.list()` scan
  already in hand"). This keeps working unchanged as long as `body` remains a queryable/regex-able text
  field on the DB row — no schema change needed for this consumer, just confirm `body` stays a full-text
  column, not compressed/omitted from `list()`.
- **The external asset-export pipeline** (`~/.local/bin/board-assets-stage.py`, outside this repo,
  running from WSL against `~/dev/assembled-board` on an hourly systemd timer — see
  `project_assembled_board_assets_autostage`): reads `tasks/*.md` frontmatter directly via a hand-rolled
  YAML-frontmatter parse (`parse_frontmatter`, `load_all_cards`, lines ~60–80) and lists files under
  `tasks/attachments/<id>/` (`stage_attachment_task`, lines ~180–220) — no HTTP dependency today, pure
  filesystem read. This is the one consumer genuinely outside the codebase's own test/review process; see
  "Impact on the asset-export pipeline" below.

## Target architecture

### Database choice: SQLite (`better-sqlite3`), not Postgres

**Recommendation: embedded SQLite via `better-sqlite3`.**

- **Single-user, single-host, local tool.** The board is one Node process on `127.0.0.1` serving one
  person. There is no concurrent-writer-from-multiple-hosts case to design for — SQLite's single-writer
  model is not a limitation here, it's a match.
- **Zero ops.** No server process to install, configure, back up, or keep running (`better-sqlite3` links
  SQLite in-process). This board already goes out of its way to avoid extra moving parts (`js.md`'s own
  "never a single aggregate `board.json`" rule was reaching for exactly this simplicity, just via the
  wrong mechanism — see "the rule this refactor overturns" below).
- **Transactional and synchronous.** `better-sqlite3`'s API is synchronous (no async round-trip per
  query) and wraps multi-statement writes (e.g. update a task + insert a comment) in real ACID
  transactions with zero network latency — a strict improvement over today's "write a file, separately
  try to commit it, separately try to push it, independently able to fail at each step."
  Node 20.20.2 (this repo's pinned floor, `package.json:7`) is a fully supported `better-sqlite3` target
  via prebuilt binaries; no native toolchain required at install time.
  Node's own built-in `node:sqlite` is not used here — it landed experimentally after Node 22.5 and this
  repo's floor is Node ≥20 (`package.json:6-8`).
- **The file lives outside git — trivially.** A single `.db` file is the whole database; "don't let `git
  pull` touch it" is satisfied just by putting it somewhere `git` never looks (see next section), with no
  server config, connection string, or port-binding concerns Postgres would add.
- **Why not Postgres:** this repo's own `server/` (the actual game backend, Drogon + Postgres,
  `docs/design/04-data-model.md:7`, `docs/design/agent-runner.md:79`) already uses Postgres — for a
  networked multi-client game server, where it's the right tool. The board tool is not that: it doesn't
  need a second long-running service, a schema-migration story shared with an unrelated system, or
  network-accessible multi-writer semantics. Running a second Postgres locally is also concretely
  annoying on this machine specifically — `docs/env-inventory.md:33,41` documents host port 5432 already
  occupied by an **unrelated third-party project's** `magic_wand_postgres` container, forcing a
  non-default port for the game server's own dev Postgres already. There's no reason to invite that
  problem into the board tool too when SQLite needs no port at all.

### Where the DB file lives — and why it must be worktree-independent

This is the one place a naive choice would silently reintroduce the exact bug class this refactor exists
to remove. This repo runs the *same logical board* from many independent git worktrees simultaneously —
confirmed live: `~/dev/assembled` (main, detached), `~/dev/assembled-board` (the live server,
`project_assembled_board_worktree`), and one `worktrees/T-NNNN` per in-flight card under it, plus a dozen
named feature worktrees for other in-progress work (`git worktree list`, 15 entries observed). If the DB
file were placed inside the repo tree at a path like `tools/board/data/board.db`, **every worktree would
get its own independent copy** — worktrees share git history, not working-tree files — which would
silently recreate "which copy is the truth" drift, just one layer deeper than today's problem.

The DB path must therefore be a single fixed filesystem location, **not** derived from `import.meta.url`
or `repoRoot` the way `DEFAULT_TASKS_DIR` is today (`fsTaskStore.js:8–11`, `backlogValidator.js:7–10`,
`server/index.js:5–8`). Recommendation: `~/.local/share/assembled-board/board.db`, matching this
environment's existing convention for out-of-repo state (`~/.config/rclone/rclone.conf`,
`~/.local/bin/board-assets-*`), overridable via a `BOARD_DB_PATH` env var (same pattern as
`BOARD_TASKS_DIR`/`BOARD_PORT` today, `server/index.js:11–12`) for tests and throwaway instances. Every
worktree's board server — whichever one is actually running as `assembled-board.service` — points at the
same absolute path, so "which worktree is live" (already solved by `project_assembled_board_worktree`'s
convention of always running from `~/dev/assembled-board`) stays the only thing that matters, and a `git
worktree add`/`git checkout` anywhere never creates, touches, or forks the database.

### Backup strategy

Git gave one property "for free" that a raw DB file does not: full history, every edit permanently
recoverable via `git log`. Losing that is a real regression, not a rounding error, and needs two
mitigations:

1. **A `card_events` audit table** (see schema below) — an append-only log of every field change, so "what
   was this card's status an hour ago" stays answerable without needing git at all. Not full parity (no
   arbitrary-point-in-time full-row reconstruction), but covers the actual thing anyone has ever needed
   git history for on this board: reconstructing a status/field timeline.
2. **File-level backups**, since SQLite is one file: (a) the importer (see Migration) always copies any
   pre-existing DB to a timestamped `.bak` before writing, never overwrites in place; (b) a periodic
   backup via SQLite's online backup API (`sqlite3 board.db ".backup <path>"`, safe against a concurrent
   writer, unlike a raw `cp` mid-write), retained N days — this can piggyback on the same
   flock-guarded-systemd-timer pattern `board-assets-sync.timer` already uses
   (`project_assembled_gdrive_asset_sync`), just a new unit, or even push the backup file into the
   existing `board-assets-export` → Drive sync as one more staged artifact. Left as an implementation
   detail for whichever phase adds it, not blocking Phase 1.

### Schema

Plain SQL, no ORM — matches this repo's own stated convention for its other database
(`docs/design/04-data-model.md:7`: "Postgres schema… plain SQL migrations, no ORM"). One SQL file per
migration under `tools/board/src/lib/db/migrations/`, applied in order at startup (a ~20-line runner is
enough; `better-sqlite3` needs nothing fancier for a single-writer local file).

```sql
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,             -- "T-0148" — string form kept: worktree/branch
                                                   -- names, .runs/<id> paths, and prompts all key off it
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('backlog','ready','in-progress','validation','review','done','blocked','retired')),
  priority         TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  phase            INTEGER NOT NULL,
  agent            TEXT CHECK (agent IN ('infra','server','client','assets','audio','planner') OR agent IS NULL),
  created          TEXT NOT NULL,                 -- "YYYY-MM-DD"
  branch           TEXT,
  commit_sha       TEXT,                          -- "commit" is a SQL-adjacent word; avoid the collision
  pr               TEXT,
  deliverable_type TEXT NOT NULL DEFAULT 'code' CHECK (deliverable_type IN ('code','artifact')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  body             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE task_dependencies (                  -- replaces the depends_on JSON array
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id TEXT NOT NULL,                     -- not FK-enforced: a dangling ref is a *validation*
                                                    -- error (backlogValidator's job), not a DB-integrity one
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL                         -- ISO-8601, matches today's comment.timestamp
);

CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mimetype    TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  UNIQUE (task_id, filename)                       -- makes "exactly one entry per stored filename"
);                                                  -- (httpApi.js:406-410) a DB constraint, not app logic

CREATE TABLE card_events (                          -- audit trail (see Backup strategy) — replaces git history
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  changed    TEXT NOT NULL,                         -- JSON list of changed field names
  created_at TEXT NOT NULL
);

CREATE TABLE id_allocator (next_seq INTEGER NOT NULL);  -- single row; see ID allocation below
```

**Attachments stay files on disk, not BLOB columns** — `<dataDir>/attachments/<task_id>/<filename>`,
same shape as today's `tasks/attachments/<id>/<filename>`, just rooted under the new out-of-repo data
directory instead of the repo. Two concrete reasons: (1) `handleDownloadAttachment`
(`httpApi.js:489–538`) streams bytes with `createReadStream` today for memory efficiency on files up to
25MB; `better-sqlite3` has no native BLOB-streaming API, so a BLOB column would mean buffering the whole
attachment into memory on every download — a real regression. (2) Keeping attachments as files means
Phase 4's asset-export pipeline change (below) stays a "same file-copy logic, different root directory"
change instead of a "learn to read BLOBs out of SQLite in Python" change.

**`depends_on` becomes a join table**, not a JSON column, so `dependencyGuard.js`'s existing cycle-check
algorithm and `backlogValidator.js`'s dangling-ref check keep working as plain queries feeding the same
JS logic they already have — no algorithm rewrite, just a different data source.

### `TaskStore` interface is preserved — this is the whole point

`DbTaskStore` implements the exact same `list/get/create/update/move/remove` contract as `FsTaskStore`
(`taskStore.js`), returning the exact same shape `taskParser.parseTask` returns today (id, title, status,
priority, phase, agent, depends_on, created, branch, commit, pr, deliverable_type, attempts, comments,
attachments, body). Because every consumer inside this codebase — `httpApi.js`, `cardCreation.js`,
`runOrchestrator.js`, `orphanReaper.js`, `dependencyGuard.js` — already goes through this interface and
never touches `fs`/`git` for cards directly, **swapping the store implementation is a one-line change at
each construction site** (`boardServer.js:27`), and the HTTP API's JSON response shapes never change.
The frontend (`client/api.js`, `board.js`, `detail.js`, etc.) requires zero changes — confirmed by reading
every client file that talks to `/api/tasks*`: all of them consume the JSON shape, none of them assume
anything about git or the filesystem.

### The planner problem — how card-editing agents work without a `tasks/*.md` file

This needs an explicit decision (see "Open questions") but here is the recommended shape, to make the
tradeoff concrete rather than leaving it abstract:

**Recommended: ephemeral, git-ignored materialized file view, reconciled by the orchestrator — not a new
tool grant for the planner.**

- Before `RunOrchestrator._planUnassignedCard` (`runOrchestrator.js:367–397`) starts the planner phase,
  the orchestrator exports the target card (and, for `depends_on`/validator context, the rest of the
  backlog) from the DB to `<worktreeDir>/tasks/<id>.md` files — the exact same serialized shape
  `taskParser.serializeTask` produces today. The planner's prompt, tool grants
  (`.claude/agents/planner.md:3`), and `PLANNER_EXPANSION_WORKFLOW` (`promptBuilder.js:97–111`) need **no
  changes at all** — it still `Read`s, `Edit`s, `Write`s markdown files, still runs
  `validateBacklog.js`/`checkPlannerDiffGuard.js` (against the materialized directory, reworked to accept
  a plain directory arg instead of assuming `tasks/` at `repoRoot`), still "commits" in its own worktree
  (harmless — that worktree's branch is either discarded or only its *code* commits ever get pushed; see
  next bullet).
- After the planner phase exits, the orchestrator re-parses `<worktreeDir>/tasks/*.md`, diffs each card
  against the DB's current row, applies the diff via `DbTaskStore.update()`/`.create()` (enforcing the
  status-unchanged/no-delete guardrails at this application layer instead of via git diff — a direct,
  simpler replacement for `plannerDiffGuard.js`'s logic, operating on two in-memory objects instead of two
  git refs), then deletes `<worktreeDir>/tasks/` before the implementer phase begins so the implementer's
  own `commitAll` (`gitOps.js:102–112`, a plain `git add -A`) never sweeps up the scratch card files into
  a *code* commit.
- This keeps the planner's mental model, prompt, and tool grants identical, keeps `plannerDiffGuard.js`'s
  *logic* (not its git-diff plumbing) alive as an app-level guard, and confines the "cards as files" idea
  to a deliberately temporary scratch space that never reaches git — instead of teaching an LLM subprocess
  to make HTTP calls or granting it new Bash/API access it doesn't have today.

**Alternative considered and not recommended for Phase 1: a narrow CLI/API tool for the planner.** Give
the planner a new Bash-allowlisted command (`node scripts/cardCli.js patch <id> --field=value`) or curl
against the running board's HTTP API instead of file edits. Rejected as the default because it requires
rewriting the planner's entire prompt/workflow (`promptBuilder.js` lines 97–111), rewriting
`.claude/rules/planner.md`'s guardrail enforcement text, and — critically — assumes the board's HTTP
server is reachable and up during every planner run, which the file-based approach never had to assume.
Worth revisiting only if the materialized-file approach proves awkward in practice.

## Critical separation: card state vs. the code repo

**Code stays in git, unconditionally.** Worktrees, `feature/T-NNNN` branches, `gh pr create`, `develop`
merges, and `scripts/deploy.sh`'s stop→fetch→merge→start sequence for deploying *board tool code itself*
are entirely unaffected by this refactor and are out of scope. The only thing moving is the row of
metadata describing a card's status/fields/comments/attachments.

| Git machinery | Fate | Why |
|---|---|---|
| `commitTaskFile`/`commitPaths` calls in `httpApi.js`, `cardCreation.js`, `runOrchestrator.js`, `orphanReaper.js` | **Removed** | No file exists to commit once the store is DB-backed |
| `autoPush.js` (`schedulePush`/`attemptPush`) | **Removed** | Its only caller is `commitPaths` (`gitOps.js:258-260`); once that call site is gone, this module has no remaining caller |
| Done-triggered `pullDevelop()` (`httpApi.js:318-329`) | **Removed** | Existed to fetch code the board's own card commits (and others') had pushed; card writes never touch git post-migration |
| `restartCoordinator`/`serviceRestart.js`'s `notifyPulled` path | **Removed** (dead once the above is gone — its only caller was the Done-triggered pull) | Code deploys become 100% `deploy.sh`'s job (stop/fetch/merge/start), which never went through this coordinator |
| `mergeNoFF` (`gitOps.js:187-199`) | **Kept** | Still used by `deploy.sh` (line 74) and would remain `autoPush`'s reconciliation path if any future git-authored writes exist — no other change needed |
| `IdAllocator`'s `_gitScanMax` (`idAllocator.js:83-105`) | **Removed**; replaced by a single `id_allocator` DB row + transaction | The whole reason for a git-history scan — sibling worktrees each holding an independent copy of `tasks/` — disappears once there's one DB, not N branches of markdown files |
| `TaskWatcher`/chokidar (`taskWatcher.js`) | **Removed** | Existed as a secondary "the board must not depend solely on the file watcher" signal (`runOrchestrator.js:132-136`'s own docstring) alongside the WS broadcast every write already does; with no `tasks/*.md` to watch, `_updateAndBroadcast`'s WS push is the only (and sufficient) channel |
| `plannerDiffGuard.js` (git-diff mechanism) | **Removed**, logic ported to an app-level guard (see "The planner problem") | No git diff of `tasks/**` exists once cards aren't committed files |
| `checkPlannerDiffGuard.js` / `validateBacklog.js` (scripts) | **Reworked** to query the DB instead of `fs.readdir`/git diff | Same checks (cycle, dangling ref, guardrails), different data source; "filename matches id" check is dropped — there's no filename |
| `addWorktree`/`removeWorktree`/`commitAll`/`diffNames`/`push`/`getHeadCommit`/`linkBoardNodeModules` (`gitOps.js`) | **Kept, unchanged** | This is the *code* worktree/branch/PR machinery — completely orthogonal to card storage |
| `deploy.sh` | **Kept, unchanged** | Deploys board tool *code*; outage #2's rationale (line 13-20) — "the board commits runtime data to develop" — no longer applies once cards aren't committed, which makes this script's job strictly simpler (though its `--no-ff` merge stays correct/harmless regardless) |
| "Refreshing the board" (`git pull`/checkout on the live worktree) | **Becomes safe** | With no card files in the working tree, a code pull can never touch, conflict with, or lose in-flight card state — this is the direct fix for the user's stated goal |

Also obsolete once this lands: `.claude/rules/js.md:12-13` and `.claude/agents/infra.md:30-31`'s standing
convention — *"Task store is one markdown file per task under `tasks/`, never a single aggregate
`board.json` (guarantees [avoids] merge conflicts on concurrent edits)"* — is the exact assumption this
refactor overturns. Its own stated rationale (avoid merge conflicts) was real but insufficient: one file
per card avoided *content* conflicts while still leaving every other problem in "Problem" above
unsolved. Both files need an explicit rewrite as part of the rollout (Phase 3) — otherwise a future infra
implementer run will read a now-false rule and object to (or "fix") the very migration this doc describes.

## Migration

A one-time importer, `tools/board/scripts/importTasksToDb.js`:

1. **Backup first, unconditionally.** If a DB file already exists at the target path, copy it to
   `<path>.bak-<ISO-timestamp>` before opening it for writes. Never overwrite in place.
2. **`--dry-run` (default behavior without `--commit`).** Reads every `tasks/*.md` via the exact same
   `readBacklogEntries`/`parseTask` `backlogValidator.js` already uses (reuse, don't reimplement), runs
   the same validation (`validateBacklog`), and reads `tasks/attachments/<id>/` file listings — reports
   what *would* be imported (task count, comment count, attachment count + total bytes, any parse/validation
   errors) without writing anything. A parse or validation error on any card **aborts the whole import**
   (report it, exit non-zero) rather than partially importing — matches this repo's existing
   `validateBacklog.js`/`checkPlannerDiffGuard.js` fail-closed convention.
3. **`--commit` actually writes**, inside a single SQLite transaction: every task row, every
   `depends_on` join row, every comment row, every attachment metadata row — and copies (not moves,
   initially) attachment files from `tasks/attachments/<id>/` to the new `<dataDir>/attachments/<id>/`.
   Copy, not move, so the source `tasks/` tree is left completely intact until the operator has verified
   the import (Phase 1/2 boundary) before anything is deleted.
4. **ID allocator seeded** from `max(existing card ids) `, matching `IdAllocator`'s own current formula
   minus the git-scan term (irrelevant post-migration, since there's only one DB going forward).

**Fate of `tasks/` after migration:** kept, untouched, for the duration of Phase 2 (dual-path validation
window — see rollout). Removed from the repo (`git rm -r tasks/`, its own isolated commit) only in Phase
3, once the DB has been the live store for a real stretch of usage with no rollback need. `tasks/.runs/`
(run logs, pid/heartbeat state — `runState.js`, `runLog.js`) is unaffected either way: it's runtime
process state, not card state, already effectively untracked (`git ls-tree` on `origin/develop` shows no
committed files under it), and is deliberately **out of scope** for this migration — it stays
filesystem-based.

## Impact on the asset-export pipeline

`~/.local/bin/board-assets-stage.py` lives **outside this repo**, runs from an hourly WSL systemd timer
against `~/dev/assembled-board` (`BOARD_ROOT`, script line ~24), and today reads `tasks/*.md` frontmatter
directly (`load_all_cards`/`parse_frontmatter`) plus `tasks/attachments/<id>/` file listings — no HTTP
dependency, pure filesystem read, which is why it keeps working even if the board service itself is down.

Once `tasks/` is removed from the repo (Phase 3), this script must change or it silently stops staging
anything (worst case: it logs "WARN: could not parse frontmatter" and no new task ever gets staged again,
with nobody watching that log). Two options, both viable:

- **(a) Query the live HTTP API** (`GET /api/tasks`, `GET /api/tasks/:id/attachments/:filename`). Simplest
  conceptually, but makes the hourly sync dependent on the board service being up — a real behavior
  change from today's "works even if the board is down" property.
- **(b) Read the SQLite file directly, read-only.** `sqlite3.connect(f"file:{path}?mode=ro", uri=True)`
  from Python's stdlib `sqlite3` module — no new dependency, no HTTP coupling, and (opened read-only) no
  lock risk against the Node process's writes. Attachments stay a directory listing under the new
  `<dataDir>/attachments/<id>/` root, so `stage_attachment_task`'s copy logic barely changes — same
  file-copy code, new source path plus a SQL query instead of a YAML-frontmatter regex for metadata.

**Recommended: (b)**, for parity with the pipeline's current resilience property (works without the board
service running) and because it adds no new dependency. This is explicitly called out as needing
confirmation (see Open questions) since it's a real tradeoff either way.

This script is **not part of this repo's PR/reviewer process** — updating it is a manual follow-up step
that must happen in the same maintenance window as Phase 3 (removing `tasks/` from
`~/dev/assembled-board`), or the next hourly sync tick will start failing/no-op-ing silently. Flag this
explicitly as a checklist item on the Phase 3 PR description, not something CI can catch.

## Phased rollout

Every phase is its own reviewable PR, TDD as usual (failing test committed before implementation,
matching `.claude/agents/infra.md`'s "TDD non-negotiable" convention), and the existing ~1200-test suite
stays green throughout — a phase that would break it is split further, not shipped red.

### Phase 1 — Introduce the DB store behind the existing interface (pure addition, zero behavior change)

- Add `better-sqlite3` to `tools/board/package.json`.
- New `src/lib/db/schema.sql` (or numbered migration files) + a small migration runner.
- New `src/lib/dbTaskStore.js` implementing `TaskStore` (`list/get/create/update/move/remove`), same
  return shape as `FsTaskStore`.
- New `src/lib/idAllocatorDb.js` (or extend `IdAllocator` with a DB-backed variant): a single transaction
  incrementing `id_allocator.next_seq` and returning `T-<padded>` — no promise-queue serialization needed
  (unlike today's `IdAllocator._queue`, `idAllocator.js:20-30`), since `better-sqlite3`'s synchronous API
  plus SQLite's single-writer model serializes this for free.
- New `scripts/importTasksToDb.js` (dry-run + `--commit`, backup-first — see Migration).
- **Tests:** a contract test suite that runs the *same* test cases against both `FsTaskStore` and
  `DbTaskStore` (parameterize `test/fsTaskStore.test.js`'s existing cases, don't duplicate them) — proves
  the new store is behaviorally identical before it's ever wired into anything live. Plus dedicated
  `dbTaskStore.test.js` for DB-specific concerns (constraint violations, the `id_allocator` transaction,
  the `card_events` audit rows).
- **Nothing is wired into `boardServer.js` yet.** `FsTaskStore` remains the live store; this PR is purely
  additive and carries zero production risk.
- **Rollback:** trivial — revert the PR. Nothing reads or writes the DB in the live path yet.

### Phase 2 — Cut the API/runner over to the DB

- `boardServer.js:27-28`: swap `new FsTaskStore(tasksDir)` / `new IdAllocator(tasksDir)` for their DB
  equivalents, behind a `BOARD_TASK_STORE=db|fs` env var (default `fs` initially, flipped to `db` once
  confidence is high) — this single flag is the fast rollback lever for this phase: flip it back, restart
  the service, `tasks/*.md` is still sitting there untouched (not removed until Phase 3).
- Remove the `commitTaskFile`/`commitPaths` call sites in `httpApi.js`, `cardCreation.js`,
  `runOrchestrator.js._updateAndBroadcast`, `orphanReaper.js.commitReapedCard` — and the Done-triggered
  `pullDevelop()` block in `handlePatchTask` (`httpApi.js:318-329`).
- Remove `TaskWatcher` wiring from `boardServer.js` (lines 30, 61, 94, 116).
- Attachments: `handleUploadAttachment`/`handleDownloadAttachment`/`handleRemoveAttachment` write/read
  `<dataDir>/attachments/<id>/` instead of `tasksDir/attachments/<id>/`; metadata via `DbTaskStore`
  instead of frontmatter mutation.
- `validateBacklog.js`/`checkPlannerDiffGuard.js`: reworked to read from the DB (drop the
  filename-matches-id check, which has no DB analog).
- Implement "the planner problem" fix (materialized ephemeral file view — see above) so
  `RunOrchestrator._planUnassignedCard` keeps working unchanged from the planner's point of view.
- **Tests:** `httpApi.commitOnCreate.test.js`, `httpApi.commitOnUpdate.test.js`, `httpApi.done.test.js`
  currently assert the commit-on-write / pull-on-done behavior directly — these are **deleted**, not kept
  green, because the behavior they test is being removed on purpose; call this out explicitly in the PR
  description so it doesn't read as an accidental coverage drop. New tests assert the DB-backed
  equivalents (write lands in the DB row, no git call is made).
- **Rollback:** flip `BOARD_TASK_STORE` back to `fs` and restart — the filesystem store and its data are
  untouched throughout this phase, making this the safest possible rollback story for the riskiest phase.

### Phase 3 — Remove the now-obsolete git card machinery and the `tasks/` directory

- Delete: `taskWatcher.js`, `autoPush.js`, the git-scan half of `idAllocator.js` (or the whole file if
  fully superseded), `serviceRestart.js`'s `notifyPulled`/restart-coordinator path (dead per the table
  above), `commitTaskFile`/`commitPaths`/`pullDevelop`/`autoCommitCardsOnCreateFromEnv` from `gitOps.js`
  (keep `addWorktree`/`removeWorktree`/`commitAll`/`diffNames`/`push`/`getHeadCommit`/`mergeNoFF`/
  `linkBoardNodeModules` — all still needed for code branches).
- `git rm -r tasks/` as its own isolated commit (easy to revert independently of the code-machinery
  removal commits in the same PR, if needed).
- Rewrite `.claude/rules/js.md:12-13` and `.claude/agents/infra.md:30-31`'s file-per-card convention to
  describe the DB store instead.
- Rewrite `.claude/rules/planner.md` / `.claude/agents/planner.md` to match whichever planner-write
  mechanism Phase 2 actually shipped.
- Update `docs/design/agent-runner.md`'s references to `tasks/**` as the card store.
- Remove `plannerDiffGuard.js`'s git-diff plumbing (its guardrail *logic* already moved to the app layer
  in Phase 2).
- **Tests:** delete/rewrite anything still asserting the removed modules exist; full suite green.
- **Rollback:** harder (file deletions), but `tasks/` removal is its own commit — revertable in isolation
  from everything else in this phase without resurrecting the git-commit machinery (which is removed in a
  separate commit).

### Phase 4 — Point the asset-export pipeline at the DB

- Update `~/.local/bin/board-assets-stage.py`'s `TASKS_DIR`/`ATTACH_DIR` constants and
  `load_all_cards`/`parse_frontmatter` to read the SQLite file read-only (recommended option (b) above)
  instead of `tasks/*.md`.
- Manual step, outside this repo's CI — must happen in the same maintenance window as Phase 3 landing on
  `~/dev/assembled-board` (see "Impact on the asset-export pipeline").
- **Verification:** run `board-assets-stage.py` by hand once against the live (migrated) board and confirm
  `index.json`/`MANIFEST.md` output is unchanged for all existing pinned + auto-staged task directories,
  same as the original live verification done for `project_assembled_board_assets_autostage`.
- **Rollback:** the script's previous version is a one-line `git checkout` away in whatever VCS (if any)
  tracks `~/.local/bin/`; worst case, re-copy the pre-Phase-4 script from this design doc's PR diff (it's
  quoted in full above) or from shell history.

## Risks and open questions — need a decision before Phase 1

1. **The planner-write mechanism** (see "The planner problem"). This doc recommends the ephemeral
   materialized-file approach as the default because it requires zero changes to the planner's prompt,
   tool grants, or mental model. Confirm before Phase 1, since it shapes what Phase 2's `DbTaskStore`
   needs to support (an export-to-files / import-from-files pair, not just `list/get/create/update`).
2. **Asset-pipeline read strategy** (API vs. direct read-only SQLite read — see "Impact on the
   asset-export pipeline"). Recommended: direct SQLite read, for parity with today's "works without the
   board service running" property. Low cost to change later since it's an out-of-repo script, but worth
   deciding up front so Phase 4 isn't re-litigated.
3. **`card_events` audit table: in scope for Phase 1, or deferred?** It's the direct mitigation for losing
   git's free full-history backup (see "Backup strategy"). Recommended in Phase 1 since it's cheap and the
   schema is trivial, but flagging as a scope decision since it's not strictly required for the store swap
   itself to work.
4. **Backup cadence and retention** for the DB file itself — this doc proposes piggybacking on the
   existing `board-assets-sync.timer` cadence/pattern but does not commit to a specific schedule or
   retention count; needs a concrete number before Phase 1 if backups are expected to exist from day one
   rather than being added opportunistically later.
5. **`BOARD_DB_PATH` default location** — this doc recommends `~/.local/share/assembled-board/board.db`.
   Confirm this doesn't collide with any existing backup/sync assumption about what lives under
   `~/.local/share/` on this machine before treating it as final.
6. **Dual-write window in Phase 2** — this doc's `BOARD_TASK_STORE=db|fs` flag is a single-store switch
   (either all reads/writes go to the DB, or all go to the filesystem), not a dual-write safety net. If a
   belt-and-suspenders dual-write period (write both, read from `db`, compare) is wanted for extra
   confidence before fully committing, that's additional Phase 2 scope to size separately — not assumed by
   the plan above.
