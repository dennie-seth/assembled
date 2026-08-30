"""Rendered-visibility validation checks.

PR #231 (T-0215) shipped 5 prop PNGs with alpha=0 on every pixel -- they
rendered as blank/transparent everywhere (GitHub, browser, Godot) even
though the RGB data underneath was real SDXL art. The existing gate only
validated `model_hash` provenance (`provenance.py`), never whether an
image actually renders as visible content, so CI passed the PR.

`check_rendered_visibility` closes that gap: it rejects any image that is
either fully transparent (alpha=0 on every pixel) or effectively
blank/uniform (too few distinct colors among its opaque pixels).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from asset_gate.result import CheckResult

_DEFAULT_MIN_VISIBLE_COLORS = 3


def check_rendered_visibility(
    image: Image.Image, min_visible_colors: int = _DEFAULT_MIN_VISIBLE_COLORS
) -> CheckResult:
    """Fail if *image* is fully transparent or reads as blank/uniform.

    Two failure modes:

    1. Fully transparent: alpha is 0 on every pixel. Any RGB data
       underneath is invisible -- this is exactly the T-0215 bug.
    2. Blank/uniform: fewer than *min_visible_colors* visually distinct
       states appear -- a solid fill or placeholder canvas rather than
       real art. A state is either a distinct RGB value among the opaque
       (alpha > 0) pixels, or "transparent" if any pixel is fully
       transparent.

       Counting transparency as a state keeps the verdict invariant to how
       a sprite encodes its background (P-6). Before that, a two-tone
       figure on an opaque index-0 background counted three colours and
       passed; re-saving the very same indices with a tRNS chunk dropped it
       to two and failed it. Nothing about the art had changed. Transparent
       pixels are still excluded from the *colour* count, so a sprite is
       never credited for the size of its background -- only for having one.
    """
    arr = np.array(image.convert("RGBA"))
    alpha = arr[:, :, 3]

    if int(alpha.max()) == 0:
        return CheckResult(
            check="rendered_visibility",
            passed=False,
            reason="image is fully transparent -- alpha is 0 on every pixel, nothing renders",
            details={"alpha_max": 0},
        )

    rgb = arr[:, :, :3]
    visible = rgb[alpha > 0]
    unique_colors = np.unique(visible.reshape(-1, 3), axis=0)
    n_unique = len(unique_colors)

    has_transparency = bool((alpha == 0).any())
    n_states = n_unique + (1 if has_transparency else 0)

    if n_states < min_visible_colors:
        return CheckResult(
            check="rendered_visibility",
            passed=False,
            reason=(
                f"only {n_states} distinct visible state(s) -- {n_unique} color(s) among "
                f"opaque pixels"
                + (" plus a transparent background" if has_transparency else "")
                + f" (need >= {min_visible_colors}) -- image reads as blank/uniform"
            ),
            details={
                "unique_visible_colors": n_unique,
                "has_transparency": has_transparency,
                "visible_states": n_states,
            },
        )

    return CheckResult(
        check="rendered_visibility",
        passed=True,
        reason=(
            f"{n_unique} distinct color(s) among opaque pixels"
            + (" plus a transparent background" if has_transparency else "")
            + " -- renders as visible content"
        ),
        details={
            "unique_visible_colors": n_unique,
            "has_transparency": has_transparency,
            "visible_states": n_states,
        },
    )


def sweep_rendered_visibility(
    root: Path | str, min_visible_colors: int = _DEFAULT_MIN_VISIBLE_COLORS
) -> list[CheckResult]:
    """Run `check_rendered_visibility` against every ``*.png`` under *root*,
    recursively. Mirrors `provenance.sweep_provenance_model_hash`'s shape so
    CI can gate on it the same way."""
    results = []
    for path in sorted(Path(root).rglob("*.png")):
        image = Image.open(path)
        single = check_rendered_visibility(image, min_visible_colors=min_visible_colors)
        rel = path.relative_to(root) if path.is_relative_to(root) else path
        rel_str = str(rel).replace("\\", "/")
        results.append(
            CheckResult(
                check="rendered_visibility",
                passed=single.passed,
                reason=f"{rel}: {single.reason}",
                details={**single.details, "path": rel_str},
            )
        )
    return results
