"""Generate the four collapse-layer stage Ogg files (T-0203).

13-asset-pipeline.md §4.4: global collapse layer, 4 stages.
Reuses the same T-0083 descent chain as the archetype ambience beds:
    synthesize -> DC offset removal -> loop-fold -> loudness normalize -> Ogg

Entry point: `main()` — generates all four stages under assets/final/audio/.

Usage:
    python -m ambience_synth.collapse_pipeline [out_dir]

Default out_dir: <worktree-root>/assets/final/audio/
"""

from __future__ import annotations

import pathlib
import sys

from ambience_synth.collapse_crossfade import COLLAPSE_STAGES
from ambience_synth.pipeline import render_to_ogg


def render_all_stages(out_dir: str | pathlib.Path) -> list[pathlib.Path]:
    """Render all four collapse stages to Ogg files under out_dir.

    Returns the list of written paths (one per stage).
    """
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[pathlib.Path] = []
    for i, recipe in enumerate(COLLAPSE_STAGES):
        out_path = out_dir / f"{recipe.name}.ogg"
        print(f"Rendering collapse stage {i} ({recipe.name}) -> {out_path}", flush=True)
        render_to_ogg(recipe, out_path)
        print(f"  Done. {out_path} written.", flush=True)
        written.append(out_path)
    return written


def main() -> None:
    """CLI entry point: generate all four collapse stage Ogg files."""
    if len(sys.argv) > 1:
        out_dir = pathlib.Path(sys.argv[1])
    else:
        # Default: resolve relative to CWD.
        # Expected invocation:
        #   cd assets/src/ambience_synth && python -m ambience_synth.collapse_pipeline
        # CWD = assets/src/ambience_synth → parents[1] = assets/
        cwd = pathlib.Path.cwd()
        out_dir = cwd.parents[1] / "final" / "audio"

    render_all_stages(out_dir)
    print("All collapse stages written.", flush=True)


if __name__ == "__main__":
    main()
