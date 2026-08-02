---
paths: ["tools/asset-gate/**", "tools/comfy-client/**", "tools/gen-client-base/**", "tools/audio-agent/**", "assets/src/**"]
---

# Python conventions

First Python code in the repo (T-0102). Establishes the pattern for later
Python tooling (e.g. T-0101's deterministic synthesis script, T-0071's
`comfy-client`).

- **Package layout:** `src/<pkg>/` + `tests/`, installed editable
  (`pip install -e ".[dev]"`) into a per-package `.venv/` (gitignored).
  Metadata and pinned deps live in `pyproject.toml` — no bare `requirements.txt`.
- **Pin exact versions** in `pyproject.toml` (`==`, not `>=`) for
  reproducibility — this tooling validates *determinism*, so its own
  dependency resolution should be deterministic too.
- **Lint/format: `ruff`.** One tool, fast, no separate black/isort/flake8
  stack. Run `ruff check .` before committing; CI enforces it.
- **TDD, same as the rest of the repo.** Test file committed before
  implementation. Fixtures are generated in-process (tiny synthetic
  PNG/WAV via PIL/numpy/soundfile) — never commit binary test fixtures.
- **Pure functions returning a shared result type.** Checks return
  `asset_gate.result.CheckResult` (or reuse that pattern in new packages)
  rather than raising or printing — keeps them composable and testable
  without capturing stdout. This applies to *validation checks*
  (pass/fail assertions over static content); an operational client
  (`comfy-client`'s HTTP submit/poll/fetch) legitimately raises typed
  exceptions instead, since a submit/timeout/execution failure is a
  real error to propagate, not a graded verdict.
- Every check module documents which `docs/design/*.md` section it
  implements, and cites the invariant (`P-4`, `D-17`, etc.) where one exists.
