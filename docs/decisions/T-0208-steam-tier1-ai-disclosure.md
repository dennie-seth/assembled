# T-0208 — Steam Tier 1 pre-generated AI disclosure (draft)

**Author:** Claude (Sonnet 5)
**Implements the decision already cleared in:** `docs/design/01-vision.md`
§9, "Steam AI disclosure (verified 2026-08-01)"
**Also see:** `docs/HANDOFF.md` D-14

---

## Status

**Draft.** The decision this text implements — Tier 1 applies, dev tooling
is exempt, Tier 2 doesn't apply — was already settled and verified
2026-08-01 in `01-vision.md` §9. What follows is the actual store-page
text implementing that decision, ready to paste into Steamworks' AI
Generated Content Disclosure field. **Re-verify this draft against the
final shipped asset mix before store page submission** — if the audio
pipeline ends up shipping AI-generated tracks (T-0080–T-0084, currently
deterministic DSP synthesis, not AI) or the art pipeline changes models,
update the text below before it goes live rather than shipping a stale
disclosure.

---

## Store page AI disclosure text

The block below is the literal text for Steamworks' "How does your game
use AI generated content?" field.

```text
Assembled uses AI-generated content in two places, both pre-generated
during development and fixed in the shipped build — nothing is generated
live while you play.

- Character and environment sprite art: generated with Stable Diffusion
  XL (SDXL) base model plus a custom-trained style LoRA (the project's
  own Soviet-brutalist/constructivist style adapter), then hand-curated
  and pixel-descended before being committed to the game.
- Sound/music assets: where AI-assisted generation tooling is used for
  music or sound effects, those assets are likewise pre-generated during
  development and fixed in the shipped build, never produced at runtime.

No in-game text is AI-generated. Every player-visible note is assembled
from a fixed template plus a small set of pre-written word choices (never
free text, never generated), so there is no live or dynamic AI content of
any kind anywhere in the game.
```

---

## Scope

**Covered (Tier 1 — pre-generated):**
- Generated sprite art (character and entity sheets), produced with the
  SDXL base checkpoint plus the project's own trained style LoRA — see
  `ASSET_PROVENANCE.md` for the per-asset model/license/prompt/seed
  record required by `.claude/rules/conduct.md`.
- Generated audio, if/when the audio pipeline ships AI-generated tracks
  (Phase 6, T-0080–T-0084). As of this draft, committed audio
  (`assets/final/audio/*.ogg`) is deterministic DSP synthesis, not
  AI-generated — the disclosure text above is written broadly enough to
  cover the design's Tier 1 clearance for audio without overclaiming what
  has already shipped.

**Explicitly exempt — out of scope for this disclosure:**
- Dev tooling. Claude Code and other AI-assisted development tools used
  to *build* the game are explicitly exempt under Valve's Jan 2026 rules,
  which scope disclosure to content players consume, not how the game was
  made.

**Does not apply:**
- **Tier 2 (live/runtime AI generation) does not apply to this game.**
  There is no live generation anywhere in this design: player-facing
  notes are always `template_id` + slot FKs resolved from immutable
  lookup tables (`.claude/rules/conduct.md`, `docs/design/02-notes-system.md`),
  never free text and never produced by a model at runtime. Nothing else
  in the game is generated during play either.

---

## Review-risk framing

Valve does not reject games for AI content when the disclosure is
accurate — it enforces against **omission**, not against AI content
itself. The residual risk this draft carries forward from `01-vision.md`
§9 is commercial, not procedural: AI-disclosed titles see measurably
worse review behaviour on average. Accuracy of this text, kept in sync
with what actually ships, is what keeps that risk procedural-free; it
does not make the commercial risk go away.
