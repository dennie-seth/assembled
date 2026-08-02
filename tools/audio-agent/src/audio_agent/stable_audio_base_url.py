"""Resolve the Stable Audio Open wrapper's base URL from WSL -> Windows host.

Identical resolution strategy to `audio_agent.base_url` (ACE-Step, T-0082)
and `comfy_client.base_url` (T-0071): the WSL NAT gateway IP is **not**
hardcoded here -- it changes across WSL restarts (docs/comfyui-setup.md,
feedback_wsl_windows_service_reachability). Kept as a separate module
rather than sharing `base_url.py` since the env var names and default port
differ per backend (same reasoning `base_url.py`'s own docstring gives for
not sharing with `comfy_client.base_url`).

Resolution order:

1. ``STABLE_AUDIO_BASE_URL`` env var, verbatim (trailing slash stripped).
2. The Windows host IP, read fresh from the current default route
   (``ip route show default``), combined with ``STABLE_AUDIO_PORT``
   (default 8002 -- see docs/stable-audio-setup.md: ComfyUI is 8188,
   ACE-Step's infer-api is 8001, this is the next free port in that
   sequence).
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable, Mapping

DEFAULT_PORT = 8002


class GatewayNotFoundError(RuntimeError):
    """No default route was found to derive the Windows host IP from."""


def default_gateway_ip(
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> str:
    """Return the gateway IP of the current default route (`ip route`'s `via` field)."""
    result = run(
        ["ip", "route", "show", "default"], capture_output=True, text=True, check=True
    )
    for line in result.stdout.splitlines():
        parts = line.split()
        if parts[:1] == ["default"] and "via" in parts:
            return parts[parts.index("via") + 1]
    raise GatewayNotFoundError(
        f"no default route in `ip route show default` output: {result.stdout!r}"
    )


def resolve_base_url(
    env: Mapping[str, str] | None = None,
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> str:
    """Resolve the Stable Audio Open base URL per the module docstring's precedence."""
    env = os.environ if env is None else env
    override = env.get("STABLE_AUDIO_BASE_URL")
    if override:
        return override.rstrip("/")
    host = default_gateway_ip(run=run)
    port = env.get("STABLE_AUDIO_PORT", str(DEFAULT_PORT))
    return f"http://{host}:{port}"
