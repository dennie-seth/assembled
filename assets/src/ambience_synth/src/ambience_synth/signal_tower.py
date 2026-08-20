"""Signal Tower archetype ambience bed recipe (T-0202).

13-asset-pipeline.md §4.3: "One looping ambience per archetype."
14-vertical-slice.md: Signal Tower is the Phase 8 vertical-slice archetype.

The Signal Tower is a Soviet-era brutalist communications facility. The
ambience conveys the electromagnetic and mechanical character of the space:
a low 60 Hz power-grid hum dominating, with concrete room resonances at
harmonics, and faint distant ventilation texture at higher frequencies.

All layers are filtered noise (no oscillators, physically-inspired — same
philosophy as sfx_synth's one-shots). Pink noise for low-mid bands (1/f
power spectrum approximates real-world room resonances); white noise for
the upper electronic texture.

Gain structure keeps high-frequency content well below the fundamental so
the loop-fold seam check passes: at -23 LUFS (ambience bus target), the
60 Hz component's sample-to-sample variation over the 32-sample check
window stays below the 0.10 threshold (see T-0202 analysis).

Layer gains (dB relative to 60 Hz layer):
  60 Hz:    0 dB   — dominant hum, sets loudness floor
  120 Hz:  -8 dB   — first harmonic
  200 Hz: -10 dB   — room mode (concrete box ~4m cavity at 200 Hz)
  700 Hz: -20 dB   — distant ventilation, narrow-band
  2800 Hz:-30 dB   — electronic texture / fluorescent hiss
"""

from __future__ import annotations

from ambience_synth.recipe import AmbienceLayer, AmbienceRecipe

SIGNAL_TOWER_AMBIENCE = AmbienceRecipe(
    name="signal_tower_ambience",
    seed=202,
    bus="ambience",
    body_s=30.0,
    crossfade_s=2.0,
    sample_rate=44100,
    layers=(
        # Primary 60 Hz power-grid hum — the load-bearing tone.
        AmbienceLayer(noise_color="pink", center_hz=60.0, q=12.0, gain_db=0.0),
        # First harmonic (120 Hz) — adds harmonic fullness.
        AmbienceLayer(noise_color="pink", center_hz=120.0, q=10.0, gain_db=-8.0),
        # Concrete room resonance at ~200 Hz — 4m cavity mode.
        AmbienceLayer(noise_color="pink", center_hz=200.0, q=6.0, gain_db=-10.0),
        # Distant ventilation: wider band, lower Q, gives air to the texture.
        AmbienceLayer(noise_color="pink", center_hz=700.0, q=2.0, gain_db=-20.0),
        # Fluorescent / electronic hiss — barely audible, adds presence.
        AmbienceLayer(noise_color="white", center_hz=2800.0, q=1.5, gain_db=-30.0),
    ),
)
