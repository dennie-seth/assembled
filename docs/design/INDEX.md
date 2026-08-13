# INDEX — Canonical Design Docs (ARCHIVED 2026-08-06)

> # ⚠️ ARCHIVED — 2026-08-06. Do not follow the instructions below.
>
> **This page was a one-time migration plan** for moving the design set out of a scratch folder and into git. **That migration is complete.** Everything below describes a state that no longer exists, and two sections are now actively dangerous:
>
> - **§3 step 4** says *"Delete `03-net-protocol.md` and `04-data-model.md`, then rewrite from HANDOFF §5."* True on 08-02, when those were the cut-systems versions. **They are now the correct documents.** Following this deletes good work.
> - **§4 "Repo Docs That Are Actively Wrong"** lists `03`, `04`, the `01/02/05` stubs, and a v2 `PLAN.md`. All fixed. The section now describes the opposite of reality.
>
> Other stale content: the contents table lists `13-asset-pipeline` at v4 (repo is v5); `HANDOFF` §5's schema sketch is superseded by `04`; T-0090/T-0091 are done.
>
> **The current steady state is:**
>
> \| \| \|
> \| --- \| --- \|
> \| **Design source of truth** \| Notion. Dispatch exports to the repo \|
> \| **`PLAN.md`** \| git-only — dispatch reads and amends it there \|
> \| **`13-asset-pipeline`** \| **repo → Notion** for now. The repo copy (v5) is ahead, and Notion's §6.8/6.10/6.11 tables are malformed. Do not overwrite the repo copy from Notion \|
> \| **Ownership, decision log, next steps** \| the **Assembled — Design** root page \|
> \| **Task IDs** \| Dispatch allocates. Docs propose section-scoped handles (`§13-a`), never `T-NNNN` — `HANDOFF` §11.7 \|
>
> Kept for provenance: it records how the set was reconciled on 08-02 and why. Nothing here should be acted on.

> **Project:** Assembled · **Revised:** 2026-08-02 (rev 2) · **By:** Claude
> **This set is the source of truth.** Post-merge, duplicate-free, and internally reconciled.
> **Target state:** these land in `docs/` and `docs/design/`, after which **git is canonical**.

---

## 1. What Changed in rev 2

rev 1 was a faithful copy of scattered files. rev 2 makes them agree with each other.

| Fix | Detail |
|---|---|
| **Version drift** | Six docs had header versions behind their own changelogs (`01` said v3 with a v6 changelog; `PLAN` said v2 with a v3 changelog). Headers now match. |
| **A-1 resolved** | Tile size is **16px**, rooms authored on a 24×14 grid (384×224) with an 8px non-gameplay band. Was still listed open after being decided. |
| **M-5 resolved** | `11` §5 marked switch-locked door tiers "TBD" while `11` §6 already specified Session tier. Internal contradiction, now closed. |
| **Pipeline folded into HANDOFF** | The art/audio decisions in `13` had never reached the delta doc. Added **D-16…D-20**, revised T-0072/73/74/81/82/83, new **T-0101…T-0103**. |
| **PLAN deltas applied** | `PLAN.md` now carries the anchor-tag schema, seed-phrase identity, Linux CI, resolved LFS, updated Phase 6/7 tasks. All four plan-level open questions closed. |
| **Audio scope clarified** | `06-audio.md` is superseded — the pipeline half is `13` §4. Only track/SFX counts would remain. |

---

## 2. Contents

| File | Status | Owning chat |
|---|---|---|
| `01-vision.md` | v7, locked | design |
| `02-notes-system.md` | v3, locked | design |
| `05-art-direction.md` | v3 — direction, tile size, and palette method locked | pipeline |
| `07-items-economy.md` | v5, locked | design |
| `08-invariants.md` | v3, locked | design |
| `09-identity.md` | v2, locked | design |
| `10-time-and-progression.md` | v2, locked | design |
| `11-moment-to-moment.md` | v2, locked — A-I resolved | design |
| `12-tears.md` | v1, locked — A-II resolved | design |
| `13-asset-pipeline.md` | v4, art + audio + concept locked | pipeline |
| `14-vertical-slice.md` | v1 — Signal Tower | design |
| `15-server-ops.md` | v1, draft | pipeline |
| `03-net-protocol.md` | v2, draft — **written** | pipeline |
| `04-data-model.md` | v2, draft — **written** | pipeline |
| `GDD-OPEN.md` | live inventory | design |
| `HANDOFF.md` | live delta list | pipeline |
| `GDD-QUESTIONS.md` | **archive** — superseded by `GDD-OPEN.md` | — |

**To be written:** nothing. `03-net-protocol.md` and `04-data-model.md` are now written (T-0091, T-0090 complete as design artifacts — dispatch implements rather than authors). `06-audio.md` is superseded by `13` §4.

**Remaining uncovered topics:** level design / variant authoring rules, first-run experience, localization mechanism. Telemetry is tracked as OPS-6 in `15`.

**`PLAN.md` is git-only, deliberately.** It is a machine-readable build plan — repo layout, task tables, CI jobs, the Phase 4 schema — not design. Dispatch reads and amends it in git, so a Notion copy would drift the moment task cards start moving. Canonical location: `docs/PLAN.md` in the repo.

---

## 3. For Dispatch — Reconciliation

1. `PLAN.md`, `HANDOFF.md`, `GDD-OPEN.md` → `docs/`.
2. `01`, `02`, `05`, `07`–`13` → `docs/design/`. `GDD-QUESTIONS.md` → `docs/archive/`.
3. **Overwrite** the existing `docs/design/01`, `02`, `05` stubs — they are eight-line placeholders reading *"DRAFT — blocked on GDD."*
4. **Delete** the repo's `03-net-protocol.md` and `04-data-model.md` and commit the versions in this workspace — they are written, not sketches. Do not merge the repo copies; see §4.
5. **Delete** `06-audio.md` — superseded by `13` §4.
6. Create the task cards for `HANDOFF.md` §3 (revised) and §4 (new, T-0090–T-0103). **`PLAN.md` already reflects these**; the `tasks/*.md` files do not yet exist.
7. Commit.

---

## 4. Repo Docs That Are Actively Wrong

Not stale — they describe systems the GDD replaced. An agent reading them will implement the wrong thing.

| Repo file | Problem |
|---|---|
| `docs/design/03-net-protocol.md` | `GET /v1/roll` (**secret drops — cut**) and `GET /v1/notes?zone&x&y&r` (**radius query — eliminated**) |
| `docs/design/04-data-model.md` | `secret_drops`, `drop_grants`, `zone_id` columns. All three gone |
| `docs/design/01`, `02`, `05`, `06` | Eight-line stubs still saying "blocked on GDD" |
| `docs/PLAN.md` | Repo copy is **v2**; canonical is **v4** |

---

## 5. Remaining Blockers

| # | Question | Blocks |
|---|---|---|
| **~~V-5~~** | Home palette — **resolved.** Extracted from an approved concept sheet by T-0105 (`13` §6.6), not chosen | — |
| T-1 / T-2 / E-1 | Exact clock durations within their brackets | the sim's *tuning sweep*, not the harness |

**Nothing is blocked on a human decision.** T-1, T-2 and E-1 are sim outputs within brackets already set. Phase 6 starts at **T-0104** (concept sheet), which needs no LoRA, no palette, and no prior calls.

Everything else is content budget or playtest data. Full inventory in `GDD-OPEN.md`.

---

## 6. Going Forward

- **One doc, one owning chat.** Cross-edits are requested, not made.
- Every doc keeps a changelog table. A doc whose newest row is absent from git failed to land.

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2026-08-02 | rev 1 — merged duplicate uploads, `_2` copies taken wholesale | Claude |
| 2026-08-02 | rev 2 — version drift fixed, A-1 and M-5 resolved, pipeline folded into HANDOFF, PLAN deltas applied | Claude |
| 2026-08-02 | rev 3 — 03/04 written and 14/15 added to contents; concept-art stage folded into 13/05/HANDOFF; **V-5 resolved** by extraction; all appended amendments folded into their sections and removed | Claude |
