"""End-to-end T-0083 ambience pipeline: synthesize → loop-fold → normalize → Ogg.

13-asset-pipeline.md §4.7 descent chain for looping content:
    synthesize (deterministic script)
      -> remove DC offset
      -> loop-fold (deterministic crossfade at the seam)
      -> loudness normalize (EBU R128)
      -> encode (Ogg Vorbis, with explicit LOOP_START Vorbis comment)

Entry point: `render_to_ogg(recipe, out_path)` — produces the committed
artifact; `main()` is the CLI for the CI/generation step.
"""

from __future__ import annotations

import pathlib
import sys

import numpy as np

from ambience_synth.loop_fold import loop_fold
from ambience_synth.normalize import loudness_normalize
from ambience_synth.ogg import write_ogg
from ambience_synth.recipe import AmbienceRecipe
from ambience_synth.synth import synthesize

# Ambience bus loudness target — placeholder pending AU-2.
# Matches tools/asset-gate/config/loudness_targets.placeholder.json "ambience" entry.
_AMBIENCE_TARGET_LUFS = -23.0


def render_to_ogg(recipe: AmbienceRecipe, out_path: str | pathlib.Path) -> None:
    """Run the full T-0083 pipeline for `recipe` and write the Ogg to out_path.

    Steps:
    1. Synthesize raw audio (body_s + crossfade_s seconds)
    2. Remove DC offset
    3. Loop-fold crossfade (makes loop seam seamless)
    4. Loudness normalize to ambience bus target (-23 LUFS)
    5. Encode to Ogg Vorbis with LOOP_START/LOOP_END Vorbis comments
    """
    # 1. Synthesize
    raw = synthesize(recipe)

    # 2. DC offset removal
    raw = raw - np.mean(raw)

    # 3. Loop-fold
    folded = loop_fold(raw, recipe.sample_rate, recipe.crossfade_s)

    # 4. Loudness normalize
    normalized = loudness_normalize(folded, recipe.sample_rate, _AMBIENCE_TARGET_LUFS)

    # 5. Encode to Ogg with loop metadata
    loop_end = len(normalized) - 1
    write_ogg(
        out_path, normalized, recipe.sample_rate,
        loop_start_sample=0, loop_end_sample=loop_end,
    )


def main() -> None:
    """CLI entry point: generate the Signal Tower ambience bed.

    Usage:
        python -m ambience_synth.pipeline [out_path]

    Default out_path: <worktree-root>/assets/final/audio/signal_tower_ambience.ogg
    """
    from ambience_synth.signal_tower import SIGNAL_TOWER_AMBIENCE

    if len(sys.argv) > 1:
        out_path = pathlib.Path(sys.argv[1])
    else:
        # Default: resolve relative to CWD. Expected invocation:
        #   cd assets/src/ambience_synth && python -m ambience_synth.pipeline
        # CWD = assets/src/ambience_synth → parents[1] = assets/
        cwd = pathlib.Path.cwd()
        out_path = cwd.parents[1] / "final" / "audio" / "signal_tower_ambience.ogg"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Rendering {SIGNAL_TOWER_AMBIENCE.name} → {out_path}", flush=True)
    render_to_ogg(SIGNAL_TOWER_AMBIENCE, out_path)
    print(f"Done. {out_path} written.", flush=True)


if __name__ == "__main__":
    main()
