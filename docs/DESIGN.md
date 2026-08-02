# Design docs index

**Author:** Claude (Opus 5)

The GDD session landed (`docs/HANDOFF.md`) and a follow-up reconciliation
pass folded the art/audio pipeline decisions in (2026-08-02). **All docs
below are now present in this repo — nothing is pending except the two
repo-native protocol/schema docs, which are already written.** Where a doc
and `docs/PLAN.md` disagree, the doc wins: `PLAN.md` predates the GDD and
has known drift, tracked in `HANDOFF.md` §3.

| Doc | Status |
|---|---|
| [01-vision.md](design/01-vision.md) | v7, locked |
| [02-notes-system.md](design/02-notes-system.md) | v3, locked |
| [03-net-protocol.md](design/03-net-protocol.md) | v2, written (T-0091) directly from `07-items-economy.md` + `10-time-and-progression.md` |
| [04-data-model.md](design/04-data-model.md) | v1, drafted (T-0090) from `HANDOFF.md` §5 |
| [05-art-direction.md](design/05-art-direction.md) | v2 — direction + tile size locked (D-16), palette open (V-5) |
| [07-items-economy.md](design/07-items-economy.md) | v5, locked |
| [08-invariants.md](design/08-invariants.md) | v3, locked (INV-1…14) |
| [09-identity.md](design/09-identity.md) | v2, locked |
| [10-time-and-progression.md](design/10-time-and-progression.md) | v2, locked |
| [11-moment-to-moment.md](design/11-moment-to-moment.md) | v2, locked — A-I resolved |
| [12-tears.md](design/12-tears.md) | v1, locked — A-II resolved |
| [13-asset-pipeline.md](design/13-asset-pipeline.md) | v3, art + audio pipeline locked |
| [agent-runner.md](design/agent-runner.md) | agreed — Phase 2 (tooling, not GDD-numbered) |
| [INDEX.md](design/INDEX.md) | reconciliation record for the 2026-08-02 doc merge — historical, not live |
| [GDD-QUESTIONS.md](design/GDD-QUESTIONS.md) | archived in place, annotated superseded — Tiers 1–6 landed above, Tier 7 in `OPEN-QUESTIONS.md`. A duplicate un-annotated copy also lives at `../archive/GDD-QUESTIONS.md` per the reconciliation source; the annotated copy here is canonical |
| [OPEN-QUESTIONS.md](design/OPEN-QUESTIONS.md) | live — tuning/parameter questions blocked on @DennieSeth (`HANDOFF.md` §6) |

**`06-audio.md` removed** — superseded by `13-asset-pipeline.md` §4; it was
never more than a two-line stub blocked on the vision doc, which has since
landed.

**`03-net-protocol.md` and `04-data-model.md` are already correct** — they
were written directly against the locked economy/identity docs (T-0090,
T-0091, landed 2026-08-01) and contain no reference to the cut secret-drop
or radius-query systems. They are **not** the stale versions the
2026-08-02 reconciliation docs (`INDEX.md`, `HANDOFF.md`) describe as
"actively wrong" — that description predates this repo's T-0090/T-0091
work landing. Re-verified by grep before writing this line; do not delete
them on the strength of `INDEX.md` §4 alone.

Everything gating Phases 3–7 is locked. Remaining open items are content
budgets, playtest data, or the four blockers in `GDD-OPEN.md` §5
(V-5, T-1, T-2, E-1).
