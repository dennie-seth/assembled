# INDEX — Canonical Design Docs

> **Project:** Assembled · **Revised:** 2026-08-02 (rev 2) · **By:** Claude
> **This set is the source of truth.** Post-merge, duplicate-free, and internally reconciled.
> **Target state:** these land in `docs/` and `docs/design/`, after which **git is canonical and this folder is retired.**

---

## 1. What Changed in rev 2

rev 1 was a faithful copy of scattered files. rev 2 makes them agree with each other.

| Fix | Detail |
|---|---|
| **Version drift** | Six docs had header versions behind their own changelogs (`01` said v3 with a v6 changelog; `PLAN` said v2 with a v3 changelog). Headers now match. |
| **A-1 resolved** | Tile size is **16px**, rooms authored on a 24×14 grid (384×224) with an 8px non-gameplay band. Was still listed open in `05` and `GDD-OPEN` after being decided. |
| **M-5 resolved** | `11` §5 marked switch-locked door tiers "TBD" while `11` §6 already specified Session tier. Internal contradiction, now closed. |
| **Pipeline folded into HANDOFF** | The art/audio decisions in `13` had never reached the delta doc. Added **D-16…D-20**, revised T-0072/73/74/81/82/83, new **T-0101…T-0103**. |
| **PLAN deltas applied** | `PLAN.md` now carries the anchor-tag schema, seed-phrase identity, Linux CI, resolved LFS, and updated Phase 6/7 tasks. All four plan-level open questions closed. |
| **Audio scope clarified** | `06-audio.md` is superseded — the pipeline half is `13` §4. Only track/SFX counts would remain. |

---

## 2. Contents

| File | Status | Owning chat |
|---|---|---|
| `01-vision.md` | v7, locked | design |
| `02-notes-system.md` | v3, locked | design |
| `05-art-direction.md` | v2 — direction + tile size locked, palette open | pipeline |
| `07-items-economy.md` | v5, locked | design |
| `08-invariants.md` | v3, locked | design |
| `09-identity.md` | v2, locked | design |
| `10-time-and-progression.md` | v2, locked | design |
| `11-moment-to-moment.md` | v2, locked — A-I resolved | design |
| `12-tears.md` | v1, locked — A-II resolved | design |
| `13-asset-pipeline.md` | v3, art + audio locked | pipeline |
| `GDD-OPEN.md` | live inventory | design |
| `HANDOFF.md` | live delta list | pipeline |
| `PLAN.md` | v4 | both |
| `GDD-QUESTIONS.md` | **archive** — superseded by `GDD-OPEN.md` | — |

**To be written:** `03-net-protocol.md`, `04-data-model.md` (T-0091, T-0090). Repo versions exist but are wrong — see §4.

---

## 3. For Dispatch — Reconciliation

1. `PLAN.md`, `HANDOFF.md`, `GDD-OPEN.md` → `docs/`.
2. `01`, `02`, `05`, `07`–`13` → `docs/design/`. `GDD-QUESTIONS.md` → `docs/archive/`.
3. **Overwrite** the existing `docs/design/01`, `02`, `05` stubs — they are eight-line placeholders reading *"DRAFT — blocked on GDD."*
4. **Delete** `03-net-protocol.md` and `04-data-model.md`, then rewrite from `HANDOFF.md` §5 (T-0090, T-0091). Do not edit them — see §4.
5. **Delete** `06-audio.md` — superseded by `13` §4.
6. Create the task cards for `HANDOFF.md` §3 (revised) and §4 (new, T-0090–T-0103). **`PLAN.md` already reflects these**; the `tasks/*.md` files do not yet exist.
7. Commit. From that point **git is canonical**; this folder is history.

---

## 4. Repo Docs That Are Actively Wrong

Not stale — they describe systems the GDD replaced. An agent reading them will implement the wrong thing.

| Repo file | Problem |
|---|---|
| `docs/design/03-net-protocol.md` | `GET /v1/roll` (**secret drops — cut**) and `GET /v1/notes?zone&x&y&r` (**radius query — eliminated**) |
| `docs/design/04-data-model.md` | `secret_drops`, `drop_grants`, `zone_id` columns. All three gone |
| `docs/design/01`, `02`, `05`, `06` | Eight-line stubs still saying "blocked on GDD" |
| `docs/PLAN.md` | Repo copy is **v2**; this folder has **v4** |

---

## 5. Remaining Blockers

| # | Question | Blocks |
|---|---|---|
| **V-5** | Home palette — colour count + hex values | the quantizer in T-0073, and only that |
| T-1 / T-2 / E-1 | Exact clock durations within their brackets | the sim's *tuning sweep*, not the harness |

Everything else is content budget or playtest data. Full inventory in `GDD-OPEN.md`.

---

## 6. Going Forward

- **Git is canonical.** Chats read committed state, not uploads.
- **One doc, one owning chat.** Cross-edits are requested, not made.
- Every doc keeps a changelog table. A doc whose newest row is absent from git failed to land.
