# CI Notes

**Author:** Claude (Sonnet 5)

Phase 3 (CI/CD) implementation notes — see `docs/PLAN.md` §Phase 3 and the
`T-0030`–`T-0036` cards under `tasks/`.

## T-0030 — windows-latest godot-cpp + headless export spike

**Status: first live run (PR #9) failed at the godot-cpp checkout step —
fixed, re-run pending.** The "Checkout godot-cpp" step failed its `git
fetch` against `refs/heads/4.7*`/`refs/tags/4.7*` (exit 1, retried 3x).
Root cause: `godotengine/godot-cpp` doesn't have a `4.7` branch or any
`4.7.x` tag — the bindings repo lags the engine's own release cadence.
Confirmed via `git ls-remote --heads`/`--tags
https://github.com/godotengine/godot-cpp`: branches stop at `4.5`, the
newest tag is `godot-4.5-stable`. `GODOT_CPP_REF` is now pinned to
`godot-4.5-stable` (a concrete, immutable tag) in both
`ci-client.yml` and the spike workflow. This doesn't need to track
`GODOT_VERSION` (still `4.7.1`, the actual engine/export-template
version) — the godot-cpp build and the headless export are independent
checks in this spike, not linked into one working GDExtension. Whoever
does the real Phase 5 GDExtension integration (T-0060/T-0061) will need
to re-check whether godot-cpp has caught up by then.

Also bumped `actions/checkout` v4→v7, `actions/setup-python` v5→v7,
`actions/cache` v4→v6 in the same two files (GH's Node 20 deprecation
warning; verified no breaking changes affect this repo's usage via each
action's release notes before bumping — no `pull_request_target` or
`pip-install` usage here).

**What was built:**

- `.github/workflows/spike-t0030-godot-windows.yml` — `workflow_dispatch`
  only (on-demand, not a permanent CI gate — matches the card's
  "timeboxed investigation" framing rather than "every push"). Two
  checks:
  1. `godotengine/godot-cpp` (external checkout, tag `godot-4.5-stable`)
     built via `scons platform=windows target=template_release` on
     `windows-latest` — no MinGW; relies on the MSVC toolchain already
     present on the GH-hosted Windows image.
  2. `godot --headless --export-release "Windows Desktop"` against a
     minimal placeholder project at `.github/ci-spike/godot-client/` (see
     below), using `chickensoft-games/setup-godot@v2` with
     `include-templates: true` to fetch the 4.7.1 editor + export
     templates.
- `.github/ci-spike/godot-client/` — a disposable, minimal Godot 4 project
  (empty `Node2D` main scene, no GDExtension, no game logic) that exists
  only to give the exporter something to export. This is **not** Phase
  5's real `client/` — `docs/PLAN.md` Phase 5 (T-0060) still owns the real
  Godot project + godot-cpp submodule integration. Kept out of `client/`
  on purpose so it can't collide with that later.

**Expectation, per `docs/PLAN.md`:** Godot 4's `--headless` flag uses the
dummy rasterizer, so 2D import + export packaging is CPU-only — the free
`windows-latest` runner (no GPU) should be sufficient. That's Godot's
documented behavior, still unconfirmed first-hand pending the re-run.

**Next step:** watch `ci-client.yml`'s `windows-export` job re-run on PR
#9 after this fix pushes. **Update this section with the actual result**
once that happens. If it fails again, the fallback noted in
`docs/PLAN.md` is a self-hosted Windows runner on the dev box (not WSL —
needs the GPU + Godot editor already installed there).

## T-0031 — ci-board.yml

Runs `npm ci`, `npm run lint`, `npm test` (vitest, fully mocked child
processes — no live `claude` spawns), `npm run build` on `ubuntu-latest` /
Node 20. Verified locally in WSL: 34 test files / 366 tests pass, lint
clean, build succeeds. A throwaway lint violation was introduced and
reverted locally to confirm ESLint surfaces errors with a nonzero exit
(which `npm` and the workflow step propagate as a failed job).

## T-0032 — ci-server.yml

`server/` didn't exist before this card (Phase 4 hasn't landed). Per the
card's own text ("skeleton the server agent's first commits make
meaningful"), added a minimal `server/CMakeLists.txt` +
`server/test/smoke_test.cpp` (doctest via `FetchContent`) — verified
locally in WSL: configures, builds, and `ctest` passes (1/1). `ci-server.yml`
runs the same steps on `ubuntu-latest` with a `postgres:16` service
container wired (`DATABASE_URL` env) — unused by the skeleton test today,
ready for T-0040+ integration tests to read directly.

## T-0033 — ci-client.yml

Windows (`windows-latest`) and Linux (`ubuntu-latest`) export jobs against
the same placeholder project used by the T-0030 spike (see above) —
`platform="Linux"` per the export-preset rename in Godot 4.3+ (was
`Linux/X11` before). `linux-export` went green on PR #9's first run.
`windows-export` failed on the same godot-cpp ref bug as T-0030 (same
root cause, same fix — see above); re-run pending.

## T-0034 — caching

- `ci-board.yml`: `actions/setup-node`'s built-in `cache: npm`.
- `ci-server.yml`: none yet — no vcpkg/conan dependency exists until
  T-0040 picks one. Revisit then.
- `ci-client.yml`: `chickensoft-games/setup-godot`'s built-in `cache: true`
  (default) covers the editor + export template downloads. godot-cpp's
  SCons build objects are cached via `SCONS_CACHE` + `actions/cache`,
  keyed on the godot-cpp ref and commit SHA.

## T-0035 — artifact upload

- `ci-client.yml`: Windows + Linux exports uploaded as workflow artifacts
  — currently the disposable spike project's output, not a real game
  build, since there's nothing else to export until Phase 5 lands.
- `ci-server.yml`: the skeleton's `server_tests` binary is uploaded as a
  stand-in for "server binary" — same caveat, becomes meaningful once
  T-0040+ produces a real server executable.

## T-0036 — pre-push hook

See `docs/branching.md` for install/bypass instructions.

## T-0060/T-0061 — real client dev-env, replacing the T-0030 spike

**Status: built and verified locally in WSL (Linux leg); Windows leg
delegated to `ci-client.yml`'s CI run.**

The real Phase 5 client now lives at `client/` — a Godot 4 project plus a
minimal GDExtension (`AssembledPing`, one method + one property) built via
a `client/godot-cpp` submodule and SCons, per `docs/PLAN.md` T-0060/T-0061
and the `new-gdextension-class` skill. `ci-client.yml` was repointed at it
(see below); the disposable `.github/ci-spike/godot-client/` project and
`spike-t0030-godot-windows.yml` are marked superseded in-place rather than
deleted, since the latter is a harmless `workflow_dispatch`-only sanity
check and not part of the regular gate.

### The version-compatibility question, resolved

T-0030's note above flagged that whoever built the real GDExtension would
need to re-check whether `godot-cpp` had caught up to the `4.7.x` engine
line. As of this pin it has not — `git ls-remote --heads/--tags
https://github.com/godotengine/godot-cpp` still stops at `4.5`
(`godot-4.5-stable`), same as when T-0030 checked.

Rather than downgrade the engine to 4.5 to match, the pin used is:

- **Engine:** `4.7.1` (unchanged — matches `GODOT_VERSION` used elsewhere).
- **godot-cpp:** `godot-4.5-stable` (submodule at `client/godot-cpp`).

This relies on Godot's GDExtension ABI forward-compatibility guarantee
(stable since 4.1): an extension built against an older API surface loads
fine in a newer 4.x engine, gated by `compatibility_minimum` in the
`.gdextension` file (set to `"4.1"` here, matching godot-cpp's own example
project). **This was verified empirically, not assumed** — the acceptance
bar per the task was "the extension actually loads", not "it compiles":

1. `scons platform=linux target=template_debug` in `client/` (against the
   `godot-4.5-stable` submodule) produced
   `libassembled_client.linux.template_debug.x86_64.so`.
2. Downloaded the **Godot 4.7.1** headless Linux engine binary directly
   (`Godot_v4.7.1-stable_linux.x86_64`, same version as `GODOT_VERSION`)
   and ran `godot --headless --import` against `client/` — GDExtension
   verification step in the import log raised no errors.
3. Ran `godot --headless --script client/tests/smoke_test.gd`, which calls
   `ClassDB.class_exists("AssembledPing")`, then instantiates it and calls
   `ping()`, asserting both the return value and a property round-trip —
   this fails loudly (exit 1) on any load/ABI problem, not just a silent
   no-op. **Result: exit 0**, `SMOKE TEST PASS`.
4. Built `template_release` and ran a full
   `godot --headless --export-release "Linux"` — confirmed the exported
   package correctly bundled
   `libassembled_client.linux.template_release.x86_64.so` next to the
   game binary, and that this is the artifact CI uploads.

Conclusion: keep `GODOT_VERSION=4.7.1` / `GODOT_CPP_REF=godot-4.5-stable`.
**Risk for the Windows CI leg:** the same godot-cpp ref will be compiled
with MSVC instead of GCC on `windows-latest`, which is untested locally
(WSL can't build the Windows DLL) — this is the one part of the version
decision this session couldn't verify first-hand, and is what
`ci-client.yml`'s `windows-export` job (~10-15 min, expected, mostly the
godot-cpp SCons compile) exists to confirm on the actual PR. If it fails,
the failure mode to check first is an MSVC-specific compile error in
godot-cpp itself (unlikely — it's CI-tested upstream) rather than the ABI
question, which is engine-side and platform-independent.

Whoever picks up `T-0062`+ should re-run step 1-3 above (or just trust CI)
before assuming this pin still holds, and should re-check
`git ls-remote` for a `4.6`/`4.7` godot-cpp ref periodically — once one
exists, bumping `GODOT_CPP_REF` to match `GODOT_VERSION` removes the need
for this whole cross-version argument.

### ci-client.yml changes

Both jobs now build `client/`'s GDExtension (`template_debug` then
`template_release`, mirroring local dev) via the vendored `godot-cpp`
submodule (`submodules: recursive` on checkout, no separate external
checkout step like the spike used), run the headless smoke test between
import and export, then export. SCons caching (T-0034) is keyed the same
way as the spike's was. Path triggers no longer include
`.github/ci-spike/**` — that project is frozen/superseded, not touched by
ongoing client work.

### PR #12 — `godot --headless --import` abort-on-exit (SIGABRT / 134)

**First real CI run (PR #12) failed on `linux-export`'s `Import project
(headless)` step: `Aborted (core dumped)`, exit 134 — after the log showed
`first_scan_filesystem` DONE, GDExtension verification, `update_scripts_classes`
DONE, and `loading_editor_layout` DONE. No error text, no undefined-symbol
report, nothing GDExtension-related — the crash is purely in process
teardown, after every real import stage already finished and was written
to disk.**

**Reproduced locally**, after several failed attempts (see below) —
running the *exact* `Import project (headless)` `run:` block, byte-for-byte
extracted from the committed `ci-client.yml`, against a **freshly deleted
`client/.godot` cache** (i.e. simulating a fresh checkout, not a warm
rebuild) reproduces `Aborted (core dumped)`, exit 134, **5/5 times** in a
row in plain WSL — no container needed once the cache is genuinely cold.
It does not reproduce against an already-imported project. This points at
Godot's first-time resource-import thread pool: spinning up and tearing
down the extra worker/import threads that only run on a cold cache is
the likely trigger, racing against main-thread exit during headless
*editor*-teardown (`--import` loads `EditorNode` internals even under
`--headless`) — consistent with it being flaky/environment-sensitive
rather than a deterministic bug, and with GH Actions runners (always a
fresh checkout) hitting it far more reliably than a dev box with a
pre-populated `.godot/` cache.

Repro attempts that did **not** reproduce it, for the record (each was a
genuine attempt, not just "didn't try hard enough"): plain WSL with a
warm cache; WSL with `DISPLAY`/`PULSE_SERVER`/`WAYLAND_DISPLAY` unset; a
bare `ubuntu:24.04` Docker container (no X11/Pulse at all, only the libs
`ldd` reported missing: `libfontconfig1`, `libgl1`); the same container
constrained to `--cpus=2 --memory=7g` to match GH's `ubuntu-latest` spec,
run 3x. None of these abort — **only a genuinely cold `.godot/` cache
does**, which was the missing variable.

**The fix is not "ignore the exit code."** That would mask a real
load/ABI failure just as easily as it hides the benign one. Instead, each
of the three `godot --headless` invocations in `ci-client.yml` (import,
smoke, export) is gated on independent evidence that the *real* work
succeeded, never on Godot's raw process exit code alone:

1. **Import step:** forgive a nonzero exit only when **all** of: the exit
   code is signal-terminated (`> 128`, i.e. `128 + SIGABRT` = 134, not an
   ordinary `exit 1`); the log reaches `[ DONE ] loading_editor_layout`
   (proof every import stage actually finished, not just started); and no
   `SCRIPT ERROR`/`Parser Error`/`Failed to load extension`/`Can't open
   dynamic library`/`Unable to load GDExtension` line ever appeared.
   Verified via both fake-`godot` stand-ins (four scenarios: clean
   success, benign abort-after-completion, a real error that also happens
   to abort, and a crash before completion — the last two must still
   fail) and a negative control against the real binary: renaming away
   the built `.so` still correctly fails this step's *sibling* smoke-test
   gate (see below) even though the import step itself, tellingly, still
   exits 0 in that case — Godot's raw import exit code was never a
   reliable success signal even before this bug, which is exactly why the
   real gate is elsewhere.
2. **Smoke test step:** gates purely on `tests/smoke_test.gd`'s own
   explicit `SMOKE TEST PASS` stdout marker (the script calls
   `quit(0)`/`quit(1)` itself after asserting `AssembledPing` loaded and
   round-tripped — see `client/tests/smoke_test.gd`), never on Godot's
   exit code. This is the real correctness gate for the whole job.
   Negative-control-verified: with the built `.so` renamed away, GDScript
   fails to parse the script's `AssembledPing` type annotation at all
   (`SCRIPT ERROR: ... Could not find type "AssembledPing"`), no PASS
   marker is ever printed, and the step correctly fails — even though
   Godot's own exit code for that run is 0, not nonzero, which is the
   sharpest illustration of why exit-code gating was never safe to begin
   with, abort-on-exit bug or not.
3. **Export step:** gates on the exported binary and `.pck` both existing
   and being non-empty (`[ -s ... ]`), same class of editor-only headless
   machinery as import, same treatment.

All three `godot --headless ...` invocations are also piped through
`sed -r 's/\x1b\[[0-9;]*[a-zA-Z]//g'` before `tee`-ing to a log file:
Godot's progress-bar lines (`[ DONE ] stage_name`) are wrapped in ANSI SGR
colour escapes even when stdout isn't a tty, which silently breaks a
literal `grep -F` match on them — caught by testing the classification
logic against the *real* binary's output, not just hand-written fake
`godot` stand-ins (the fakes didn't emit ANSI codes, so they falsely
validated a broken pattern first).

**Full pipeline re-verified end-to-end** with the fix, running the exact
`run:` blocks from the committed `linux-export` job (extracted from the
YAML with `yaml.safe_load`, not retyped) against a freshly-cleared
`client/.godot`: Import hit the real abort (134), correctly forgave it
with a `::warning::`; Smoke test genuinely passed (`SMOKE TEST PASS`);
Export produced a real, complete `assembled.x86_64` + `.pck`. Also
confirmed `set -o pipefail` alone is not enough under GitHub Actions'
default bash step flags (`--noprofile --norc -eo pipefail {0}` — `-e` is
on by default): a bare `cmd | tee log; status=$?` would abort the whole
step at the failing pipeline before the status line ever ran. Every
wrapper here uses `if cmd | tee log; then status=0; else status=$?; fi`
instead, which is exempt from `-e` by bash's own if-condition rule.

**Applies to:** both `windows-export` and `linux-export` jobs identically
(the Windows leg hadn't reached its own import step yet when PR #12's
Linux job failed, but the same editor-teardown code path applies on any
platform — same treatment, same reasoning, not verified live on Windows
locally since WSL can't run the Windows binary, but `windows-export`'s own
CI run is what confirms it there). Local commands in `client/README.md`
are unaffected — a human running `godot --headless --import` once by
hand and seeing `Aborted (core dumped)` after the same `DONE` markers can
now cross-reference this section instead of assuming something is
broken.
