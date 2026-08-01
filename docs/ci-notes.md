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
