"""Resolve the ComfyUI base URL from WSL -> Windows host.

The WSL NAT gateway IP is **not** hardcoded here -- it changes across WSL
restarts (docs/comfyui-setup.md, feedback_wsl_windows_service_reachability).
Resolution order:

1. ``COMFYUI_BASE_URL`` env var, verbatim (trailing slash stripped). This is
   also how the live path gets enabled once the WSL firewall block is lifted
   -- see ``README.md`` for the manual live-smoke instructions.
2. The Windows host IP, read fresh from the current default route
   (``ip route show default``), combined with ``COMFYUI_PORT``
   (default 8188).
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable, Mapping

DEFAULT_PORT = 8188


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
    """Resolve the ComfyUI base URL per the module docstring's precedence."""
    env = os.environ if env is None else env
    override = env.get("COMFYUI_BASE_URL")
    if override:
        return override.rstrip("/")
    host = default_gateway_ip(run=run)
    port = env.get("COMFYUI_PORT", str(DEFAULT_PORT))
    return f"http://{host}:{port}"
