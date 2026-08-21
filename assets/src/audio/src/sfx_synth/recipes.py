"""Concrete one-shot recipes (T-0101 + T-0204): full SFX set.

T-0101 (initial set): footstep_concrete, switch_click, door, item_pickup.
T-0204 (expanded set, HANDOFF §20-c3): footstep_walk, footstep_run (distinct),
item_leave, telegraph_watcher, telegraph_sound, telegraph_still_air.

Each recipe is a stack of `Layer`s (noise burst -> resonant filter ->
envelope, `13-asset-pipeline.md` §4.5) — no oscillators, no sfxr-style
chiptune. `DOOR`'s creak is a handful of short pink-noise layers at
descending resonant frequencies fired in quick succession, which
approximates a slow filter sweep without needing time-varying filter
coefficients.

**Bus assignment** (D-20, `13-asset-pipeline.md` §4.0-4.1):
  - Gameplay SFX (P-5: *never* ducked): footsteps (player-noise feedback,
    explicit fairness channel) and entity telegraphs (detection-warning
    fairness channel — a player who cannot hear a telegraph loses the
    fairness guarantee). Missing or ducked telegraphs are a gameplay
    defect, not an audio-mix choice.
  - World SFX (lightly duckable): switch, door, item pickup/leave —
    environment/interaction feedback, not part of the fairness channel.

This is a reasonable default for T-0082/T-0103 to build on; AU-3
(does audio carry anything beyond threat/state?) is still open.
"""

from __future__ import annotations

from sfx_synth.recipe import Layer, Recipe

# ── T-0101 originals ───────────────────────────────────────────────────────────

FOOTSTEP_CONCRETE = Recipe(
    name="footstep_concrete",
    seed=101,
    bus="gameplay_sfx",
    min_s=0.03,
    max_s=0.15,
    layers=(
        # Low thud: the body of the step against concrete.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=150.0,
            q=3.0,
            attack_s=0.002,
            decay_s=0.06,
        ),
        # Higher scuff, quieter and shorter, layered on top for grit.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=3200.0,
            q=2.5,
            attack_s=0.001,
            decay_s=0.025,
            gain_db=-8.0,
        ),
    ),
)

SWITCH_CLICK = Recipe(
    name="switch_click",
    seed=102,
    bus="world_sfx",
    min_s=0.02,
    max_s=0.12,
    layers=(
        # Press.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=4200.0,
            q=6.0,
            attack_s=0.0005,
            decay_s=0.012,
        ),
        # Release, slightly later and quieter -- the mechanism's return.
        Layer(
            onset_s=0.045,
            noise_color="white",
            center_hz=3600.0,
            q=6.0,
            attack_s=0.0005,
            decay_s=0.01,
            gain_db=-4.0,
        ),
    ),
)

DOOR = Recipe(
    name="door",
    seed=103,
    bus="world_sfx",
    min_s=0.3,
    max_s=0.9,
    layers=(
        # Creak: four short bursts at descending resonant frequency,
        # fired close together -- approximates a slow sweep.
        Layer(
            onset_s=0.00, noise_color="pink", center_hz=900.0, q=5.0, attack_s=0.01, decay_s=0.09
        ),
        Layer(
            onset_s=0.08,
            noise_color="pink",
            center_hz=700.0,
            q=5.0,
            attack_s=0.01,
            decay_s=0.09,
            gain_db=-1.0,
        ),
        Layer(
            onset_s=0.16,
            noise_color="pink",
            center_hz=550.0,
            q=5.0,
            attack_s=0.01,
            decay_s=0.09,
            gain_db=-2.0,
        ),
        Layer(
            onset_s=0.24,
            noise_color="pink",
            center_hz=450.0,
            q=5.0,
            attack_s=0.01,
            decay_s=0.09,
            gain_db=-3.0,
        ),
        # Thud: the door meeting its frame at the end of the swing.
        Layer(
            onset_s=0.42,
            noise_color="white",
            center_hz=130.0,
            q=2.5,
            attack_s=0.004,
            decay_s=0.12,
            gain_db=2.0,
        ),
    ),
)

ITEM_PICKUP = Recipe(
    name="item_pickup",
    seed=104,
    bus="world_sfx",
    min_s=0.08,
    max_s=0.3,
    layers=(
        # Three short bursts at rising resonant frequency -- a "positive
        # collectible" cue built from filtered noise, not a tone/arpeggio.
        Layer(
            onset_s=0.00,
            noise_color="pink",
            center_hz=900.0,
            q=10.0,
            attack_s=0.002,
            decay_s=0.05,
        ),
        Layer(
            onset_s=0.035,
            noise_color="pink",
            center_hz=1400.0,
            q=10.0,
            attack_s=0.002,
            decay_s=0.05,
            gain_db=-1.0,
        ),
        Layer(
            onset_s=0.07,
            noise_color="pink",
            center_hz=2100.0,
            q=10.0,
            attack_s=0.002,
            decay_s=0.07,
            gain_db=-2.0,
        ),
    ),
)

# ── T-0204 additions (HANDOFF §20-c3) ─────────────────────────────────────────

FOOTSTEP_WALK = Recipe(
    name="footstep_walk",
    seed=105,
    bus="gameplay_sfx",  # player-noise feedback: fairness channel P-5, never ducked
    min_s=0.04,
    max_s=0.18,
    layers=(
        # Soft thud: measured weight of a careful walk, lower energy than run.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=140.0,
            q=3.5,
            attack_s=0.003,
            decay_s=0.07,
            gain_db=-2.0,
        ),
        # Gentle scuff: light surface contact, quieter than a run.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=2800.0,
            q=2.0,
            attack_s=0.001,
            decay_s=0.022,
            gain_db=-10.0,
        ),
    ),
)

FOOTSTEP_RUN = Recipe(
    name="footstep_run",
    seed=106,
    bus="gameplay_sfx",  # player-noise feedback: fairness channel P-5, never ducked
    min_s=0.03,
    max_s=0.15,
    layers=(
        # Heavy thud: full body weight striking concrete at running speed.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=120.0,
            q=2.5,
            attack_s=0.001,
            decay_s=0.08,
            gain_db=3.0,
        ),
        # Sharp scuff: fast sole-drag, higher energy and broader than walk.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=4000.0,
            q=2.0,
            attack_s=0.0008,
            decay_s=0.03,
            gain_db=-5.0,
        ),
        # Mid-frequency flexion crack: foot and sole bending at speed.
        Layer(
            onset_s=0.008,
            noise_color="white",
            center_hz=650.0,
            q=2.0,
            attack_s=0.001,
            decay_s=0.018,
            gain_db=-12.0,
        ),
    ),
)

ITEM_LEAVE = Recipe(
    name="item_leave",
    seed=107,
    bus="world_sfx",
    min_s=0.08,
    max_s=0.3,
    layers=(
        # Three short bursts at *descending* resonant frequency -- mirror of
        # item_pickup's ascending arc, reads as "setting down" vs. "collecting".
        Layer(
            onset_s=0.00,
            noise_color="pink",
            center_hz=2100.0,
            q=10.0,
            attack_s=0.002,
            decay_s=0.05,
            gain_db=-2.0,
        ),
        Layer(
            onset_s=0.035,
            noise_color="pink",
            center_hz=1400.0,
            q=10.0,
            attack_s=0.002,
            decay_s=0.05,
            gain_db=-1.0,
        ),
        Layer(
            onset_s=0.07,
            noise_color="pink",
            center_hz=900.0,
            q=10.0,
            attack_s=0.002,
            decay_s=0.07,
        ),
    ),
)

TELEGRAPH_WATCHER = Recipe(
    name="telegraph_watcher",
    seed=108,
    bus="gameplay_sfx",  # detection-warning fairness channel P-5, never ducked
    min_s=0.04,
    max_s=0.25,
    layers=(
        # Sharp electronic click: the Watcher's mechanical scan locking on.
        # High frequency, short, hard-edged — surveillance orb character.
        Layer(
            onset_s=0.0,
            noise_color="white",
            center_hz=5200.0,
            q=8.0,
            attack_s=0.0005,
            decay_s=0.015,
        ),
        # Lower harmonic: the lens mechanism resonance behind the click.
        Layer(
            onset_s=0.012,
            noise_color="white",
            center_hz=2400.0,
            q=6.0,
            attack_s=0.001,
            decay_s=0.025,
            gain_db=-5.0,
        ),
        # Sub-click repeat: scanner confirms lock, slightly softer.
        Layer(
            onset_s=0.04,
            noise_color="white",
            center_hz=4800.0,
            q=7.0,
            attack_s=0.0005,
            decay_s=0.012,
            gain_db=-8.0,
        ),
    ),
)

TELEGRAPH_SOUND = Recipe(
    name="telegraph_sound",
    seed=109,
    bus="gameplay_sfx",  # detection-warning fairness channel P-5, never ducked
    min_s=0.06,
    max_s=0.3,
    layers=(
        # Broadening wave-crest: the Sound entity's wave-band responding to
        # acoustic stimulus. Mid-range burst, pink (softer spectrum), wide Q.
        Layer(
            onset_s=0.0,
            noise_color="pink",
            center_hz=800.0,
            q=4.0,
            attack_s=0.005,
            decay_s=0.07,
        ),
        # Overtone ripple: second wavefront, higher and quieter.
        Layer(
            onset_s=0.03,
            noise_color="pink",
            center_hz=1600.0,
            q=4.0,
            attack_s=0.004,
            decay_s=0.06,
            gain_db=-4.0,
        ),
        # Fading crest: third ripple at the trailing edge.
        Layer(
            onset_s=0.07,
            noise_color="pink",
            center_hz=1200.0,
            q=3.5,
            attack_s=0.004,
            decay_s=0.05,
            gain_db=-8.0,
        ),
    ),
)

TELEGRAPH_STILL_AIR = Recipe(
    name="telegraph_still_air",
    seed=110,
    bus="gameplay_sfx",  # detection-warning fairness channel P-5, never ducked
    min_s=0.08,
    max_s=0.35,
    layers=(
        # Low column resonance: the Still Air entity's atmospheric pillar
        # shuddering as it senses disruption. Slow attack, long tail.
        Layer(
            onset_s=0.0,
            noise_color="pink",
            center_hz=200.0,
            q=6.0,
            attack_s=0.01,
            decay_s=0.12,
        ),
        # First overtone: the column's second mode, quieter and shorter.
        Layer(
            onset_s=0.0,
            noise_color="pink",
            center_hz=420.0,
            q=5.0,
            attack_s=0.008,
            decay_s=0.09,
            gain_db=-4.0,
        ),
        # Airy breath: high, very quiet presence confirming atmospheric disturbance.
        Layer(
            onset_s=0.02,
            noise_color="pink",
            center_hz=900.0,
            q=3.5,
            attack_s=0.012,
            decay_s=0.08,
            gain_db=-12.0,
        ),
    ),
)

ALL_RECIPES: dict[str, Recipe] = {
    recipe.name: recipe
    for recipe in (
        # T-0101 originals
        FOOTSTEP_CONCRETE,
        SWITCH_CLICK,
        DOOR,
        ITEM_PICKUP,
        # T-0204 additions
        FOOTSTEP_WALK,
        FOOTSTEP_RUN,
        ITEM_LEAVE,
        TELEGRAPH_WATCHER,
        TELEGRAPH_SOUND,
        TELEGRAPH_STILL_AIR,
    )
}
