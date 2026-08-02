#!/usr/bin/env python3
"""Manual, NOT-CI live smoke test against a real ACE-Step instance.

This is never invoked by pytest or CI -- every test in tools/audio-agent
mocks its HTTP layer. Run this by hand, once:

1. The persistent-pipeline patch is applied and the server is running on
   the Windows host (docs/ace-step-setup.md, "Persistent server").
2. The ONE user action documented there is done: a Windows Firewall
   allow-rule for the chosen port (8001 by default) from the WSL subnet.
   This script does not check for or apply that rule -- it will simply
   fail to connect until it exists.

Usage (from tools/audio-agent, with the venv set up per README.md):

    .venv/bin/python scripts/live_smoke.py

Override resolution if needed:

    ACESTEP_BASE_URL=http://172.18.192.1:8001 .venv/bin/python scripts/live_smoke.py
"""

from __future__ import annotations

from audio_agent.base_url import resolve_base_url
from audio_agent.pipeline import generate
from audio_agent.recipe import MusicRecipe


def main() -> int:
    base_url = resolve_base_url()
    print(f"resolved ACE-Step base URL: {base_url}")

    recipe = MusicRecipe(
        prompt="somber ambient drone, brutalist concrete hallway, collapsing signal",
        seed=12345,
        duration=15.0,
        name="live_smoke",
    )

    print(f"submitting recipe (seed={recipe.seed}, duration={recipe.duration}s) ...")
    result = generate(recipe, out_dir="assets/out/audio", timeout=180.0)

    print(f"done: {result.path}")
    print(f"job_id: {result.job_id}")
    print(f"provenance: {result.provenance}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
