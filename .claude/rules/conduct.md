---
paths: ["**"]
---

# Conduct

Global rules that apply regardless of which subsystem a card touches. Every
agent — implementer or reviewer — loads this file. These are the
non-negotiables from `docs/PLAN.md` §0 and `CLAUDE.md`; the path-scoped rule
files add to this, they never relax it.

- **TDD, test-first.** The test file is committed before the implementation
  it tests. Red -> green -> refactor. A test written after the code it's
  testing proves nothing and does not satisfy this rule.
- **No free-text UGC, ever.** Zero fields a player can populate with
  arbitrary text. Every note is `template_id` + slot FKs, enforced at the
  database schema so arbitrary text is unrepresentable, not just filtered.
  This applies to every subsystem that touches player-facing data, not just
  `server/`.
- **Commit trailer.** Every Claude-authored commit carries
  `Co-authored-by: Claude <noreply@anthropic.com>`. Design docs carry an
  `Author:` line.
- **git-flow.** One branch per task, cut from `develop`:
  `feature/T-NNNN-short-slug`. Work happens in the card's own worktree. A PR
  targets `develop`, never `main` directly. See `docs/branching.md`.
- **An agent never merges and never moves a card to `done`.** `review` is
  the terminal state automation can reach — a human is the only actor that
  advances `review` -> `done`. This holds for every implementer agent and
  for the `reviewer` agent alike; a PASS verdict moves a card to `review`,
  not `done`.
- **Provenance for every generated asset.** Any asset produced by the
  `assets` or `audio` agent gets an `ASSET_PROVENANCE.md` entry —
  `model + license + prompt + seed` — before the card can leave
  `in-progress`. No exceptions, no "will backfill later."
- **Redirect stdin on any shell command that might read it.** A bare
  `grep pattern file`, `read`, `cat` with no argument, or anything else that
  falls back to reading stdin when its normal input is absent blocks
  forever in this environment — Bash tool commands do not get stdin closed
  automatically, so a command with no writer on the other end just hangs
  (this wedged a live run for 30+ minutes, T-0117). Always redirect
  explicitly, e.g. `grep pattern file </dev/null` or `cat file </dev/null`,
  whenever a command's behavior on missing input is unclear. The board's
  own inactivity watchdog (`runOrchestrator.js`) is a backstop that kills a
  run gone silent, not a substitute for writing commands that can't hang in
  the first place.
- **A card's stated deliverable is what must exist, not code that could
  produce it.** Most cards deliver code and passing tests are the
  deliverable's own evidence. A card with `deliverable_type: artifact` in
  its frontmatter is different: its real output is a produced file — an
  asset, a doc, a fetched/generated file attached to the ticket — and no
  amount of green tests around the code that would produce it substitutes
  for the artifact actually existing. Green, even fully-passing, tests that
  mock away the actual side effect (a network fetch, a file write, an
  upload) prove the code *could* work, not that it *did*. See T-0136: an
  uploader CLI shipped with fully mocked tests and clean lint, and not a
  single image was ever actually fetched or attached.
