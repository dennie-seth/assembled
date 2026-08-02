#!/usr/bin/env python3
"""Manual, NOT-CI live smoke test against a real Stable Audio Open instance.

This is never invoked by pytest or CI -- every test in tools/audio-agent
mocks its HTTP layer. Run this by hand, once, mirroring
`scripts/live_smoke.py` (ACE-Step):

1. `F:\\StableAudioOpen\\infer-api.py` is running on the Windows host
   (docs/stable-audio-setup.md).
2. The ONE user action documented there is done: a Windows Firewall
   allow-rule for the chosen port (8002 by default) from the WSL subnet.
   This script does not check for or apply that rule -- it will simply
   fail to connect until it exists.

Usage (from tools/audio-agent, with the venv set up per README.md):

    .venv/bin/python scripts/live_smoke_texture.py

Override resolution if needed:

    STABLE_AUDIO_BASE_URL=http://172.18.192.1:8002 .venv/bin/python scripts/live_smoke_texture.py
"""

from __future__ import annotations

from audio_agent.pipeline import generate_texture
from audio_agent.stable_audio_base_url import resolve_base_url
from audio_agent.texture_recipe import TextureRecipe


def main() -> int:
    base_url = resolve_base_url()
    print(f"resolved Stable Audio Open base URL: {base_url}")

    recipe = TextureRecipe(
        prompt="low mechanical drone, distant ventilation hum, concrete room tone, "
        "abandoned brutalist bunker ambience, subtle metallic resonance",
        seed=42,
        seconds=6.0,
        name="live_smoke_texture",
    )

    print(f"submitting recipe (seed={recipe.seed}, seconds={recipe.seconds}) ...")
    result = generate_texture(recipe, out_dir="assets/out/audio", timeout=120.0)

    print(f"done: {result.path}")
    print(f"job_id: {result.job_id}")
    print(f"provenance: {result.provenance}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
