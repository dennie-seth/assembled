"""AmbienceRecipe: the reproducible looping-bed synthesis unit.

Mirrors sfx_synth.recipe.Recipe's role but for long looping content —
bus is "ambience" (not the one-shot buses), and the recipe carries
crossfade_s (loop-fold window) instead of min_s/max_s length bounds.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AmbienceLayer:
    """One filtered-noise layer in an ambience bed.

    noise_color: "pink" or "white"
    center_hz:   bandpass filter centre frequency
    q:           bandpass filter Q (centre / bandwidth)
    gain_db:     layer gain relative to 0 dB reference
    """

    noise_color: str
    center_hz: float
    q: float
    gain_db: float = 0.0

    def __post_init__(self) -> None:
        if self.noise_color not in ("pink", "white"):
            raise ValueError(f"noise_color must be 'pink' or 'white', got {self.noise_color!r}")
        if self.center_hz <= 0:
            raise ValueError(f"center_hz must be > 0, got {self.center_hz}")
        if self.q <= 0:
            raise ValueError(f"q must be > 0, got {self.q}")


@dataclass(frozen=True)
class AmbienceRecipe:
    """Complete, reproducible description of a looping ambience bed.

    body_s:      loop body duration (after loop-fold removes the tail)
    crossfade_s: crossfade window; raw synthesis = body_s + crossfade_s
    sample_rate: output sample rate (Hz)
    bus:         must be "ambience" (13-asset-pipeline.md §4.1)
    """

    name: str
    seed: int
    layers: tuple[AmbienceLayer, ...]
    body_s: float
    crossfade_s: float
    sample_rate: int = 44100
    bus: str = "ambience"

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("name must not be empty")
        if not self.layers:
            raise ValueError("layers must contain at least one AmbienceLayer")
        if self.body_s <= 0:
            raise ValueError(f"body_s must be > 0, got {self.body_s}")
        if self.crossfade_s <= 0:
            raise ValueError(f"crossfade_s must be > 0, got {self.crossfade_s}")
        if self.sample_rate <= 0:
            raise ValueError(f"sample_rate must be > 0, got {self.sample_rate}")
        if self.bus != "ambience":
            raise ValueError(f"bus must be 'ambience', got {self.bus!r}")

    @property
    def raw_s(self) -> float:
        """Total raw synthesis length: body + crossfade tail."""
        return self.body_s + self.crossfade_s
