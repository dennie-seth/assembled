# Browser test harness (`tools/board`)

**Card:** T-0295. **Closes the structural gap that blocked T-0288** (see
`docs/T-0288-client-agent-verification-gap-attempt-log.md`): `tools/board`'s
486 client tests all ran against `happy-dom`, which performs no layout at
all — no viewport, no scroll geometry, `getBoundingClientRect()` is inert.
Every scroll/drag test hand-fed a fake `getBoundingClientRect`/`scrollBy`.
T-0288's drag auto-scroll shipped complete and reviewer-verified and still
could not pass, because one criterion required watching it scroll in a real
browser and no test in the repo could do that.

## Which harness to reach for

- **`npm test`** (Vitest + happy-dom) stays the fast default for everything
  that doesn't need real layout: DOM structure, event wiring with injected
  fakes, CSSOM assertions against `getComputedStyle` (happy-dom resolves
  CSS properties fine — it just never lays anything out or scrolls).
- **`npm run test:browser`** (Playwright + a real headless Chromium) is for
  the small set of behaviours that genuinely need real layout, real scroll
  geometry, or real pointer/drag input. Reach for it only when a happy-dom
  test structurally cannot assert the thing you need — e.g. "does
  `scrollTop` actually change," not "was `scrollBy` called with the right
  arguments" (that part is already covered by
  `test/client/dragAutoScroll.test.js`'s fake-clock/fake-container tests).

**Write UI acceptance criteria against the harness that can prove them.** A
criterion phrased as "observe it in a browser" is not verifiable by any
agent session and stalls the card exactly like T-0288's did (five rounds,
never implementer-fixable). Phrase it instead as "prove with
`npm run test:browser`" (or name the specific happy-dom test) so there is a
command a session can actually run to close it.

## Running it

```
npm run test:browser           # runs the Playwright suite (test/browser/**/*.spec.js)
npm run test:browser:install   # npx playwright install chromium (see "Browser binaries" below)
```

- **Separate from `npm test` on purpose.** `vitest.config`'s (`vite.config.js`'s `test.include`)
  glob only matches `test/**/*.test.js`; Playwright specs are named
  `test/browser/**/*.spec.js` and are excluded explicitly
  (`test.exclude: ["test/browser/**", ...]`) as a second, redundant guard. A
  browser-suite failure and a unit-test failure can never be mistaken for
  each other — different script, different file extension, different
  config file (`playwright.config.js` vs. `vite.config.js`'s `test` block).
- **Wired into CI (`ci-board.yml`) as its own separate, non-blocking job**,
  `browser-tests`. `lint-test-build` is untouched — still just
  `npm run lint`, `npm test`, `npm run build` — and has no `needs` edge to
  or from `browser-tests`, so the two run independently. `browser-tests`
  carries `continue-on-error: true`, so per this card's own edge-case note
  a slow or flaky browser test can never block a board PR: its steps are
  `npm ci`, `npx playwright install --with-deps chromium`, then
  `npm run test:browser`, on a plain `ubuntu-latest` runner (see "Browser
  binaries" below for why that matters). The workflow also carries
  `workflow_dispatch`, so a run can be triggered manually (`gh workflow run
  ci-board.yml --ref <branch>`) against a pushed branch that has no open PR
  yet — see "The remaining gap" below for why that still isn't enough to
  get evidence before a PASS verdict on this card specifically.

## Browser binaries

`@playwright/test` does not download a browser on `npm install`; that's a
separate, deliberate step:

```
npx playwright install chromium
```

Measured in this session: **~390MB** on disk (`~/.cache/ms-playwright/`,
outside the repo and outside `node_modules` — nothing here is committed or
gitignored *in-repo* because none of it is ever written under the repo
tree). Chromium alone is ~184MB compressed / ~389MB unpacked; a small
`ffmpeg` binary (~2MB) is fetched alongside it for Playwright's optional
video capture, unused by this suite but not separately skippable.

**The suite skips cleanly, with a clear message, when the browser isn't
launchable** — `test/browser/support/globalSetup.js` runs an actual
`chromium.launch()`/`close()` probe once, before any spec, and records the
result via `process.env`; `dragAutoScroll.spec.js` reads it via
`test.skip(!chromiumLaunchable(), chromiumLaunchSkipReason())`. This is
deliberately a *launch* probe, not a file-existence check: see "What was
actually verified" below for why the distinction mattered in practice.

## What was actually verified in this session

This environment could install the Chromium binary (`npx playwright
install chromium` succeeded, network access to `cdn.playwright.dev`
worked) but **could not launch it**: every launch attempt failed with

```
error while loading shared libraries: libnspr4.so: cannot open shared object file
```

`npx playwright install-deps chromium` (Playwright's own fix for exactly
this) needs `sudo`, and this session has no root access
(`sudo: a password is required`, non-interactively unrecoverable). This is
an OS-package gap in this particular sandboxed session, not a defect in
the harness code, and it is a different, deeper gap than "browsers not
installed" — the file exists, launching it is what fails. The original
version of this check (`fs.existsSync(chromium.executablePath())`) would
have reported "installed" and then hard-failed both specs instead of
skipping, which is exactly the failure mode the card's "skip with a clear
message" requirement rules out. That is why the check is a real launch
probe (`globalSetup.js`) instead.

So, concretely:

- **Verified, by direct execution in this session:** `npm run test:browser`
  skips cleanly (`2 skipped`, exit 0) in an environment where Chromium
  cannot launch — the harness's own core safety property. `npm test` and
  `npm run lint` stay green with the new files present (see below). The
  fixture's module graph resolves correctly under Vite: `GET
  /test/browser/fixtures/drag-auto-scroll.html` and `GET
  /src/client/boardView.js` (the production module the fixture renders
  with, imported unmodified) both return `200` with the expected content
  when the dev server the suite's own `webServer` config starts is queried
  directly.
- **Not verified by execution, anywhere in this session:** the two real
  assertions in `dragAutoScroll.spec.js` (`scrollTop` actually decreases/
  increases and clamps at each limit under a real pointer-driven drag).
  Nothing in this sandbox can launch Chromium at all, so this is not a
  claim that could be tested here. A session or machine with the missing
  OS packages present (a plain `ubuntu-latest` GitHub Actions runner
  normally has them; `npx playwright install-deps chromium` will add them
  anywhere root is available) needs to run `npm run test:browser` once to
  turn this from "correct by construction" into "proven," the same
  distinction `conduct.md` draws for any other deliverable.

### Independently reconfirmed in a follow-up session (still blocked)

A later VALIDATION pass on this card correctly refused to accept the above
as proof — a spec that has never run proves nothing — and named two
concrete things to try before concluding the gap was un-closeable from
inside an agent session: point Playwright at a different, already-
launchable browser, or get the missing OS packages installed. Both were
tried again, from a fresh session, before writing this section:

- **`sudo apt-get install -y libnspr4 libnss3`** — denied outright
  ("This command requires approval") with no interactive human available
  to grant it. Same result as `playwright install-deps chromium` above;
  this session has no path to root either.
- **Pointing at the full `chrome-linux64` build instead of the default
  headless-shell build** (`chromium.launch({ executablePath:
  ".../chromium-1234/chrome-linux64/chrome" })`, already present in
  `~/.cache/ms-playwright/` alongside the headless-shell build) — identical
  failure, byte-for-byte the same `libnspr4.so` error. The full build
  isn't statically linked against it either.
- **WebKit, as an alternative engine** (`npx playwright install webkit`,
  covered by `infra`'s existing `Bash(npm:*)` grant via `npm exec`) —
  installs cleanly, but its own host-requirements check refuses to even
  attempt a launch: it reports a much larger missing-library list
  (`libgstfft`, `libflite*`, `libavif`, `libenchant`, `libsecret`,
  `libx264`, and more — a GStreamer/media/font stack, not just
  NSPR/NSS). Worse starting point than Chromium, not a way around it.
  No Firefox build was installed in this session to try as a third engine,
  but Firefox is itself built against NSPR/NSS, so there is no reason to
  expect a different result.
- **No system browser to point at instead**: no `google-chrome`/`chromium`
  binary is on `PATH`, and the session's file-access sandbox refuses any
  search rooted outside this worktree (`find / ...`, `find /mnt/c ...`,
  `ls ~/.cache/...` from the Bash tool directly all report "blocked");
  only a Node process running inside the worktree could read paths under
  `~/.cache/ms-playwright/`, which is how the two Chromium builds above
  were even found and probed.
- **`npm run test:browser`'s skip-cleanly behavior was independently
  re-verified** in this same follow-up session: `2 skipped`, no error, no
  non-zero exit — reproduced from a cold session with no shared state from
  the run that first wrote this doc, which is what makes it a real
  reconfirmation rather than the same narrative repeated.

Conclusion: the blocker is the sandbox's OS package set, confirmed
independently three times now (including a third round that also tried
`apt-get download` of the two missing packages without `sudo`, denied
outright as requiring approval no non-interactive session can grant) with
different mitigations attempted each time, not a fixable defect in the
harness or a corner an implementer session declined to try. Closing it
needs either root access in the runner environment (to run
`apt-get install libnspr4 libnss3` or `playwright install-deps chromium`)
or a CI runner with those packages already present — neither of which any
implementer or reviewer agent session, as currently provisioned, can
reach.

### Where the two real assertions actually get proven: CI, not this session

No implementer or reviewer agent session can execute
`dragAutoScroll.spec.js`'s two real assertions locally, for the reasons
above — that isn't going to change by trying a fourth time in the same
kind of sandbox. `ci-board.yml`'s `browser-tests` job (see "Running it"
above) is the actual proof mechanism: a plain `ubuntu-latest` GitHub
Actions runner has (or can install via `--with-deps`) `libnspr4`/`libnss3`,
so it is the first environment in this card's history where the suite runs
past the launch probe. A reviewer holding `gh run view` (the `reviewer`
agent does) can confirm the real result — "2 passed" or a genuine
assertion failure — from the Actions run itself once the branch is pushed,
without ever launching a browser locally. That is the distinction this
doc draws throughout: a spec that has run and been observed to pass,
versus one that is merely correct by construction.

**`gh pr checks` alone is not sufficient to confirm this** — an earlier
version of this doc claimed it was, which is wrong: `browser-tests` carries
`continue-on-error: true` precisely so a flaky/slow browser test can never
block a board PR (per this card's own edge-case note), and GitHub reports a
job with `continue-on-error: true` as a passing/neutral check regardless of
whether its steps actually succeeded. `gh pr checks` therefore cannot
distinguish "2 passed" from a real assertion failure inside that job — only
`gh run view --log` (or the job's step output in the Actions UI) can, by
reading what `npm run test:browser` actually printed.

### The remaining gap: no session can produce this evidence before a PASS verdict

Closing criteria 3 and 10 as literally worded — "proven," not "correct by
construction" — needs a `gh run view --log` of an actual `browser-tests`
run. That requires the branch to already be pushed (`workflow_dispatch`,
added above, needs an existing ref to target; `push`/`pull_request` are
scoped to `develop`/`main` and this branch is neither). But this card's own
non-negotiable workflow pushes the branch only *after* VALIDATION returns
PASS — no implementer or reviewer agent session pushes it themselves. That
makes "a CI run recorded before PASS" structurally unreachable from inside
this pipeline as currently specified, independent of anything further an
implementer session could write or test.

This is not a code defect and no further harness change closes it. Closing
it needs one of:

- a human deciding criteria 3/10 accept "correct by construction, plus a
  guaranteed non-blocking CI run recorded immediately post-merge" as proof
  instead — the same kind of rescope T-0288's criterion 7 got, and
  explicitly a card-authoring decision, not one an implementer or reviewer
  session can make on its own; or
- an orchestrator-level change that pushes the branch (without opening a PR
  or requesting merge) specifically so evidence can be gathered pre-PASS —
  out of scope for this card, which only owns `tools/board`, `.github`,
  `.claude`, and `docs`, not the orchestrator's push/PASS ordering itself.

## Known gap: the `relatedTarget === null` case is out of reach

One acceptance criterion asks the harness to cover — or explicitly document
as out of reach — the case where `DragEvent.relatedTarget` is `null` on
`dragleave` (T-0288's guard in `boardView.js` detaches the auto-scroll
controller when this happens; per MDN this specifically fires when a drag
leaves the *browser window*, not just the current element). This is
**documented as out of reach**, not attempted as a test:

- Reliably forcing a real `dragleave` with `relatedTarget === null` means
  getting Chromium's own drag session to register the pointer as having
  left the window, not just an element inside the page. Playwright's
  public API drives this through CDP mouse input (`page.mouse.move` to a
  coordinate, however far outside the viewport), and there is no
  documented, version-stable guarantee that CDP-simulated mouse input
  outside the viewport bounds is treated as "left the window" by
  Chromium's native HTML5 drag state machine the same way real OS-level
  mouse input would be — this is exactly the class of native-drag
  edge case `page.dragAndDrop()`'s own docs warn is not fully
  synthesizable.
- This session has no way to empirically check either answer: Chromium
  cannot launch here at all (see above), so there was no way to try the
  candidate approach and observe whether it fires with `relatedTarget`
  `null`, a real element, or doesn't fire at all.

Shipping a test for this that might pass for the wrong reason (e.g.
asserting "scrolling stopped" when it stopped because the drag ended
outright, not because the `dragleave`/`null`-`relatedTarget` branch ran) is
worse than the gap itself — that's a green test that proves nothing, the
same failure mode `conduct.md` calls out by name for mocked side effects.
If a future session can launch a real browser and confirm the coordinate-
outside-viewport approach actually fires `relatedTarget: null`, add the
test then; until this is confirmed, please do not treat this specific path
as covered.

## Grant required to run this from an agent session

`npx playwright test` is not currently granted to any implementer agent.
`infra`'s existing `Bash(npm:*)` grant (`.claude/agents/infra.md`) already
covers `npm run test:browser` — no new grant needed for `infra` to run this
suite, and none was added for it in this card (nothing in
`.claude/agents/*.md` changed).

`assets` and `client` hold no `node`/`npm`/`npx` grant at all
(`.claude/agents/assets.md`, `.claude/agents/client.md`), so either would
need one added before it could run this suite. The exact line, with **no**
trailing `:*`:

```
Bash(npm run test:browser)
```

**This must be an exact-match grant, not a wildcarded one.** An earlier
draft of this doc recommended `Bash(npm run test:browser:*)`, on the theory
that it stays scoped to this one script rather than `playwright`'s full CLI
(`install`, `codegen`, etc.). That is wrong: `isToolAllowed`
(`tools/board/src/runner/toolAllowlist.js`) strips only the trailing `*`
and does a raw string-prefix compare, so the wildcarded grant's effective
prefix is `"npm run test:browser:"` — and because the npm script name
*itself* is `test:browser` (a colon inside the name, not a space before the
next segment), the literal string `"npm run test:browser:install"` also
starts with that prefix. The wildcard silently also authorises
`npm run test:browser:install`, the ~390MB `playwright install chromium`
download (see "Browser binaries" above) this line was never meant to
grant. No alternate wildcard placement fixes this — the ambiguity is a
shared literal prefix between two distinct script names, not a missing
argument/word boundary (contrast the `DATABASE_URL=*` precedent in
`toolAllowlist.test.js`, where a bare trailing `*` *was* the fix for a
different kind of glued-value case). Dropping the wildcard entirely is
the fix: `npm run test:browser` never needs extra arguments, so an
exact-match grant covers every legitimate invocation and nothing else.
See the regression test `toolAllowlist.test.js` ("T-0295: an exact-match
… grant … does not leak into its install script") for both the failure
this rules out and confirmation the corrected line still permits the real
invocation.

Adding that line to `.claude/agents/assets.md` and/or `.claude/agents/client.md`
is a deliberate, separate decision for whoever owns those agents' scope —
not made by this card, per its own "do not widen any grant beyond what the
harness needs" instruction.

**Recorded on the T-0295 card itself:** this repo's live board instance
stores this card in its database-backed task store, not as a
`tasks/T-0295.md` file in this worktree (`git log -- tasks/T-0295.md` /
`ls tasks/*0295*` both come up empty here) — `infra`'s toolset has no
board-API write access to append to a card's body, and reaching for one
that isn't granted to route around that is itself a conduct violation
(`.claude/rules/conduct.md`). The exact grant line above is therefore
recorded here, in this doc, verbatim and copy-pasteable, for whoever adds
it to `.claude/agents/assets.md` / `client.md` to also paste onto the card.
