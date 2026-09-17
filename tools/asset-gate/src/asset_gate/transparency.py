"""Sprite background-transparency validation checks.

The §24-e character sheet (`assets/final/character/player_idle_sheet_hybrid_T0252.png`)
shipped as a mode-'P' PNG whose background was a single palette index (0)
carrying **no tRNS chunk**. The cutout had been applied -- every background
pixel really was index 0 -- but the file itself declared no transparency, so
Godot decoded it to `FORMAT_RGB8` and the sprite rendered as an opaque black
rectangle.

`visibility.check_rendered_visibility` cannot catch that. It was built for
the opposite failure (PR #231 / T-0215: props with alpha=0 on *every* pixel)
and an opaque sheet passes it happily. This module is its complement, and the
two together bracket the valid range: a sprite must have some transparent
pixels *and* some opaque ones.

**The format.** Sprites stay PIL mode 'P' and gain a tRNS chunk marking the
background index fully transparent. That keeps the 16-slot indexed palette
the descent chain and the P-4 index-semantics gate require, and Godot's PNG
decoder expands tRNS into a real alpha channel on load (verified on the
engine build `client/project.godot` targets, 4.7.1: with tRNS the image
loads as `FORMAT_RGBA8` with alpha 0.0 on the background; without it as
`FORMAT_RGB8`). True RGBA sprites are accepted too -- they carry real alpha
already -- so the check is about *transparency*, not about a single encoding.

**Scope.** Not every committed PNG is a sprite: tiles, the palette LUT strip
and audio-adjacent artwork are opaque by design. `sweep_sprite_transparency`
classifies by the top-level asset class under `assets/final/` and is
fail-closed -- a class it does not recognise is treated as a sprite class.
Individual documented exceptions live in `transparency_baseline.txt`, the
same idiom `provenance_baseline.txt` and `generator_baseline.txt` use.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from asset_gate.result import CheckResult

_BASELINE_FILENAME = "transparency_baseline.txt"

#: Asset classes (top-level directories under `assets/final/`) whose PNGs are
#: opaque by design. Tiles are base fields -- a transparent tile is a hole in
#: the floor; the palette LUT is a data strip, not art.
OPAQUE_ALLOWED_CLASSES = frozenset({"tiles", "palette", "audio", "lora"})

#: PIL modes that can represent per-pixel alpha directly.
_ALPHA_MODES = frozenset({"RGBA", "LA", "PA", "La"})


def _transparent_index(image: Image.Image) -> int | None:
    """The palette index a mode-'P' image declares fully transparent, if any.

    Pillow surfaces the tRNS chunk in two shapes: a bare ``int`` (a single
    fully-transparent index) or a ``bytes`` alpha table indexed by palette
    slot. Both are legal PNG; normalise them to one index.
    """
    raw = image.info.get("transparency")
    if raw is None:
        return None
    if isinstance(raw, int):
        return raw
    zeros = [i for i, alpha in enumerate(raw) if alpha == 0]
    return zeros[0] if zeros else None


def check_background_transparency(image: Image.Image) -> CheckResult:
    """Fail if *image*'s background is opaque.

    Three shapes pass:

    * mode 'P' with a tRNS chunk whose transparent index is actually used by
      at least one pixel, and at least one pixel outside it (a cutout);
    * a true-alpha mode (RGBA/LA/...) with at least one fully transparent
      pixel and at least one non-transparent one;
    * nothing else -- a plain RGB sprite has nowhere to put alpha.

    A tRNS chunk pointing at an unused slot is decorative, not a cutout, and
    fails. An image that is transparent everywhere fails too: that is PR
    #231's bug, caught here as well as by `check_rendered_visibility`, so a
    writer cannot satisfy this gate by erasing the sprite.
    """
    mode = image.mode

    if mode == "P":
        index = _transparent_index(image)
        if index is None:
            return CheckResult(
                check="background_transparency",
                passed=False,
                reason=(
                    "indexed (mode 'P') image carries no tRNS chunk -- the background "
                    "is opaque and the sprite renders as a solid rectangle"
                ),
                details={"mode": mode, "transparent_index": None},
            )
        histogram = image.histogram()
        transparent_px = histogram[index] if index < len(histogram) else 0
        total_px = image.width * image.height
        if transparent_px == 0:
            return CheckResult(
                check="background_transparency",
                passed=False,
                reason=(
                    f"tRNS marks index {index} transparent but that index is never used "
                    "-- the chunk is decorative, no pixel is actually cut out"
                ),
                details={"mode": mode, "transparent_index": index, "transparent_px": 0},
            )
        if transparent_px == total_px:
            return CheckResult(
                check="background_transparency",
                passed=False,
                reason=(
                    f"every pixel uses the transparent index {index} -- no opaque "
                    "content remains, nothing renders"
                ),
                details={"mode": mode, "transparent_index": index, "opaque_px": 0},
            )
        return CheckResult(
            check="background_transparency",
            passed=True,
            reason=(
                f"indexed sprite with tRNS on index {index}: "
                f"{transparent_px}/{total_px} px transparent"
            ),
            details={
                "mode": mode,
                "transparent_index": index,
                "transparent_px": int(transparent_px),
                "opaque_px": int(total_px - transparent_px),
            },
        )

    if mode in _ALPHA_MODES:
        alpha = np.array(image.convert("RGBA"))[:, :, 3]
        transparent_px = int((alpha == 0).sum())
        if transparent_px == 0:
            return CheckResult(
                check="background_transparency",
                passed=False,
                reason=(
                    f"{mode} image has alpha > 0 on every pixel -- the background is "
                    "opaque (a solid-mask alpha channel is not a cutout)"
                ),
                details={"mode": mode, "alpha_min": int(alpha.min())},
            )
        if transparent_px == alpha.size:
            return CheckResult(
                check="background_transparency",
                passed=False,
                reason="every pixel is fully transparent -- no opaque content remains",
                details={"mode": mode, "opaque_px": 0},
            )
        return CheckResult(
            check="background_transparency",
            passed=True,
            reason=f"{mode} sprite with real alpha: {transparent_px}/{alpha.size} px transparent",
            details={
                "mode": mode,
                "transparent_px": transparent_px,
                "opaque_px": int(alpha.size - transparent_px),
            },
        )

    return CheckResult(
        check="background_transparency",
        passed=False,
        reason=(
            f"mode {mode!r} cannot represent transparency -- a sprite must be indexed "
            "('P' + tRNS) or a true-alpha mode"
        ),
        details={"mode": mode},
    )


def _default_baseline_path() -> Path:
    return Path(__file__).parent / _BASELINE_FILENAME


def load_transparency_baseline(path: Path | str | None = None) -> frozenset[str]:
    """Load the documented opaque-sprite exemptions.

    Every entry is a path relative to `assets/final/`, using forward slashes.
    These are assets that genuinely cannot be fixed by a save-format change --
    they were never cut out at all and need regeneration through the cutout
    path, which is a separate card. Anything not listed still fails the gate.
    """
    baseline_path = Path(path) if path is not None else _default_baseline_path()
    if not baseline_path.is_file():
        return frozenset()
    entries = set()
    for line in baseline_path.read_text().splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            entries.add(stripped)
    return frozenset(entries)


def asset_class(relative_path: Path | str) -> str:
    """The top-level asset class of a path relative to `assets/final/`."""
    parts = Path(relative_path).parts
    return parts[0] if len(parts) > 1 else ""


def sweep_sprite_transparency(
    root: Path | str, baseline: frozenset[str] = frozenset()
) -> list[CheckResult]:
    """Run `check_background_transparency` against every sprite `*.png` under
    *root*, recursively. Mirrors the other sweeps' shape so CI gates on it the
    same way.

    Classes in `OPAQUE_ALLOWED_CLASSES` are reported as passing without being
    checked -- they are opaque by design. Everything else is required to be
    transparent, including classes this module has never heard of.
    """
    root_path = Path(root)
    results = []
    for path in sorted(root_path.rglob("*.png")):
        rel = path.relative_to(root_path)
        rel_str = rel.as_posix()
        cls = asset_class(rel)

        if cls in OPAQUE_ALLOWED_CLASSES:
            results.append(
                CheckResult(
                    check="background_transparency",
                    passed=True,
                    reason=f"{rel_str}: asset class {cls!r} is opaque by design -- not a sprite",
                    details={"path": rel_str, "asset_class": cls, "skipped": True},
                )
            )
            continue

        if rel_str in baseline:
            results.append(
                CheckResult(
                    check="background_transparency",
                    passed=True,
                    reason=f"{rel_str}: documented pre-existing opaque asset (baseline)",
                    details={"path": rel_str, "asset_class": cls, "baseline": True},
                )
            )
            continue

        single = check_background_transparency(Image.open(path))
        results.append(
            CheckResult(
                check="background_transparency",
                passed=single.passed,
                reason=f"{rel_str}: {single.reason}",
                details={**single.details, "path": rel_str, "asset_class": cls},
            )
        )
    return results
