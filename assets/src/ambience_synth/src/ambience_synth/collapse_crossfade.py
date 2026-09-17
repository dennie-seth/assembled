"""Collapse layer: four-stage crossfaded audio (T-0203).

13-asset-pipeline.md §4.4: global collapse layer, 4 stages, crossfaded on
collapse proximity — the same [0.0, 1.0] value that drives chroma intensity
(10-time-and-progression.md §4, 01-vision.md §8).

Design:
  - Four AmbienceRecipe stages representing escalating collapse dread.
  - Proximity [0.0, 1.0] maps to three equal-length crossfade segments:
      [0.0, 1/3)  → stage 0 → stage 1
      [1/3, 2/3)  → stage 1 → stage 2
      [2/3, 1.0]  → stage 2 → stage 3
  - At most two stages are audible at once (the crossfade pair).
  - Linear gains: lower_gain = 1.0 - alpha, upper_gain = alpha.
  - Only two stages are streamed at once — stream, do not preload all four.

Sound character by stage (filtered noise, physically-inspired):
  Stage 0 — "Absence"   : sub-bass presence only; the universe is quietly dying
  Stage 1 — "Tremor"    : harmonics emerge; structure becoming unstable
  Stage 2 — "Fracture"  : mid-frequency resonances; audible structural decay
  Stage 3 — "Collapse"  : dense harmonic complexity; imminent dissolution
"""

from __future__ import annotations

from ambience_synth.recipe import AmbienceLayer, AmbienceRecipe

# ── Collapse stage recipes ────────────────────────────────────────────────────
# Seeds are T-0203-prefixed (2030, 2031, 2032, 2033) to avoid collision with
# other recipes (signal tower uses seed=202).
# All stages: ambience bus, 30 s body + 2 s crossfade, 44100 Hz.
# Loudness-normalized to -23 LUFS (ambience bus target, see pipeline.py).

_BODY_S = 30.0
_CROSSFADE_S = 2.0
_SR = 44100

COLLAPSE_STAGES: tuple[AmbienceRecipe, ...] = (
    # ── Stage 0 — "Absence" ──────────────────────────────────────────────────
    # The universe is slowly dying; the sound is barely there.
    # A single very low sub-bass presence (30 Hz), narrow-band, almost
    # inaudible — felt more than heard. Appropriate for proximity near 0.
    AmbienceRecipe(
        name="collapse_stage_0",
        seed=2030,
        bus="ambience",
        body_s=_BODY_S,
        crossfade_s=_CROSSFADE_S,
        sample_rate=_SR,
        layers=(
            # Sub-bass drone: 30 Hz fundamental — infrasonic edge of perception.
            AmbienceLayer(noise_color="pink", center_hz=30.0, q=8.0, gain_db=0.0),
        ),
    ),
    # ── Stage 1 — "Tremor" ───────────────────────────────────────────────────
    # Structure begins to resonate. Harmonics emerge above the sub.
    AmbienceRecipe(
        name="collapse_stage_1",
        seed=2031,
        bus="ambience",
        body_s=_BODY_S,
        crossfade_s=_CROSSFADE_S,
        sample_rate=_SR,
        layers=(
            # Sub-bass drone persists.
            AmbienceLayer(noise_color="pink", center_hz=30.0, q=8.0, gain_db=0.0),
            # 60 Hz harmonic — power-grid resonance awakened.
            AmbienceLayer(noise_color="pink", center_hz=60.0, q=10.0, gain_db=-6.0),
            # 180 Hz room mode — concrete structure vibrating.
            AmbienceLayer(noise_color="pink", center_hz=180.0, q=5.0, gain_db=-14.0),
        ),
    ),
    # ── Stage 2 — "Fracture" ─────────────────────────────────────────────────
    # Audible structural decay. Mid-band resonances crawl upward.
    AmbienceRecipe(
        name="collapse_stage_2",
        seed=2032,
        bus="ambience",
        body_s=_BODY_S,
        crossfade_s=_CROSSFADE_S,
        sample_rate=_SR,
        layers=(
            # Sub-bass intensifies.
            AmbienceLayer(noise_color="pink", center_hz=30.0, q=6.0, gain_db=0.0),
            # 60 Hz — louder, spreading.
            AmbienceLayer(noise_color="pink", center_hz=60.0, q=8.0, gain_db=-4.0),
            # 180 Hz — pronounced, structure shaking.
            AmbienceLayer(noise_color="pink", center_hz=180.0, q=4.0, gain_db=-9.0),
            # 500 Hz mid creak — material stress resonance.
            AmbienceLayer(noise_color="pink", center_hz=500.0, q=3.0, gain_db=-16.0),
            # White noise hiss — electrical discharge, fracturing surfaces.
            AmbienceLayer(noise_color="white", center_hz=3000.0, q=1.5, gain_db=-24.0),
        ),
    ),
    # ── Stage 3 — "Collapse" ─────────────────────────────────────────────────
    # Imminent dissolution. Dense harmonic complexity; the universe ending.
    AmbienceRecipe(
        name="collapse_stage_3",
        seed=2033,
        bus="ambience",
        body_s=_BODY_S,
        crossfade_s=_CROSSFADE_S,
        sample_rate=_SR,
        layers=(
            # Sub-bass at its widest — filling the low end.
            AmbienceLayer(noise_color="pink", center_hz=30.0, q=4.0, gain_db=0.0),
            # 60 Hz foundation — dominant hum.
            AmbienceLayer(noise_color="pink", center_hz=60.0, q=6.0, gain_db=-3.0),
            # 180 Hz — ringing concrete.
            AmbienceLayer(noise_color="pink", center_hz=180.0, q=3.0, gain_db=-7.0),
            # 500 Hz — material-stress creak, now loud.
            AmbienceLayer(noise_color="pink", center_hz=500.0, q=2.5, gain_db=-12.0),
            # 1200 Hz upper-mid distortion — crumbling edge frequencies.
            AmbienceLayer(noise_color="pink", center_hz=1200.0, q=2.0, gain_db=-18.0),
            # Broadband white noise texture — chaos approaching.
            AmbienceLayer(noise_color="white", center_hz=4000.0, q=1.2, gain_db=-20.0),
        ),
    ),
)

# Number of stages — derived from the tuple so no magic constant elsewhere.
NUM_STAGES: int = len(COLLAPSE_STAGES)  # 4


# ── Crossfade logic ───────────────────────────────────────────────────────────

def collapse_crossfade_pair(proximity: float) -> tuple[int, int, float]:
    """Return (lower_stage, upper_stage, alpha) for the given collapse proximity.

    Parameters
    ----------
    proximity:
        Collapse proximity in [0.0, 1.0].  Values outside this range are
        clamped.  0.0 = universe birth; 1.0 = collapse.

    Returns
    -------
    lower_stage:
        Index of the fading-out stage (0..2).
    upper_stage:
        Index of the fading-in stage (1..3); always lower_stage + 1.
    alpha:
        Linear crossfade position in [0.0, 1.0].
        lower_gain = 1.0 - alpha
        upper_gain = alpha

    Segment map (3 equal segments over 4 stages):
        [0.0, 1/3)  → stages (0, 1)
        [1/3, 2/3)  → stages (1, 2)
        [2/3, 1.0]  → stages (2, 3)

    At most two stages have non-zero gain at any proximity value.
    """
    # Clamp to [0.0, 1.0]
    p = max(0.0, min(1.0, proximity))
    # Map to [0.0, 3.0] — one unit per segment
    stage_float = p * (NUM_STAGES - 1)
    # Lower index: 0..2 (the fade-out stage)
    lower = min(NUM_STAGES - 2, int(stage_float))
    # Alpha: fractional position within the segment [0, 1]
    alpha = stage_float - lower
    # Clamp alpha to [0.0, 1.0] to guard float rounding at p=1.0
    alpha = max(0.0, min(1.0, alpha))
    upper = lower + 1
    return lower, upper, alpha
