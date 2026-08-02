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
