"""Per-bus integrated-loudness targets for one-shot rendering.

Mirrors `tools/asset-gate/config/loudness_targets.placeholder.json`'s
`world_sfx`/`gameplay_sfx` entries. **TODO(AU-2)**: real per-bus-class
LUFS targets aren't decided (`13-asset-pipeline.md` §5) -- these are the
same conservative placeholders the gate uses, duplicated here (rather
than imported across packages, since `sfx-synth` and `asset-gate` are
independent tool packages) so rendering targets what the gate will
actually check. Keep the two files in sync until AU-2 resolves them both
at once.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BusTarget:
    target_lufs: float
    tolerance_db: float


BUS_LOUDNESS_TARGETS: dict[str, BusTarget] = {
    "world_sfx": BusTarget(target_lufs=-18.0, tolerance_db=3.0),
    "gameplay_sfx": BusTarget(target_lufs=-16.0, tolerance_db=3.0),
}
