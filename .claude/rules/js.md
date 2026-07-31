---
paths: ["tools/**"]
---

# JS conventions

- ESM only. Build/dev via Vite, tests via Vitest.
- Format: 2-space indent.
- Any server process (HTTP API, WS hub, PTY bridge) binds `127.0.0.1`
  explicitly — never `0.0.0.0`. A PTY bridge on all interfaces is a remote
  shell for the LAN.
- Task store is one markdown file per task under `tasks/`, never a single
  aggregate `board.json` (guarantees merge conflicts on concurrent edits).
- No free-text UGC anywhere in the board tool's data model — tasks are
  internal tooling, not player-facing, but the rule still holds for any
  player-facing surface this code touches.
- TDD non-negotiable — test file before implementation.
