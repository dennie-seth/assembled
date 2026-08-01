# Design docs index

**Author:** Claude (Opus 5)

The GDD session landed (`docs/HANDOFF.md`, 2026-08-01). Most design docs are
now locked; a few are still pending delivery into this repo. **Where a doc
and `docs/PLAN.md` disagree, the doc wins** — `PLAN.md` predates the GDD and
has known drift, tracked in `HANDOFF.md` §3.

| Doc | Status |
|---|---|
| [01-vision.md](design/01-vision.md) | **PENDING** — locked per `HANDOFF.md` (v3) but not yet delivered into this repo; still shows the pre-GDD stub |
| [02-notes-system.md](design/02-notes-system.md) | v2, locked |
| [03-net-protocol.md](design/03-net-protocol.md) | v1, drafted (T-0091) from the HANDOFF schema/invariants — items/escrow/session sections flagged for reconciliation once `07-items-economy.md` lands |
| [04-data-model.md](design/04-data-model.md) | v1, drafted (T-0090) from `HANDOFF.md` §5 |
| [05-art-direction.md](design/05-art-direction.md) | **PENDING** — locked per `HANDOFF.md` (v1) but not yet delivered into this repo; still shows the pre-GDD stub |
| [06-audio.md](design/06-audio.md) | missing — Phase 7, not urgent (per `HANDOFF.md` §1) |
| 07-items-economy.md | **PENDING** — locked per `HANDOFF.md` (v3) but not yet delivered into this repo; the `07` slot is reserved, no stub committed |
| [08-invariants.md](design/08-invariants.md) | locked (INV-1…14) |
| [09-identity.md](design/09-identity.md) | v1, locked |
| 10-time-and-progression.md | **PENDING** — locked per `HANDOFF.md` (v1) but not yet delivered into this repo; the four wall-clocks live here |
| [agent-runner.md](design/agent-runner.md) | agreed — Phase 2 (tooling, not GDD-numbered) |
| [GDD-QUESTIONS.md](design/GDD-QUESTIONS.md) | archived — superseded by the docs above for Tiers 1–6; Tier 7 tracked in `OPEN-QUESTIONS.md` |
| [OPEN-QUESTIONS.md](design/OPEN-QUESTIONS.md) | live — tuning/parameter questions blocked on @DennieSeth (`HANDOFF.md` §6) |

**Four docs are still pending delivery: 01, 05, 07, 10.** Their decisions are
already summarized in `docs/HANDOFF.md` §2 and cited throughout the locked
docs, but the full doc text hasn't landed in this repo yet — treat the
`HANDOFF.md` summary as authoritative until it does.
