"""Concrete one-shot recipes (T-0101): footstep, switch, door, pickup.

Each is a small stack of `Layer`s (noise burst -> resonant filter ->
envelope, `13-asset-pipeline.md` §4.5) -- no oscillators, no sfxr-style
chiptune. `DOOR`'s creak is a handful of short pink-noise layers at
descending resonant frequencies fired in quick succession, which
approximates a slow filter sweep without needing time-varying filter
coefficients.

**Bus assignment** (D-20, `13-asset-pipeline.md` §4.0-4.1): the footstep
is the player-noise-feedback channel §4.0 names explicitly as
fairness-critical, so it is Gameplay SFX (P-5: never ducked). Switch,
door, and pickup are environment/interaction feedback, not part of that
fairness channel, so they are World SFX (lightly duckable). This is a
reasonable default for T-0082/T-0103 to build on, not a resolved design
call -- AU-3 (does audio carry anything beyond threat/state?) is still open.
"""

from __future__ import annotations

from sfx_synth.recipe import Layer, Recipe

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

ALL_RECIPES: dict[str, Recipe] = {
    recipe.name: recipe for recipe in (FOOTSTEP_CONCRETE, SWITCH_CLICK, DOOR, ITEM_PICKUP)
}
