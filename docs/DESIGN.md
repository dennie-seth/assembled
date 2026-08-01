# Design docs index

**Author:** Claude (Opus 5)

The GDD session landed (`docs/HANDOFF.md`, 2026-08-01). **All seven locked
design docs are now present in this repo — nothing is pending.** Where a
doc and `docs/PLAN.md` disagree, the doc wins: `PLAN.md` predates the GDD
and has known drift, tracked in `HANDOFF.md` §3.

| Doc | Status |
|---|---|
| [01-vision.md](design/01-vision.md) | v3, locked |
| [02-notes-system.md](design/02-notes-system.md) | v2, locked |
| [03-net-protocol.md](design/03-net-protocol.md) | v2, written (T-0091) directly from `07-items-economy.md` + `10-time-and-progression.md` |
| [04-data-model.md](design/04-data-model.md) | v1, drafted (T-0090) from `HANDOFF.md` §5 |
| [05-art-direction.md](design/05-art-direction.md) | v1, direction locked, numbers open (V-5) |
| [06-audio.md](design/06-audio.md) | missing — Phase 7, not urgent (per `HANDOFF.md` §1) |
| [07-items-economy.md](design/07-items-economy.md) | v2, locked |
| [08-invariants.md](design/08-invariants.md) | locked (INV-1…14) |
| [09-identity.md](design/09-identity.md) | v1, locked |
| [10-time-and-progression.md](design/10-time-and-progression.md) | v1, locked |
| [agent-runner.md](design/agent-runner.md) | agreed — Phase 2 (tooling, not GDD-numbered) |
| [GDD-QUESTIONS.md](design/GDD-QUESTIONS.md) | archived — superseded by the docs above for Tiers 1–6; Tier 7 tracked in `OPEN-QUESTIONS.md` |
| [OPEN-QUESTIONS.md](design/OPEN-QUESTIONS.md) | live — tuning/parameter questions blocked on @DennieSeth (`HANDOFF.md` §6) |

**06-audio.md is the only doc without full content** — Phase 7 is far
enough out that it isn't urgent, per the handoff. Everything else that
gates Phases 3–6 is locked.
