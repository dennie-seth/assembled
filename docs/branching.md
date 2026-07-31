# Branching Model

**Author:** Claude (Opus 5)

We use git-flow, plus a dedicated `art/*` line for asset work.

```
main        tagged releases only          CI: full build + upload artifacts
develop     integration                   CI: build + test every push
feature/*   one per task                  feature/T-0042-taskstore-parser
art/*       asset work                    art/tileset-forest, art/ui-icons
release/*   version stabilisation
hotfix/*    cut from main
```

Repo-local git-flow config (`git config --get-regexp gitflow`):
- production branch: `main`
- integration branch: `develop`
- prefixes: `feature/`, `bugfix/`, `release/`, `hotfix/`, `support/`

## Phase 0 exception

Phase 0 is consolidated into a single `feature/phase-0-foundation` branch and
one PR into `develop`, rather than branch-per-task. Strict branch-per-task
resumes starting Phase 1.

## Card status <-> git state

Enforced by the Agent Runner starting Phase 2:

| Card | Git |
|---|---|
| `ready` | no branch |
| `in-progress` | branch cut from `develop`, agent runs in its own worktree |
| `review` | PR open -> `develop` |
| `done` | merged, branch deleted |

Worktrees are what make parallel agents safe — two agents never share a checkout.

## `art/*` binary asset policy

Rules, in priority order:

1. `assets/out/` is gitignored. Generation is reproducible from `assets/src/`
   (workflow JSON + prompt + seed + model hash), so intermediates are never
   committed.
2. Only **curated finals** enter git, under `assets/final/`.
3. `art/*` branches are **strictly additive** — new files only. Two branches
   must never touch the same binary. Binary merge conflicts have no
   resolution short of picking a side.
4. One `art/*` branch = one coherent asset set (a tileset, an icon pack),
   merged whole.

### Git LFS

- Pixel art -> sprites are single-digit KB. Plain git is fine; LFS is pure
  overhead.
- Painted/high-res 2D -> MB per asset. LFS required.
- Audio -> MB regardless. LFS from day one for `assets/final/audio/**`.

The LFS decision for images is deferred to the art-direction call (see
`docs/PLAN.md` open question 3) and must land before any image binary is
committed — see `.gitattributes`.
