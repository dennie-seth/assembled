#!/usr/bin/env python3
"""Manual, NOT-CI live smoke test against a real ComfyUI instance.

This is never invoked by pytest or CI -- every test in tools/comfy-client
mocks its HTTP layer. Run this by hand, once the WSL -> Windows firewall
block is lifted (docs/comfyui-setup.md), to do one real generation end to
end against the GPU-backed ComfyUI on the Windows host.

Usage (from tools/comfy-client, with the venv set up per README.md):

    .venv/bin/python scripts/live_smoke.py

Override resolution if needed:

    COMFYUI_BASE_URL=http://172.18.192.1:8188 .venv/bin/python scripts/live_smoke.py
"""

from __future__ import annotations

from comfy_client.base_url import resolve_base_url
from comfy_client.pipeline import generate
from comfy_client.recipe import Recipe


def main() -> int:
    base_url = resolve_base_url()
    print(f"resolved ComfyUI base URL: {base_url}")

    recipe = Recipe(
        prompt="a derelict Soviet brutalist signal tower, overgrown, concrete, muted palette",
        negative_prompt="blurry, low quality, text, watermark",
        seed=12345,
        steps=20,
        cfg=7.0,
        width=1024,
        height=1024,
        name="live_smoke",
    )

    print(f"submitting recipe (seed={recipe.seed}) ...")
    result = generate(recipe, out_dir="assets/out", timeout=300.0)

    print(f"done: {result.path}")
    print(f"prompt_id: {result.prompt_id}")
    print(f"provenance: {result.provenance}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
