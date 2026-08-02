"""Bus-assignment enum (D-20, docs/HANDOFF.md §2, docs/design/13-asset-pipeline.md §4.1).

**P-5 -- Gameplay SFX are never ducked.** Music ducks the ambience bed; it
must not touch entity telegraph (Gameplay SFX) or the lightly-duckable
World SFX bus. D-20 makes the bus a gameplay property, decided at
generation time and carried with the asset -- not a mix setting bolted on
later -- because T-0103's client-side routing consumes it directly.

`AudioAgent` (T-0082) drives ACE-Step for music specifically
(13-asset-pipeline.md §4.2), so `MusicRecipe.bus` defaults to `Bus.MUSIC`.
The other three values exist here now so the same enum is ready when a
future texture/SFX generator (Stable Audio Open, T-0081) reuses this
package's pattern for the other buses.
"""

from __future__ import annotations

from enum import Enum


class Bus(str, Enum):
    AMBIENCE = "Ambience"
    MUSIC = "Music"
    WORLD_SFX = "World SFX"
    GAMEPLAY_SFX = "Gameplay SFX"
