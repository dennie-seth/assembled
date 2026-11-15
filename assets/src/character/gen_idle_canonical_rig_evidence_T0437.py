#!/usr/bin/env python3
"""T-0437 evidence: the standing idle, re-derived on the canonical rig (T-0436),
rendered as a sprite sheet.

The breathing motion is unchanged from the @DennieSeth-approved T-0430 loop -- this
renders through the SAME `char_gen.idle_cycle.render_frames` the gate/test suite
exercises, now wired to the canonical rig's two-point shoulder/pelvis attach and the
3/4 lateral-offset axis (see `idle_cycle`'s own module docstring). This does not
touch, and is not a replacement for, the already-approved `docs/assets/evidence/
T-0430` files -- a fresh, separate record for this card.

Writes:
    docs/assets/evidence/T-0437/idle_canonical_rig.png

No test file: a one-off evidence-generation script, like
`gen_draw_order_audit_T0436.py` -- the logic it calls (`char_gen.idle_cycle`) carries
the actual test coverage (`tests/test_idle_canonical_rig.py`,
`tests/test_idle_cycle.py`).
"""
from __future__ import annotations

from pathlib import Path

from char_gen import idle_cycle, rig_compositor

OUT_DIR = Path(__file__).resolve().parents[3] / "docs" / "assets" / "evidence" / "T-0437"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    result = idle_cycle.render_frames(frame_count=12)
    sheet_path = rig_compositor.save_sheet(
        result.descended_frames, OUT_DIR / "idle_canonical_rig.png"
    )

    print("frames:", len(result.descended_frames))
    print("cell_px:", result.cell_px, "character_scale:", result.character_scale)
    print(
        "native_figure_height:", result.native_figure_height,
        "-> final:", result.native_figure_height * result.character_scale,
    )
    print("hip_px:", result.hip_px)
    print("ankle_r_px:", result.ankle_r_px, "ankle_l_px:", result.ankle_l_px)
    print("wrote", sheet_path, Path(sheet_path).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
