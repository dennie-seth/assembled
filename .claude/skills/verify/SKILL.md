---
name: verify
description: Runs the changed subsystem's test suite, linter, and build, and reports a green/red result with output. Used by implementers before handoff and by the reviewer during VALIDATION.
---

# verify

Runs the check appropriate to whichever path(s) a card actually touched.
Never run an unrelated subsystem's suite just because it's convenient —
that wastes time and produces a verdict about code nobody changed.

## Steps

1. Determine touched paths from the worktree's diff against `develop`
   (`git diff develop...HEAD --name-only`).
2. Run the matching command(s):

   | Paths | Command |
   |---|---|
   | `tools/**` | `npm test` (Vitest) + `npx eslint .` in `tools/board` |
   | `tasks/**` (planner backlog changes) | `node tools/board/scripts/validateBacklog.js` (or `npm run validate:backlog` from `tools/board`) — validates the whole backlog as a set, not just the changed files |
   | A Python package (dir containing `pyproject.toml`: `tools/asset-gate`, `tools/comfy-client`, `tools/audio-agent`, `tools/gen-client-base`, `tools/palette-extract`, `tools/sim`, `assets/src/audio`) | from that package's directory: `python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && .venv/bin/pytest && .venv/bin/ruff check .` — **must actually be run**; a test failure or lint error is a FAIL, and not running it at all is also a FAIL, never an "unverified" pass |
   | `server/**`, `shared/**` (C++ side) | `cmake --build build && ctest --test-dir build` + `clang-format --dry-run --Werror` on changed files |
   | `client/**` (GDExtension C++) | `scons` + `clang-format --dry-run --Werror` on changed files |
   | `client/**` (`.gd`/`.tscn`) | `godot --headless` gdUnit4 test run |
   | `server/**/migrations/**` | apply `up` then `down` then `up` again against a throwaway `docker compose` Postgres — must be idempotent and error-free |

   A diff touching more than one of `tasks/**`, `tools/board/**`, and a
   Python package (e.g. a planner run that also required a validator fix,
   or a card that touches both `comfy-client` and `audio-agent`) runs every
   matching row, not just one — one `python-verify` step per Python package
   touched. See `tools/board/src/runner/verifyRouter.js` for the
   code-enforced version of this routing, injected directly into the
   reviewer's prompt as a `## Required verification for this diff` section
   for these paths.

3. Capture full output, not just the exit code — a FAIL verdict downstream
   (in the `review` skill) needs the actual failure text, not "tests
   failed."
4. Report **green** (all commands exited 0) or **red** (any command
   failed), with the command output attached. If a command errors before
   even running (missing dependency, build environment broken), report that
   distinctly — it's grounds for `blocked`, not a normal red.
