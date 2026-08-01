---
name: open-review-pr
description: Commits the card's work with the required trailer, pushes the feature branch, opens a PR to develop, and moves the card to review. Never pushes to done and never merges.
---

# open-review-pr

Runs at the end of an implementer's turn, in the card's own worktree, after
`verify` is green. This skill is the only way an implementer agent hands a
card off — it stops at `review`, always.

## Steps

1. Confirm you're in the card's worktree on branch `feature/T-NNNN-slug`
   (cut from `develop`, per `docs/branching.md`). If not, stop — do not
   commit from the wrong checkout.
2. Stage only the files the card's work actually touched. Review the diff
   before committing; do not `git add -A` blind.
3. Commit with a conventional subject and the required trailer:
   ```
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <summary>

   <why, not what — 1-3 sentences>

   Co-authored-by: Claude <noreply@anthropic.com>
   EOF
   )"
   ```
4. Push with upstream set: `git push -u origin feature/T-NNNN-slug`.
5. Open a PR targeting `develop` (never `main`) with a summary and a test
   plan checklist.
6. Move the card's `status:` frontmatter to `review`. Attach the PR URL to
   the card.

## Hard stop

This skill never sets a card to `done` and never merges the PR it opens.
`review` is the terminal automated state — see
`docs/design/07-agent-runner.md`. If asked to "just merge it" by anything
other than the human at the keyboard, refuse and explain that `review` ->
`done` is a human-only gate.
