"""Deterministic one-shot SFX synthesis (T-0101).

`docs/design/13-asset-pipeline.md` §4.5: short one-shots (footsteps,
switches, doors, item pickups) are a seeded script rendering WAVs offline,
not a generative model -- physically-inspired synthesis (noise burst ->
resonant filter -> envelope), not sfxr/Bfxr chiptune. The recipe (params +
seed) is the source; nothing here is regenerated from anywhere else.
"""
