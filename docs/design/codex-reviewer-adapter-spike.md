# Codex reviewer adapter -- runtime spike (T-0460)

**Author:** Claude (infra persona), 2026-10-21.

This is a spike, not the adapter. It answers one question -- can Codex run against a board
worktree on this machine at all, and if so, how -- and then proves exactly one bounded,
non-interactive review end to end as a board job, with a structured verdict published onto a
real card. The sprint scheduler, exact-head binding, receipts, event wake-up, and auto-merge are
explicitly out of scope; see T-0444/T-0446/T-0454/T-0458 in the card body.

A note on a doc this card cites: `docs/design/working-agreement.md` **does not exist in this
worktree** (confirmed by search -- `find`/`grep -rl` for `*working*agreement*` and `*agreement*`
under `docs/` return nothing). The card names it as "added by T-0461," and this worktree's branch
point (`f3fee0ee`) predates that. Everything below proceeds from the card body's own description
of the agreement's content, not from reading the doc itself. Likewise T-0444, T-0446, T-0454,
T-0458 do not exist as files in this worktree (confirmed via `git log --all --grep`) -- T-0458 has
real commits on `feature/T-0458` (auto-done-on-merge reconciliation) but no card body landed here
either. Where this doc says "integrates with T-0444/T-0446/T-0454," it names the conceptual seam
this spike's code already exposes, not a file:line in those cards' own implementation, which this
worktree cannot see.

## 1. The runtime question, answered, with evidence

**Three outcomes were on the table: a supported WSL install, a validated Windows-to-WSL path, or
"it doesn't work here." None of those three is quite what happened.** What actually works is a
fourth option the card didn't anticipate: install the official native Linux build and run it
directly inside WSL, authenticating by pointing `CODEX_HOME` at the existing Windows-side
credential directory. The Windows-process-to-WSL-worktree path the card specifically flagged as
the known hazard was tried first, and it fails -- not from the mode-bit/ownership hazard the card
named, but from something more fundamental.

### 1a. The installed Windows build: located, and its UNC path fails for reads

`codex` is not on the WSL `$PATH`, and (newly discovered this session) neither is `where.exe`,
`cmd.exe`, or `powershell.exe` -- there is no Windows directory on `$PATH` at all in this shell.
Windows interop itself is enabled (`/proc/sys/fs/binfmt_misc/WSLInterop` reports `enabled`), so
invoking a `.exe` by full path still works; it only has to be found first:

```
$ echo $PATH          # no /mnt/c/... anywhere in it
$ cat /proc/sys/fs/binfmt_misc/WSLInterop
enabled
interpreter /init
flags: P
offset 0
magic 4d5a
```

Searching `/mnt/c/Users/denni/AppData` for `codex*` (excluding the `.codex` config dir's own
contents) found it as an MSIX Store install:

```
/mnt/c/Users/denni/AppData/Local/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe
```

```
$ "/mnt/c/.../codex.exe" --version
codex-cli 0.162.0-alpha.17.2
```

This matches the version the card's own `## Context` already named from an earlier probe.

**The top-level process can set its cwd to a WSL UNC path and chat normally:**

```
$ "/mnt/c/.../codex.exe" exec --json -s read-only --skip-git-repo-check \
    -C "\\wsl.localhost\Ubuntu-24.04\home\dennieseth\dev\assembled-board\worktrees\T-0460" \
    "Reply with exactly the word PONG and nothing else."
{"type":"thread.started","thread_id":"01a15e5a-9390-7500-bed9-010c6198459c"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
{"type":"turn.completed","usage":{...}}
```

(This only worked once the UNC path was passed as a raw argv element, not through a shell string
-- the shell-string version mangled the backslash count and failed with `os error 3`, "path not
found." That's its own small lesson: argv array, never a shell-interpolated string, for any path
crossing this boundary.)

**But the sandboxed subprocess Codex spawns for an actual tool call -- the one that does file
I/O -- cannot cross the UNC boundary at all**, in two different ways depending on how the path is
supplied:

```
{"type":"item.completed","item":{"id":"item_0","type":"command_execution",
  "command":"\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content -LiteralPath CLAUDE.md -TotalCount 1'",
  "aggregated_output":"Failed to create unified exec process: CreateProcessWithLogonW failed: 267",
  "exit_code":-1,"status":"failed"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",
  "command":"\"C:\\WINDOWS\\...\\powershell.exe\" -Command \"Get-Content -LiteralPath '\\\\wsl.localhost\\Ubuntu-24.04\\...\\CLAUDE.md' -TotalCount 1\"",
  "aggregated_output":"Get-Content : ... PermissionDenied: ... UnauthorizedAccessException\nGet-Content : ... ItemNotFoundException\n",
  "exit_code":1,"status":"failed"}}
```

The first attempt (relative filename, relying on the UNC cwd) fails to even spawn --
`CreateProcessWithLogonW` returns Windows error 267 (`ERROR_DIRECTORY`), a known Windows
limitation: you cannot `CreateProcess` with a UNC current directory without a mapped drive
letter. The fallback attempt (literal UNC path as the argument instead of relying on cwd) spawns
but gets `UnauthorizedAccessException` then `ItemNotFoundException` from PowerShell itself --
Codex's sandboxed command-execution token cannot authenticate across the network-redirector
boundary `\\wsl.localhost\` represents, independent of file mode bits.

The help text's `-c 'sandbox_permissions=["disk-full-read-access"]'` example looked like a
plausible escape hatch (grant read access without the full dangerous bypass). It is not a real
option in this build:

```
{"type":"item.completed","item":{"type":"error","message":"Codex is ignoring 1 unrecognized
  configuration setting. ... session-flags: `sandbox_permissions` is ignored."}}
```

**`net use` drive-letter mapping to `\\wsl.localhost\...` also fails** (`System error 64: the
specified network name is no longer available`) -- a known limitation of `wsl.localhost`'s 9P-based
provider, which doesn't support classic persistent SMB drive mapping. So there is no available
middle ground between "top-level chat only" and "the full `--dangerously-bypass-approvals-and-sandbox`",
which this spike deliberately never invoked (that bypass removes sandboxing entirely, which
conflicts with the least-privilege requirement on its face -- using it wasn't needed, since the
route below works without it).

**Conclusion on the Windows-build/UNC route: it does not work for anything that needs to read a
file, which is to say anything a review needs to do.** This is the "it does not work, here is the
evidence" branch for that specific route -- but not the final answer for Codex on this machine,
because of what's below.

### 1b. What actually works: the official native Linux build, run directly in WSL

The npm registry is reachable from this sandbox, and `@openai/codex` publishes a Linux x64
binary as an optional dependency:

```
$ npm view @openai/codex version
0.163.0
$ npm install --prefix /tmp/codex-cli-probe @openai/codex
added 2 packages
$ /tmp/codex-cli-probe/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --version
codex-cli 0.163.0
```

(0.163.0 vs. the Windows build's 0.162.0-alpha.17.2 -- close enough for this spike; a production
install would pin a specific version like any other dependency.)

Pointing `CODEX_HOME` at the **same Windows-side credential directory** (`auth.json`/
`config.toml` are plain cross-platform JSON/TOML, not OS-specific) and running directly against
the real, native WSL path -- no UNC, no `\\wsl.localhost\`, no mapped drive -- works cleanly:

```
$ CODEX_HOME=/mnt/c/Users/denni/.codex \
  /tmp/codex-cli-probe/.../bin/codex exec --json -s read-only --skip-git-repo-check \
    -C /home/dennieseth/dev/assembled-board/worktrees/T-0460 \
    "Reply with exactly the word PONG and nothing else."
{"type":"thread.started","thread_id":"01a15e5e-03a6-75d2-be25-21666ce4ca47"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
{"type":"turn.completed","usage":{"input_tokens":14180,"cached_input_tokens":0,...}}
```

And it reads real file content for real, via its own real sandboxed tool call (not a special
case -- this is the exact same command-execution mechanism that failed over UNC above):

```
{"type":"item.started","item":{"type":"command_execution","command":"/bin/bash -lc 'head -n 1 CLAUDE.md'", ...}}
{"type":"item.completed","item":{"type":"command_execution","command":"/bin/bash -lc 'head -n 1 CLAUDE.md'",
  "aggregated_output":"# assembled\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"type":"agent_message","text":"# assembled"}}
```

`CLAUDE.md`'s real first line is `# assembled` -- this is a genuine read, not a hallucinated
answer.

**Resolution: the runtime question resolves in favor of a validated path that works, but it is
"install the native Linux build and run it natively inside WSL," not either of the two
Windows-side options the card enumerated.** The mode-bit/ownership hazard the card named for the
UNC route never became relevant, because the working route never crosses that boundary at all.

## 2. Least-privilege and read-only-on-source, demonstrated

Asked (same native-Linux setup) to write a file:

```
{"type":"item.completed","item":{"type":"agent_message",
  "text":"The write failed. Error message verbatim:\n\n```text\n/bin/bash: line 1: codex-write-probe.txt: Read-only file system\n```"}}
```

That's a kernel-level `EROFS` from bash itself, not a prompt-level refusal -- `codex exec -s
read-only` bind-mounts the filesystem read-only via its Linux sandbox (`bwrap`/bubblewrap,
present under the npm package's `vendor/.../codex-resources/bwrap`), so "read-only" is an OS
guarantee here, not an instruction the model could be talked out of.

```
$ git status --porcelain   # before AND after every probe above
(empty)
$ node -e "...fs.statSync('CLAUDE.md')..."
mode 664 uid 1000 gid 1000   # unchanged ext4 worktree file -- no UNC crossing, so no mode-bit hazard either
```

`CodexCliRunner.buildInvocation()` (`tools/board/src/runner/codexCliRunner.js`) hardcodes
`-s read-only --skip-git-repo-check` into argv; the sandbox mode is **not** a constructor option
or a `start()` parameter (see its class docstring) -- there is no input, including a hostile
string placed in the prompt itself, that reaches argv as a flag. Tested explicitly:
`codexCliRunner.test.js`'s "never emits a flag that bypasses the sandbox..." and "has no
constructor or buildInvocation option that can change the sandbox mode..." cases feed
`--dangerously-bypass-approvals-and-sandbox` and `-s danger-full-access` through every available
input channel and assert none of it reaches argv.

**Grants enumerated, each with why it's needed (the env allowlist in
`codexCliRunner.js`'s `DEFAULT_ENV_ALLOWLIST`):**

| Var | Why needed |
|---|---|
| `PATH` | Codex spawns its own command-execution children (bash/powershell) for tool calls; without `PATH` those children can't resolve `bash`/`head`/etc. |
| `HOME` | ordinary process home-dir resolution (not Codex-specific) |
| `LANG`, `LC_ALL`, `TERM`, `TZ` | locale/terminal plumbing, same as `ClaudeCliRunner`'s identical set |
| `CODEX_HOME` | points at the auth/config directory this adapter authenticates against -- explicit rather than inherited, so a reviewer run never silently falls back to some other identity's default `~/.codex` |

**Nothing else is in the allowlist.** No network credential beyond what `CODEX_HOME` resolves, no
write-capable board API grant, no `git push`/`gh` access. `codexVerdictPublisher.js`'s own test
("the publisher is ordinary, deterministic code") asserts its return shape has no `merge` or
`approved` key and nothing in the pipeline from "model text on stdout" to "verdict archive entry"
passes through any call the model's own output could have made directly -- the model never has a
tool that writes to `tasks/.verdicts/`; only the separate, non-sandboxed Node process running
`runCodexReview.js` does, after the child has already exited.

**Unused-grant check:** every var in the allowlist above is used by this run (`PATH` by the
sandboxed command-execution children, `CODEX_HOME` by auth, the rest by ordinary process setup).
Nothing broader was requested or granted -- the real review ran with exactly this set, no `sudo`,
no `--dangerously-bypass-approvals-and-sandbox`, no network access beyond the OpenAI API call
itself.

## 3. Authentication, validated non-interactively, no secret anywhere

`CODEX_HOME=/mnt/c/Users/denni/.codex` resolves `auth.json` (3997 bytes). Its **shape**, never
its values:

```
{
  "auth_mode": "string(len=7)",
  "OPENAI_API_KEY": "object",
  "tokens": {
    "id_token": "string(len=1772)",
    "access_token": "string(len=1766)",
    "refresh_token": "string(len=211)",
    "account_id": "string(len=36)"
  },
  "last_refresh": "string(len=27)"
}
```

(ChatGPT-OAuth-style tokens -- `auth_mode` is almost certainly `"chatgpt"` given its length, but
that's an inference from the length, not a read of the value.) Every `codex exec` invocation in
this spike ran with no TTY, no browser, no interactive prompt, and authenticated successfully
every time (`PONG` and the real-file-read probes above both exited 0 with no auth error). **No
run log, prompt, stdout capture, or this document ever contains a token value, a key fragment, or
anything beyond the shape/length/location recorded above.** Every grep of this spike's own
produced files (tests, source, this doc) for the literal strings `access_token`, `refresh_token`,
`id_token`, `OPENAI_API_KEY` turns up only the schema-shape line above and the field *name* in
`codexCliRunner.js`'s docstring explaining what `CODEX_HOME` points at -- never a value.

**What this does not validate:** the credential reused here is Dennie's own interactive
developer login on his Windows machine, reached read-only from WSL. That is adequate to prove the
mechanism (non-interactive auth works at all, under the board's restricted env-allowlist) but is
not a production credential story -- a real board job should authenticate as its own
least-privilege service identity, not a developer's personal OAuth session. **This is this
spike's single most important "assumed, not proven" item** -- see §13.

## 4. The one real review

**Exactly one.** Job id `T-0460-2026-10-21T12-19-45-975Z` (minted by `createRunLog`, the same
function `runOrchestrator.js` uses for every other agent's run -- see §9), dispatched against
**this card's own real worktree, at commit `2abe5f97097d1779a74775ceaef177036bb56503`** (the
`codexResultExtractor.js` implementation commit, at the time this review ran). Invoked by
`tools/board/scripts/runCodexReview.js`, which calls `CodexCliRunner.start()` the same way
`runOrchestrator._runPhase` calls any `AgentRunner.start()` -- see §9 for exactly what's reused
and what isn't yet.

Real cost/usage, straight from the CLI's own `turn.completed` event, never estimated:

```json
{"input_tokens":109025,"cached_input_tokens":79616,"cache_write_input_tokens":0,"output_tokens":1429,"reasoning_output_tokens":25}
```

Wall-clock: **44746 ms** (started `2026-10-21T12:19:45.976Z`), exit code 0, not timed out.

**The raw structured result, exactly as returned** (extracted by `codexResultExtractor.js` from
the model's final `agent_message`, before any reformatting):

```json
{
  "job": {
    "jobId": "T-0460-2026-10-21T12-19-45-975Z",
    "ticketId": "T-0460",
    "sprintId": "spike"
  },
  "reviewedSha": "2abe5f97097d1779a74775ceaef177036bb56503",
  "acceptanceCriteriaVersion": "2026-10-21",
  "outcome": "CHANGES_REQUESTED",
  "findings": [
    {
      "file": "tools/board/src/runner/codexVerdictPublisher.js",
      "line": 91,
      "evidence": "Duplicate detection and append are separate asynchronous operations without locking. An in-memory reproduction with two concurrent identical deliveries returned published twice and appended two entries, violating exactly-once delivery."
    },
    {
      "file": "tools/board/src/runner/codexVerdictPublisher.js",
      "line": 134,
      "evidence": "Identity validation omits job.sprintId. A schema-valid payload with a different sprintId can publish PASS instead of being rejected."
    },
    {
      "file": "tools/board/src/runner/codexVerdictPublisher.js",
      "line": 143,
      "evidence": "Missing or empty currentHead bypasses HEAD validation. An in-memory reproduction with currentHead omitted published PASS without confirming the reviewed revision is current."
    }
  ],
  "checksPerformed": [
    "Ran git rev-parse HEAD and confirmed the exact requested SHA.",
    "Inspected codexCliRunner.js, codexVerdictPublisher.js, codexVerdictSchema.js, publisher tests, and verdictArchive.js.",
    "Ran npx vitest run test/runner/codexCliRunner.test.js test/runner/codexVerdictPublisher.test.js test/runner/codexVerdictSchema.test.js test/runner/codexResultExtractor.test.js from tools/board; exited 1 before tests started.",
    "Ran Node reproductions using injected in-memory archive functions; confirmed duplicate concurrent publication and publication with mismatched sprint identity and absent currentHead."
  ],
  "limitations": [
    "Vitest startup was blocked by EROFS when Vite attempted to create a bundled configuration file under node_modules/.vite-temp; no test results were obtained.",
    "Review was bounded to the requested modules and supporting publisher code. No files were modified."
  ]
}
```

**This verdict is genuine, not rubber-stamped, and all three findings are real.** The command log
inside the run's own NDJSON stream shows it actually executing reproduction scripts (via its
read-only `bash` tool call) rather than asserting from static reading alone -- e.g. it ran a
`node --input-type=module` snippet that called `publishCodexVerdict` twice concurrently via
`Promise.all` with injected in-memory archive functions, and reported the real result (`published`
twice, 2 entries) before writing finding #1. All three findings were fixed in this same card's
own follow-up commits (test-first, per conduct.md) -- see §8's note and the two commits titled
"failing tests for 3 real findings..." / "close the sprintId/currentHead/concurrency gaps...". The
card's own instruction is "exactly ONE... do not broaden to a batch" -- the fixes that followed
were **not** a second review; they were ordinary bug-fixing in response to the one review's
output, exactly the workflow a production wiring would produce.

Its own self-reported limitation is itself a finding worth keeping: `npx vitest run` failed with
`EROFS` under the read-only sandbox when Vite tried to write a bundled temp config under
`node_modules/.vite-temp` -- **a read-only reviewer cannot actually execute a test suite that
needs its own scratch-write, even a transient one, and it said so rather than silently claiming
"tests passed."** That's the structured verdict's `limitations` field doing exactly the job it
exists for. A production wiring needs its own answer to this (a writable scratch dir mounted
alongside the read-only source tree, most likely) -- noted as unresolved in §13, not solved here.

## 5. Structured result schema

`tools/board/src/runner/codexVerdictSchema.js`'s `validateCodexVerdictPayload` is the schema,
enforced as plain data validation (20 test cases in `codexVerdictSchema.test.js`): `job.{jobId,
ticketId, sprintId}` all required non-empty strings; `reviewedSha` a 40-hex-char git SHA;
`acceptanceCriteriaVersion` a non-empty string; `outcome` exactly one of `PASS` /
`CHANGES_REQUESTED` / `BLOCKED` (`CODEX_VERDICT_OUTCOMES`); `findings[]` each carrying `file`
(string), `line` (integer), `evidence` (string); `checksPerformed[]` and `limitations[]` both
string arrays. §4 above is this schema satisfied by a real run, not a synthetic example.

## 6. A failed process or invalid result is BLOCKED, never PASS

`codexVerdictPublisher.js`'s `runResult.kind !== "payload"` branch (non-zero exit, spawn error,
timeout) and its schema-invalid branch both append `outcome: "BLOCKED"` and nothing else --
there is no code path from "process failed" or "payload doesn't validate" to `PASS`. Tested
explicitly, one case per failure mode, in `codexVerdictPublisher.test.js`'s "failed process or
invalid result is BLOCKED, never PASS" block: non-zero exit, timeout, truncated/unparseable JSON,
a payload missing `outcome` entirely, and a payload missing `findings` entirely -- each asserts
`result.outcome === "BLOCKED"`, and the truncated-JSON case additionally asserts the entry text
never matches `/no findings/i`, i.e. it never silently degrades into looking like a clean pass.

## 7. The deterministic publisher

`publishCodexVerdict` (`codexVerdictPublisher.js`) is ordinary async JS -- no model call inside
it, called *after* the child process has already exited and its stdout has already been fully
captured and parsed by `codexResultExtractor.js`. It validates, in order: cancellation,
process/parse failure -> BLOCKED, schema (§5) -> BLOCKED, identity (`job.jobId`/`ticketId`/
`sprintId`, `reviewedSha`, and -- as of this fix round -- `acceptanceCriteriaVersion`, all
matching what was dispatched) -> reject if not, current head vs. dispatched sha -> superseded if
moved (§8a), and only then reaches the exactly-once delivery claim (§8b) that actually appends via
`verdictArchive.appendVerdictEntry` (§9). **FIX ROUND finding (b):** a schema-valid,
identity-matching payload naming the right job/ticket/sprint/sha but a STALE
`acceptanceCriteriaVersion` used to publish as `PASS` against a superseded contract for the same
commit, because the identity check never compared it. `dispatchedJob.acceptanceCriteriaVersion` is
now a required field (same enforcement tier as `jobId`/`dispatchedSha` -- a caller that omits it
gets a thrown error, not a silent skip) and is part of the identity comparison; a mismatch rejects
the same way a wrong `sprintId` already did, and the verified value is persisted on the entry
itself (`entry.acceptanceCriteriaVersion`) rather than only living in the rendered text. Tested in
`codexVerdictPublisher.test.js`'s "rejects a result whose acceptanceCriteriaVersion doesn't match"
and "requires dispatchedJob.acceptanceCriteriaVersion" cases. Its return shape is asserted (test: "never
mutates or returns anything granting merge authority...") to contain only
`status/outcome/entry/reason/errors/freshReviewRequested/currentHead` -- no `merge`, no
`approved`, nothing a caller could misread as authority to do anything beyond recording a
verdict. There is no code anywhere that lets the *model's own output* call this function or any
function that writes to the filesystem -- the model's only channel out is stdout text, consumed
by `codexResultExtractor.js` as inert data.

## 8. Head-moved and exactly-once, both fixed from the one real review's own findings

### 8a. A head that moved during review

`publishCodexVerdict`: if `currentHead !== dispatchedJob.dispatchedSha`, the entry is still
appended (never discarded, never silently dropped) with `heading: "Codex Review: SUPERSEDED"`,
preserving `payload.outcome` (what the model actually said) alongside `superseded: true` and
returning `freshReviewRequested: true`. Exercised in `codexVerdictPublisher.test.js`'s "a head
that moved during review" test: dispatch against SHA A, model reviews SHA A and returns PASS,
`currentHead` is SHA B at publish time -- result is `status: "superseded"`, the PASS is retained
in the entry (not discarded, not applied as if it covered SHA B), `freshReviewRequested: true`.
Where it lands: the same `tasks/.verdicts/<id>.jsonl` archive every other verdict lands in (§9) --
there's no second file or state for a superseded verdict, just this flag on an ordinary entry.
*(The real review this card ran did not hit this path -- `currentHead` and `dispatchedSha` were
identical, since nothing else landed on this branch mid-review -- this is proven by the targeted
unit test above, not by the one real run.)*

### 8b. Exactly-once, including under real concurrency -- not by relying on timing

**This is the one place the real review changed the actual mechanism, not just added a test.**
The original implementation (visible in this card's own git history, commit `87cbd834`) was
read-existing-entries-then-append -- two separate `await`s with nothing between them. The real
review reproduced the race live, inside its own sandboxed shell, with two concurrent calls to
`publishCodexVerdict` sharing an in-memory fake archive and no lock: both calls read "not found
yet," both appended, two entries landed for one `deliveryId` (quoted verbatim in §4's finding
for `codexVerdictPublisher.js:91`).

The fix (commit `afecfd7d`): `defaultClaimDelivery` creates a per-`(taskId, deliveryId)` marker
file with `fs.open(path, "wx")` -- POSIX exclusive-create, which the OS itself rejects for a
second caller, not this process's own bookkeeping. This is the same atomic technique
`tools/board/src/runner/launchReservation.js` already uses for launch slots (`fs.link`-based
there, `fs.open(..., "wx")` here -- different primitive, same "let the filesystem adjudicate the
race" idea) -- reused *pattern*, not reused *code*, because launch slots and verdict deliveries
are different resources with different lifetimes. Whichever caller's `claimDeliveryFn` resolves
`true` proceeds to process and append; the other reads back whatever the winner produced and
returns `status: "duplicate"`.

Tested two ways: `codexVerdictPublisher.test.js`'s original "exactly-once on duplicate delivery"
block (sequential retry/replay -- a caller awaiting the first publish fully before retrying) and
the new "exactly-once under real concurrency, not just sequential retries" block, which fires two
`publishCodexVerdict` calls via `Promise.all` with no `await` between them and asserts exactly
one `published` + one `duplicate`, one archive entry. **The mechanism that makes this exactly-once
is the exclusive-create marker, not timing** -- the test proves it holds even when both calls are
racing in the same event-loop tick.

**FIX ROUND finding (a), P2 (Dennie, review of #452): a failed append used to permanently consume
the delivery.** The marker above was a one-shot flag: its mere existence was read as "already
published," but existence only ever proved a claim was *made*, not that it *finished*. Dennie's
review reproduced it directly against the real filesystem claim and archive reader: fail only the
first `appendEntryFn` call, and the retry read back `{ status: "duplicate", entry: null }` --
nothing was ever actually published, forever. Deleting the marker in a `catch` would not have
fixed this either, since a real process death (not an in-process throw) never reaches a `catch` at
all.

The fix makes the marker a durable, recoverable delivery record (`publishEntryExactlyOnce` in
`codexVerdictPublisher.js`, exported path via `deliveryMarkerPath`):
- A fresh claim writes `{ pid, claimedAt }` (atomically, via the same temp-file-then-`fs.link`
  technique `launchReservation.js` uses), then appends, then overwrites the marker to
  `{ completed: true, entry }`. An append that throws **releases** the claim (deletes the marker)
  before re-throwing, so a sequential retry in the same still-alive process redoes the whole
  attempt from scratch rather than reading back a permanently stuck claim.
- A claim that already exists is resolved by reading it, not trusted blindly: `completed: true`
  means genuinely already published (return the stored entry); not completed but the archive
  (checked directly, never just the marker) already has this `deliveryId` means the append landed
  but the process died before marking completion -- repair the marker, do not append a second
  time; not completed, no archive entry, and the recorded `pid` is still alive means a genuinely
  concurrent in-flight delivery, not a crash -- defer to it rather than race its own append; not
  completed, no archive entry, and the recorded `pid` is dead means a stale claim left by a
  process that died before finishing -- reclaim it.

**FIX ROUND 2 (Dennie, human comment (a), P2): the first fix's own recovery step used a SECOND
exclusive marker (`<marker>.takeover`) to arbitrate reclaiming a stale claim, and that marker had
the identical defect the first marker was fixed for, one level up.** Its mere existence proved a
takeover was *claimed*, never that it *finished* -- a crash between creating `.takeover` and its
own append returning left it behind forever, and every later attempt lost the race to a dead pid's
marker and returned duplicate/empty permanently. Collapsed to a single marker per `(taskId,
deliveryId)`: reclaiming a stale claim is now just removing it and looping back to the SAME
`createMarkerAtomic` exclusivity check a brand-new claim uses -- "crash during a recovery attempt"
and "crash during the original claim" are the identical code path, so there is no
recovery-specific state left that can get permanently stuck. On every successful claim -- first
attempt or reclaim -- the archive is re-read and treated as authoritative BEFORE appending, never
after, closing exactly the gap a dead claimant that *did* manage to append (but died before
marking its own marker complete) would otherwise hit.

All four cases Dennie's original review named are each their own test in
`codexVerdictPublisher.test.js`'s "recoverable delivery, not a one-shot claim that can strand a
delivery forever" block: append failure (a `vi.fn` that throws once then succeeds, retried in the
same process), process death before append (a marker pre-written by hand with a dead `pid`,
recovered and actually published), process death after append but before completion marking (same
dead-`pid` marker, but the archive already has the entry -- recovery must not double-append), and
simultaneous retry of the same stale claim (`Promise.all` against the same dead-`pid` marker,
still exactly one append). FIX ROUND 2 adds: a dead claim left by a *crashed recovery attempt*
(not the original claimant) still recovers through the same single marker, asserting no
`.takeover` file is ever created; two AND three simultaneous recovery attempts against the same
stuck claim still leave exactly one archive entry; and the archive being re-checked as
authoritative before any append during recovery, even when the marker was never marked completed.
`isPidAliveFn` defaults to the real `isPidAlive` (`tools/board/src/runner/runState.js`) -- reused,
not reinvented, the same staleness idiom `boardOwnership.js`'s `acquireBoardOwnership` already
applies to a different lock.

This same mechanism is what "restart recovery" (the card's edge case) reduces to: a board process
that crashes mid-review and restarts, then replays a persisted result (from `tasks/.runs/<id>.jsonl`,
§9) into the publisher again, hits exactly this duplicate-delivery path. **This was exercised, not
just described** -- via the concurrency test above, which is the identical code path a restart's
replay would take (a second `publishCodexVerdict` call with the same `deliveryId`), even though no
real board process was literally killed and restarted in this spike. That's the "may be mocked"
allowance the card grants, used explicitly rather than silently.

**Duplicate delivery -- result: exactly one visible entry**, demonstrated by the same test.

**Cancellation -- result: rejected, not published.** `publishCodexVerdict({ cancelled: true, ...
})` returns `{ status: "rejected", reason: "job-cancelled" }` and calls `appendEntryFn` zero
times -- tested directly ("a result arriving after the job was cancelled"). This is a real,
exercised code path, not a description: the test asserts `archive.appendEntryFn` was never
called.

**Timeout -- result: the child is killed, `run.timedOut` is set.** `CodexCliRunner.start()`'s
`timeoutMs` option (default `DEFAULT_TIMEOUT_MS`, 10 minutes) arms a timer that, if the child
hasn't exited by then, sets `run.timedOut = true` and calls `this.kill(run)` -- the same
SIGTERM-then-SIGKILL-on-process-group escalation `ClaudeCliRunner` already uses (`kill()`'s
10-second default escalation, from `runState.js`'s shared `DEFAULT_KILL_ESCALATION_MS`). Tested
with `vi.useFakeTimers()` driving the real timer/kill code path (not a description of intended
behavior) in `codexCliRunner.test.js`'s "wall-clock timeout" block, including a case proving the
timer is cancelled (via the child's own `exit` event) once the child finishes normally, so a
healthy run is never killed for finishing slowly-but-within-budget. **Mocked**: the real review
in §4 finished in 44.7s, nowhere near the 8-minute budget it ran under
(`CODEX_REVIEW_TIMEOUT_MS=480000`), so the timeout path itself was never exercised by a real
process in this spike -- only by the fake-timer unit test.

**"Kill the board mid-review" (an actual process kill, not a timeout or cancellation signal) --
exercised, mocked.** A real VALIDATION round correctly flagged the original version of this
section: nothing in this spike exercised "the whole board process died and something else
noticed," only "the adapter's own `kill()` works" (`codexCliRunner.test.js`'s process-group
tests). Fixed two ways:

1. `runCodexReview.js` now calls `writeRunState`/`clearRunState` around the review exactly the
   way `runOrchestrator.js`'s `_runPhase` does for every other agent's phase (right after
   `runner.start()` returns, and on the way out once the run's span ends) -- so a Codex review in
   flight when the board dies leaves the identical liveness evidence on disk any other phase
   would, and needs zero Codex-specific recovery code to be found by...
2. ...the board's *existing* `orphanReaper.js` sweep, exercised directly in
   `test/runner/codexBoardKillRecovery.test.js` against that exact runstate shape, mocked via the
   same `isPidAliveFn`-injection pattern `orphanReaper.test.js` already uses (no real board process
   was killed): one case where the detached `codex` child outlives the dead board (pid still
   alive) -> `reapOnStartup` re-adopts the card, leaving it `in-progress`, untouched; one case
   where the child died along with the board (pid confirmed dead, stale heartbeat, no
   corroborating fresh log) -> `reapOnStartup` reaps it to `blocked` with the standard recovery
   note, the same outcome any other crashed phase gets.

What the adapter did: nothing Codex-specific -- it participates in the same runstate bookkeeping
every other phase already does. What the board saw: `reapOnStartup`'s existing liveness verdict,
unmodified. What the subject card was left showing: `in-progress` (readopted) or `blocked`
(reaped), per the two cases above.

**FIX ROUND correction (Dennie, review of #452, finding (c)):** `codexBoardKillRecovery.test.js`
above writes its mocked runstate under the SUBJECT CARD's own bare `taskId` -- it demonstrates
that a card's own in-progress run survives a board restart via the existing reaper, which is real
and still correct, but it is **not** a demonstration of what happens when the *review job itself*
(not the subject's own implementer/reviewer phase) dies mid-review. Before this fix round,
`runCodexReview.js` wrote its OWN liveness under that exact same bare `taskId` key -- the same key
the subject card's own implementation run uses -- so starting a review while the card's real run
was active stomped that run's pid, and a review-job crash would have `orphanReaper.js` reap the
*subject card* to `blocked` with a "run did not complete" note over a smoke-test review dying, not
the card's own work. `runCodexReview.js` now writes/reads/clears its own liveness under
`reviewRunStateKey(taskId)` (`${taskId}.codex-review`, `scripts/runCodexReview.js`'s
`reviewRunStateKey`) -- a key `orphanReaper.js` never looks at, because it only iterates real board
cards by their real id. This is a deliberate, simpler answer than reusing orphanReaper for the
review job's own crash: **the subject card is left completely untouched by a review-job crash**
(correct, since the review is not part of the subject's own lifecycle), and the review job's own
staleness is instead self-resolved the next time `runCodexReviewJob` runs -- see the two
precondition checks below. No orphanReaper-style sweep exists for a permanently-stale
`*.codex-review.runstate.json` file left by a process that both wrote it and then hard-crashed
before any later invocation ever re-checked it; that gap is named here, not solved, since this
spike's own review was never run twice back-to-back against a real crash.

**Two preconditions are now code-enforced, not just named (closing the §12 "not checked" gap and
the acceptance item "the duplicate-start case being refused rather than overwriting a runstate"):**
`runCodexReviewJob` (`scripts/runCodexReview.js`) calls, in order:

1. `readRunState({ runsDir, taskId })` + `isRunLive(...)` against the **subject's own bare
   `taskId`** -- read-only, never written by this script. A live result means the card's own
   implementer/reviewer run is still writing to the worktree; the job refuses to start and
   publishes an immediate `BLOCKED` verdict (`reason: "subject-mid-run"`) through the same
   publisher path §6 describes, rather than reviewing a moving tree.
2. `claimReviewSlot({ runsDir, cardId: reviewRunStateKey(taskId), owner })` against the **review
   job's own reservation key** -- see the FIX ROUND 2 note immediately below for why this replaced
   a second `readRunState`/`isRunLive` pair.

**FIX ROUND 2 (Dennie, human comment (b)): the duplicate-start guard was read-then-write, not
atomic.** The original precondition 2 called `readRunState` against the review job's own key,
decided "not live," and only *later* -- after `runner.start()` had already returned -- called
`writeRunState` to record its own pid. That left a real window between the read and the write:
two concurrent invocations could both read "not live" and both pass, both spawn a `codex` child,
and both race to publish. Dennie's review named `launchReservation.js`'s `reserveLaunchSlot`/
`releaseReservation`/`DuplicateReservationError` -- already in this codebase for launch-slot budget
bookkeeping, built on the identical temp-file-then-`fs.link` atomic primitive `codexVerdictPublisher.js`
uses for delivery claims (§8b) -- as the existing machinery to reuse instead of inventing a third
locking scheme.

`claimReviewSlot`/`releaseOwnedReviewSlot` (`scripts/runCodexReview.js`) are the result:
- `claimReviewSlot` reserves a lease keyed by `(cardId: reviewRunStateKey(taskId), executionId:
  "codex-review", invocationId: "lock")` -- fixed per card, so two concurrent callers for the same
  card collide on the IDENTICAL key and the filesystem's own atomic `link` decides which one wins,
  not either caller's own bookkeeping. This is taken **before** `createRunner`/`runner.start()` is
  ever called, not after -- the acceptance item this round added specifically to close the old
  precondition's race window.
- `launchReservation.js` never deletes a lease file itself (an append-only ledger by design), so
  reusing the identical key for every review of this card needs its own recycling step: on
  `DuplicateReservationError`, the existing lease is read directly and reclaimed (removed, then one
  retry) when it is already marked `released`, or when its recorded owner `pid` is no longer alive
  (`isPidAlive`, the same primitive `codexVerdictPublisher.js`'s own stale-claim recovery uses) --
  so a review that was killed outright, not merely one that threw and released cleanly, still
  frees the slot for the next attempt. This is the answer to the card's own edge case ("state
  explicitly how the claim becomes reclaimable") for this synthetic key, which `orphanReaper.js`
  never sweeps (§13).
- `releaseOwnedReviewSlot` only releases a lease still recorded under the CALLING owner's own pid
  -- a lease some other process now holds (a foreign claim, or one reclaimed out from under a run
  that still thought it owned it) is left untouched, never released out from under its real owner.
- The claim is released on every path out of `runCodexReviewJob`: the happy path (after
  `clearRunState`), and a thrown `runner.start()` (edge case: "a crash between taking the claim and
  spawning... the claim must not strand the card forever" -- a thrown `start()` never produced a
  child to track, so the claim is simply freed and the error rethrown).

Exercised in `test/runner/runCodexReviewJob.test.js`: refusal without constructing a runner; the
claim using the review job's own key, never the subject's bare `taskId`; claim-before-`createRunner`
ordering; release on the happy path and on a thrown `start()`; and -- the acceptance item asking
for real concurrency, not a mock -- a dedicated describe block drives TWO simultaneous
`runCodexReviewJob` calls against a real temp directory and the REAL `claimReviewSlot`/
`releaseOwnedReviewSlot` (not stubbed), asserting exactly one child is ever spawned and the other
refuses with `reason: "review-already-in-flight"`. A separate `claimReviewSlot`/
`releaseOwnedReviewSlot` unit block (also against a real temp dir) covers: two simultaneous claims
for the same card (exactly one wins); a released lease not blocking a later review; a dead-pid
lease being reclaimable; a live-pid lease NOT being reclaimable (refused, not raced); and release
being a no-op when the lease on disk is recorded under a different pid.

The happy-path lifecycle calls are now: mint `createRunLog` -> check precondition 1 -> claim the
review slot (precondition 2) -> `createRunner`/`runner.start()` -> `writeRunState` (review key,
unchanged, still the liveness bookkeeping `orphanReaper.js`-adjacent observability relies on) ->
stream the child's stdout into the run log as it arrives (durably; see the finding below) ->
`publishCodexVerdict` -> `clearRunState` (review key) -> release the review slot. This closes part
of §9's old "named but not wired in" note: `launchReservation.js` IS now wired in, for this one
job's own single-flight exclusivity. It is still not full *dispatch-level* exclusivity across the
live orchestrator's phase sequencing (`boardOwnership.js`'s cross-process ownership is still
untouched) -- see the updated §9/§13 below.

**FIX ROUND finding, same round: streamed evidence is now durable, not buffered until exit.**
Before this fix round, `runCodexReview.js` only called `runLog.append()` in a loop over the
fully-buffered `stdout` string *after* the child had already exited -- a crash between the last
flushed chunk and that post-hoc loop lost every event collected so far, since none of it had
reached disk yet. `runCodexReviewJob` now feeds each `stdout` chunk into a `NdjsonEventParser`
(`src/runner/streamParser.js`, the same line-buffering parser `ClaudeCliRunner`'s own stream
consumer uses) whose `onEvent` callback calls `runLog.append()` immediately, chunk by chunk, as
data arrives -- proven in `runCodexReviewJob.test.js`'s "streams NDJSON events into the run log
durably" test, which asserts an event appended to the log *before* the child's `exit` event ever
fires.

## 9. Reuses the board's existing machinery

| What | File:line / module | How this spike uses it |
|---|---|---|
| `AgentRunner` interface | `tools/board/src/runner/agentRunner.js` | `CodexCliRunner extends AgentRunner`, the same `start/observe/kill` contract `ClaudeCliRunner` implements -- a second sibling, not a second coordinator |
| Per-run audit log + `BOARD_RUN_ID` minting | `tools/board/src/runner/runLog.js`'s `createRunLog` | `runCodexReview.js` calls it identically to how `runOrchestrator._runPhase` does, and threads the same `runId` into the child's env as `BOARD_RUN_ID`, matching `ClaudeCliRunner`'s own convention |
| Verdict archive (exactly-once-per-card append store) | `tools/board/src/lib/verdictArchive.js`'s `appendVerdictEntry`/`readVerdictEntries` | `codexVerdictPublisher.js` calls these directly -- the same store `runOrchestrator._handlePass`/`_handleFailValidation` already write to for Claude verdicts |
| Atomic exclusive-create as the concurrency primitive | pattern from `tools/board/src/runner/launchReservation.js` (temp-file + `fs.link`) | `publishEntryExactlyOnce`'s delivery claim marker uses the identical temp-file-then-`fs.link` technique (§8b, FIX ROUND 2 (a)) |
| Atomic launch-slot reservation lifecycle | `tools/board/src/runner/launchReservation.js`'s `reserveLaunchSlot`/`releaseReservation`/`DuplicateReservationError` -- the same module `cardLaunch.js` uses for budget reservations | `scripts/runCodexReview.js`'s `claimReviewSlot`/`releaseOwnedReviewSlot` reuse this directly for the review job's own single-flight exclusivity -- a genuinely new wiring, not a pattern-only reuse (§8b, FIX ROUND 2 (b)) |
| Pid-liveness staleness check | `tools/board/src/runner/runState.js`'s `isPidAlive`, the same idiom `boardOwnership.js`'s `acquireBoardOwnership` applies to its own lock | `publishEntryExactlyOnce` and `claimReviewSlot` both use it to tell a genuinely concurrent in-flight claim apart from a stale one left by a dead process (§8b, FIX ROUND 2 (a) and (b)) |
| Process-group kill/escalation constant | `tools/board/src/runner/runState.js`'s `DEFAULT_KILL_ESCALATION_MS` | `CodexCliRunner.kill()` uses it exactly as `ClaudeCliRunner.kill()` does |
| Liveness runstate + crash-recovery sweep | `tools/board/src/runner/runState.js`'s `writeRunState`/`clearRunState`, `tools/board/src/runner/orphanReaper.js`'s `reapOnStartup`/`sweepOnce` | `runCodexReview.js` writes/clears a runstate record the same way `runOrchestrator.js`'s `_runPhase` does for every phase -- a board restart mid-review is recovered by the existing reaper, zero Codex-specific recovery code (see §8b's "kill the board mid-review" fix and `codexBoardKillRecovery.test.js`) |

**Named but not fully wired in** (deliberately, for a spike -- see §13): `runOrchestrator.js`'s
`_runPhase` (the one call site that invokes `this.runner.start(...)` for every phase) is where a
real `agent: "codex-reviewer"` dispatch branch would plug in, selecting a `CodexCliRunner`
instance instead of `ClaudeCliRunner` for that phase. This spike does not touch that file --
changing the live orchestrator's dispatch table is a bigger, riskier change than a spike should
make to a production service every other in-flight card currently depends on. FIX ROUND 2 (b) DOES
now wire `launchReservation.js` into this review job's own single-flight exclusivity (one review of
one card at a time, via `claimReviewSlot`/`releaseOwnedReviewSlot`) -- what remains unwired is
`boardOwnership.js`'s cross-process ownership and the live orchestrator's own dispatch table, which
a full *dispatch-level* integration (the orchestrator choosing between `ClaudeCliRunner` and
`CodexCliRunner` for the same phase slot) would still need. This spike's own concurrency fixes are
at two narrower levels instead: the *delivery* level (two deliveries of the same already-produced
result, §8b FIX ROUND 2 (a)) and the *single-job* level (two invocations of this one review job for
one card, §8b FIX ROUND 2 (b)) -- neither duplicates or bypasses `boardOwnership.js`, which remains
untouched.

T-0444 (reviewed/verified/current-sha binding), T-0446 (harness-owned receipts), and T-0454
(event-driven wake-up) don't exist as code in this worktree to link against (see the top of this
doc). The conceptual seam each would attach to: T-0444's exact-head binding is exactly what §8a's
`currentHead` comparison already does at the single-verdict level -- T-0444's job would be making
that comparison board-wide and persistent rather than per-publish-call. T-0446's receipts would
wrap this spike's own cost/usage recording (§10) in a durable, snapshot-bound form. T-0454's
wake-up would be what eventually calls `runCodexReview.js`'s moral equivalent instead of a human
running it by hand, as this spike's own harness is run.

## 10. Cost and usage

Already stated in full in §4: `input_tokens: 109025`, `cached_input_tokens: 79616`,
`output_tokens: 1429`, `reasoning_output_tokens: 25`, wall-clock `44746 ms`. Recorded in this
committed document (durable, not "too small to matter") and also written locally to
`tasks/.verdicts/T-0460.spike-evidence.json` -- that file is **not committed**, because this
repo's shared `.git/info/exclude` (not a tracked `.gitignore`) excludes the whole `tasks/`
directory; the board's cards moved to a SQLite-backed store (`docs/design/cards-to-database.md`)
and this worktree's local `tasks/` is accordingly treated as scratch state, not committed
evidence. The committed record is this document plus the attachment on the live card (§14).

## 11. Bounded runtime and budget -- enforced, not just configured

**Wall-clock**: enforced preventatively. `CodexCliRunner.start({ timeoutMs })` arms a real timer
that kills the process group if it fires (§8b) -- shown taking effect under `vi.useFakeTimers()`
in `codexCliRunner.test.js`. The real review ran under an 8-minute (`480000`ms) budget and
finished in 44.7s, well inside it.

**Spend ceiling**: enforced reactively, not preventatively -- and now actually implemented, not
just named as a gap. `codex exec --help` (full output captured during this spike's probing) has
no `--max-cost`/`--max-tokens` flag or `-c` config key for a hard pre-spend cap in this version --
the only *preventative* ceiling available from the CLI itself is the wall-clock one above. A
real VALIDATION round correctly flagged the first version of this section for claiming this as
only "the next concrete thing to add" rather than building it. Fixed: `CodexCliRunner.start()`
now parses `turn.completed` events off the same NDJSON stdout stream it already reads for the
wall-clock path, sums each turn's `input_tokens`/`output_tokens`/`reasoning_output_tokens`, and
calls the same process-group `kill()` the timeout path uses the instant the running total crosses
`maxTotalTokens` (default `DEFAULT_MAX_TOTAL_TOKENS`, 500,000 -- comfortably above the one real
review's ~110k actual usage). This is still reactive, not preventative -- the spend that triggers
the breach has already happened by the time it's checked, same honest limitation as before -- but
it is now a real enforced bound: `codexCliRunner.test.js`'s "token budget" block drives it with
synthetic `turn.completed` events and asserts the kill actually fires, including a case proving a
run that stays within budget is never killed and one proving a breach doesn't double-kill.

**FIX ROUND finding (d) (Dennie, review of #452):** `run.budgetExceeded` was set correctly by
`CodexCliRunner.start()` but `runCodexReview.js` never read it -- a budget kill fell through to
the generic non-zero-exit branch and lost the actual reason a human reading the verdict would need
to size the ceiling correctly. `runCodexReviewJob` now checks `run.budgetExceeded` explicitly,
before the generic exit-code branch, and publishes `BLOCKED`/`budget-exceeded` with the configured
`maxTotalTokens` in the detail -- tested in `runCodexReviewJob.test.js`'s "inspects
run.budgetExceeded" case (mocked: no real review was run over budget to test this; the one real
review in §4 used ~110k of the 500k ceiling). **To restate plainly, since the card's own wording
must not overstate this: the 500,000-token figure is a REACTIVE bound, not a guaranteed maximum.**
It can only kill the run *after* a `turn.completed` event reports the breach -- it cannot prevent
the single turn that pushes the cumulative total over the line from completing and being billed,
it can only stop any *subsequent* turn. Whether a reactive-only bound is acceptable for this spike,
or whether a pre-spend ceiling is needed before any further slice, is a scope decision for
@DennieSeth, not something this fix round settles by rewording.

## 12. Edge cases from the card, mapped to what actually happened

| Edge case | What happened |
|---|---|
| Windows binary reaching WSL paths via `\\wsl$\` | Tried first, found genuinely broken for file I/O (§1a) -- not used in the working path, so the mode-bit/ownership hazard never had to be tested; superseded by §1b |
| Codex altering the worktree it reviews | Tested directly: a write attempt hit kernel `EROFS` (§2); `git status --porcelain` clean before and after every probe and the one real review |
| A verdict that cannot be parsed | `codexResultExtractor.js` returns `parse-failure` (never an empty/default payload) for missing, truncated, or invalid-JSON output -- 8 test cases, including "tolerates stray non-JSON lines" (the literal "Reading additional input from stdin..." line this CLI emits) |
| Two invocations racing on one card | Delivery-level race fixed and proven (§8b). Dispatch-level race (two independent launches of a review for the same card) is explicitly **out of scope for this spike** -- it belongs to `launchReservation.js`, not reimplemented here, and nothing in this spike's code assumes exclusivity at that level |
| Auth working interactively but not under the board's restricted env | `DEFAULT_ENV_ALLOWLIST` is the enforced list (§2); `CODEX_HOME` is in it deliberately, as the one Codex-specific var this adapter actually needs -- proven live, since the real review authenticated using only that allowlisted env, not an inherited developer shell |
| The subject card being mid-run | **FIX ROUND: now checked, not just named.** `runCodexReviewJob` (`scripts/runCodexReview.js`) calls `readRunState({ runsDir, taskId })` (`tools/board/src/runner/runState.js:54`) against the subject's own bare `taskId` and passes the result to `isRunLive` (`tools/board/src/runner/runState.js:135`) -- the identical liveness check `orphanReaper.js`'s `checkRunStatus` (`tools/board/src/runner/orphanReaper.js:290`) already runs on every sweep -- before ever constructing a `CodexCliRunner`. A live result refuses to start and publishes `BLOCKED`/`subject-mid-run` through the same publisher path §6 describes, rather than reviewing a moving tree. See §8b's "two preconditions are now code-enforced" paragraph and `test/runner/runCodexReviewJob.test.js`'s "the subject card being mid-run (precondition)" block (mocked: no real concurrent implementer run was started against a real subject card) |
| A reviewer reviewing its own work | **Happened here, knowingly, and the mechanism for knowing is named.** The one real review reviewed T-0460's own in-progress changes -- there was no other real card available in this session to demonstrate against without fabricating one. This is exactly the author-as-reviewer conflict the working agreement forbids. How the adapter would know whose change it is looking at: extract the reviewed range's commit authorship via `git log <baseSha>..<reviewedSha> --format=%ae` (every commit in this repo carries a `Co-authored-by:` trailer per `.claude/rules/conduct.md`, so this reads as a real identity, not an anonymous diff) and compare it against the card's own `agent:` frontmatter field (e.g. `agent: "infra"` in `tasks/T-NNNN.md`, read the same way `runOrchestrator.js` already reads it to pick an implementer persona) -- the persona recorded as the card's author. If the two match, or if the review was dispatched from inside the same session that produced the commits (no separate dispatch identity recorded at all, which is what actually happened here), the adapter would reject dispatch before ever invoking Codex, the same way `codexVerdictPublisher.js`'s identity gate (§7) rejects a job/ticket/sprint/sha mismatch after the fact. Nothing in this spike's code performs that comparison -- `runCodexReview.js` has no author-identity check and no separate "who dispatched this review" field to compare against -- this is a named mechanism, not a solved gap |
| A verdict that validates but describes a different job | Identity check (job/ticket/sprint/sha, §7) rejects without publishing -- 4 test cases, including the sprintId gap the real review found and this card then fixed (§8b intro) |
| A result arriving after cancellation | `cancelled: true` → rejected, zero appends, tested directly (§8b) |

## 13. This spike's own limits

**Proven on this machine, with evidence above:**
- The native Linux Codex build runs non-interactively against a real board worktree, authenticates
  without a prompt, reads real files, and is genuinely blocked from writing by a kernel-enforced
  read-only sandbox.
- One real, non-trivial review ran as a standalone board-style job and produced a structured,
  schema-valid, genuinely-earned `CHANGES_REQUESTED` verdict with three real findings, all fixed.
- The deterministic publisher's identity/schema/head/exactly-once gates are each independently
  tested, including one gate (exactly-once under concurrency) that was *wrong* until the one real
  review found it and a fix landed in this same card -- and whose own FIRST recovery fix (a second
  `.takeover` marker) was itself found wrong by a later human review round and collapsed to a
  single marker (§8b, FIX ROUND 2 (a)).
- The duplicate-start guard is now a genuinely atomic claim, not a read-then-write check: exercised
  under real concurrency (two simultaneous `runCodexReviewJob` calls against the real
  `launchReservation.js` primitives, not mocks) and shown to spawn exactly one child (§8b, FIX
  ROUND 2 (b)).
- Least-privilege: the env allowlist, the hardcoded sandbox mode, and the absence of any
  model-writable code path are each demonstrated, not merely asserted.

**Assumed, not proven:**
- **Production credentials.** This spike reused a developer's own interactive ChatGPT OAuth
  session via `CODEX_HOME` pointed at his Windows profile. A real board job needs its own
  least-privilege service identity -- this was never built or tested here.
- **Dispatch-level exclusivity and board wiring.** `runOrchestrator.js`'s dispatch table was not
  touched; nothing here proves a `CodexCliRunner` behaves correctly inside the live orchestrator's
  phase sequencing, heartbeat/timeout bookkeeping, or `orphanReaper.js` reconciliation -- only that
  it satisfies the same `AgentRunner` contract those systems are written against.
- **A writable scratch path for test execution.** The real review's own limitation (§4): a
  read-only reviewer cannot run `npx vitest` if the test runner needs any scratch write (Vite's
  temp config, in this case). No fix for this was attempted.
- **A review-job crash leaving a permanently-stale `*.codex-review.runstate.json`.** Narrowed by
  FIX ROUND 2 (b), not fully closed. The ACTUAL duplicate-start *gate* is no longer this runstate
  file -- it's `claimReviewSlot`'s `launchReservation.js` lease, which IS reclaimable from a dead
  owner pid (§8b), so a crashed review no longer strands the card behind an ungated stale runstate
  the way the pre-FIX-ROUND-2 mechanism could. `writeRunState`/`clearRunState` under
  `reviewRunStateKey` are still written in parallel, for observability parity with every other
  phase's liveness bookkeeping -- but they no longer gate anything, and nothing sweeps that
  runstate file either if a process hard-crashes before clearing it; `orphanReaper.js` still only
  sweeps real board cards, not this synthetic key. The remaining gap is strictly cosmetic (a stale
  observability file, not a stuck gate) but is still named here rather than silently closed.
- **Dispatch-level exclusivity via `boardOwnership.js`, and the live orchestrator's own dispatch
  table.** Still deliberately not taken. FIX ROUND 2 (b) DOES wire `launchReservation.js` in for
  this one job's own single-flight exclusivity (one review of one card at a time) -- see §8b/§9 --
  but `boardOwnership.js`'s cross-process ownership and `runOrchestrator.js`'s dispatch table are
  untouched; nothing here proves a `CodexCliRunner` behaves correctly inside the live orchestrator's
  own phase sequencing or scheduler-driven dispatch.
- **Pid-recycling.** Both `publishEntryExactlyOnce`'s and `claimReviewSlot`'s staleness checks
  reduce to `isPidAlive(pid)` alone, not corroborated against a second signal the way
  `runState.js`'s `isRunLive` corroborates a not-alive pid verdict against the run log's own mtime
  before trusting it (see that module's own docstring on why pid-existence alone was previously
  implicated in false reaps, T-0276/T-0287). The card's own edge case names this directly: "a
  claim whose recorded pid has been recycled by the OS onto an unrelated live process" would read
  as `isPidAliveFn(pid) === true` and be treated as a genuine live claimant forever, even though
  the actual claimant died. Not fixed in this round -- named here as a gap, not solved, since
  neither marker shape currently records anything (a process start time, a heartbeat) a corroborating
  check could compare against.
- **Author-vs-reviewer identity.** Mechanism named in §12 (commit-range authorship via `git log
  --format=%ae` compared against the card's `agent:` frontmatter) and directly instantiated by
  this spike's own self-review -- not built.

**Explicitly mocked, per the card's own allowance, and said so:** restart recovery (via the
exactly-once concurrency test, §8b), job cancellation (via the direct `cancelled: true` test,
§8b), and "kill the board mid-review" (via `codexBoardKillRecovery.test.js` against the existing
`orphanReaper.js` sweep, §8b) were all exercised through their real code paths with synthetic
triggers -- an injected `isPidAliveFn`, a constructed runstate, a direct `cancelled: true` call --
not a real board process crash, a real cancel signal from a live orchestrator, or a real
`SIGKILL` sent to a live `codex exec` child. Nothing in this spike's own list of edge cases is
left unexercised, mocked or real, as of this round.

**Per the working agreement's own framing (as described in this card, since the doc itself isn't
readable here): a working adapter is milestone 1, not readiness.** This spike establishes that
milestone 1 is reachable on this machine, with a different route than anyone had tried. It does
not establish the service-identity, dispatch-wiring, or scratch-writable-review-environment work
that would make it a reviewer the board actually depends on day to day.

## 14. Test/suite status and gitleaks

- `npx vitest run` (`npm test`) from `tools/board/`: **230 test files, 4602 tests, all passing**
  (includes this card's 6 test files: `codexVerdictSchema.test.js`, `codexCliRunner.test.js`
  (covering the token-budget ceiling, §11), `codexVerdictPublisher.test.js` (covering the
  recoverable-delivery fix, the acceptance-criteria-version identity check, and now FIX ROUND 2
  (a)'s single-marker collapse -- no second `.takeover` file, a dead claim left by a crashed
  RECOVERY attempt still recovers, two/three simultaneous recoverers still leave exactly one
  archive entry, and the archive is re-checked as authoritative before any append during
  recovery), `codexResultExtractor.test.js`, `codexBoardKillRecovery.test.js` (§8b), and
  `runCodexReviewJob.test.js` (the two preconditions, durable streaming, the
  `budgetExceeded`/timeout branches, and now FIX ROUND 2 (b)'s atomic `launchReservation.js` claim:
  refusal without constructing a runner, claim-before-`createRunner` ordering, release on both the
  happy path and a thrown `start()`, a dedicated `claimReviewSlot`/`releaseOwnedReviewSlot` unit
  block against a real temp dir, and a real-concurrency block driving two simultaneous
  `runCodexReviewJob` calls against the genuine atomic primitive), plus every pre-existing test in
  the suite -- no regressions).
- `npm run lint` (`eslint .`) from `tools/board/`: clean.
- `git status --porcelain`: empty at the end of this run (confirmed before stopping).
- **gitleaks: not run.** The `infra` persona (and no persona checked) holds a grant to execute
  `~/.local/bin/gitleaks` -- confirmed by reading `.claude/agents/infra.md`'s tool list, which has
  no `Bash(gitleaks:*)` or equivalent entry. Per `.claude/rules/conduct.md`'s own fallback for
  exactly this situation: this round's new/changed content was kept free of secret-shaped strings
  by construction -- §3 records only auth.json's field names and string *lengths*, never a value,
  and every new file in this round was grepped by hand for `access_token`/`refresh_token`/
  `id_token`/`OPENAI_API_KEY` before this doc was finalized, turning up only the schema-shape
  description itself. This is a manual check standing in for a tool that wasn't available, not a
  claim that an actual gitleaks scan ran.
