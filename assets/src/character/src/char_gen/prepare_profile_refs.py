"""Letterbox arbitrary-aspect-ratio source photos to a square training image.

T-0273's committed profile reference set is real photographs/illustrations
of varying aspect ratio -- unlike T-0248/T-0229's already-square
IP-Adapter-generated identity views. sd-scripts' default (non-bucketed)
dataset path (assets/src/lora/src/lora_train/train.py::build_dataset_toml)
requires square input, so this module provides the one preprocessing step
needed before these can become a training set: scale to fit, pad to square,
never crop or stretch (a crop would cut real gait/pose content off a
photographic plate; a stretch would distort the very pose this LoRA exists
to teach).
"""

from __future__ import annotations

from PIL import Image

_DEFAULT_BACKGROUND_RGB = (128, 128, 128)


def letterbox_to_square(
    image: Image.Image,
    size: int = 1024,
    background_rgb: tuple[int, int, int] = _DEFAULT_BACKGROUND_RGB,
) -> Image.Image:
    """Scale `image` to fit within `size`x`size` preserving aspect ratio,
    then centre it on a `background_rgb`-filled square canvas."""
    image = image.convert("RGB")
    width, height = image.size
    scale = size / max(width, height)
    new_width = max(1, round(width * scale))
    new_height = max(1, round(height * scale))
    resized = image.resize((new_width, new_height), Image.LANCZOS)

    canvas = Image.new("RGB", (size, size), background_rgb)
    offset = ((size - new_width) // 2, (size - new_height) // 2)
    canvas.paste(resized, offset)
    return canvas
