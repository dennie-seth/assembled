"""Recipe: the reproducible one-shot synthesis unit (`13-asset-pipeline.md` §4.5).

Mirrors `comfy_client.recipe.Recipe`'s role for the generative path -- a
recipe is parameters + seed and nothing else, deliberately excluding
anything not needed to reproduce the exact same output byte-for-byte
(P-1: output ships as-is, rejection means regenerate with an adjusted
recipe). A `Recipe` is one or more `Layer`s (each one noise burst ->
resonant filter -> envelope) summed at their onsets.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from sfx_synth.dsp import ENVELOPE_CURVES, NOISE_GENERATORS

# D-20 / 13-asset-pipeline.md §4.1: the bus split is Ambience (duckable),
# Music, World SFX (lightly duckable), Gameplay SFX (priority, never
# ducked). One-shots synthesized here are interaction/feedback cues, never
# looping beds or the collapse layer -- so only the latter two apply.
ONE_SHOT_BUSES = frozenset({"world_sfx", "gameplay_sfx"})


@dataclass(frozen=True)
class Layer:
    onset_s: float
    noise_color: str
    center_hz: float
    q: float
    attack_s: float
    decay_s: float
    filter_order: int = 2
    envelope_curve: str = "exponential"
    gain_db: float = 0.0

    def __post_init__(self) -> None:
        if self.onset_s < 0:
            raise ValueError(f"onset_s must be >= 0, got {self.onset_s}")
        if self.noise_color not in NOISE_GENERATORS:
            raise ValueError(
                f"noise_color must be one of {sorted(NOISE_GENERATORS)}, got {self.noise_color!r}"
            )
        if self.center_hz <= 0:
            raise ValueError(f"center_hz must be > 0, got {self.center_hz}")
        if self.q <= 0:
            raise ValueError(f"q must be > 0, got {self.q}")
        if self.attack_s <= 0 or self.decay_s <= 0:
            raise ValueError("attack_s and decay_s must both be > 0")
        if self.filter_order <= 0:
            raise ValueError(f"filter_order must be > 0, got {self.filter_order}")
        if self.envelope_curve not in ENVELOPE_CURVES:
            raise ValueError(
                f"envelope_curve must be one of {ENVELOPE_CURVES}, got {self.envelope_curve!r}"
            )

    @property
    def duration_s(self) -> float:
        return self.attack_s + self.decay_s


@dataclass(frozen=True)
class Recipe:
    name: str
    seed: int
    bus: str
    layers: tuple[Layer, ...]
    min_s: float
    max_s: float
    sample_rate: int = 44100

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("recipe.name must not be empty")
        if not self.layers:
            raise ValueError("recipe.layers must contain at least one Layer")
        if self.bus not in ONE_SHOT_BUSES:
            raise ValueError(f"bus must be one of {sorted(ONE_SHOT_BUSES)}, got {self.bus!r}")
        if self.min_s >= self.max_s:
            raise ValueError(f"min_s ({self.min_s}) must be < max_s ({self.max_s})")
        if self.sample_rate <= 0:
            raise ValueError(f"sample_rate must be > 0, got {self.sample_rate}")


def recipe_to_dict(recipe: Recipe) -> dict:
    return asdict(recipe)
