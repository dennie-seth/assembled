"""T-0422: closes the retry-loop-vs-hardware-safety gap the T-0419 incident
exposed. A retry loop submitted ComfyUI work with the cooler off; per-job
interruption (`POST /interrupt`, `POST /queue {"clear": true}`, `POST /free`)
worked every time and the loop simply resubmitted -- by the time the board
run itself was cancelled, ComfyUI's history showed 39 jobs had run and the
GPU had climbed from 81 to 87C. Nothing in this repo could see the cooler or
the GPU temperature at all: a grep for `temperature.gpu|nvidia-smi|thermal|
cooler` across `tools/` and `assets/src/` returned zero files before this
card.

This module is a second, independent gate sitting beside T-0418's
`checkpoint_gate.assert_graph_checkpoints_allowed` at the one choke point
every ComfyUI submission passes through --
`comfy_client.comfyui_client.ComfyUIClient.submit()`, before the POST
/prompt call. That is what covers the hand-built-graph submitters
(`assets/src/character/gen_master_sheet_part_cutouts_T0417.py`,
`gen_master_sheet_cutout_compare_T0337.py`) that bypass
`comfy_client.pipeline.generate()` entirely -- the same property T-0418's
gate relies on, and the reason a per-caller convention was rejected there
too.

Two independent conditions must both hold for a submission to proceed:

1. The human-owned cooler-state flag (`tools/board/ops/cooler-state.json` by
   default) must say the cooler is explicitly "ON". Anything else -- an
   explicit "OFF", a missing file, malformed JSON, a missing/wrong-typed
   field -- refuses. The file is committed to the repo, so "missing" means
   something is wrong (a broken checkout, an accidental deletion), not that
   the cooler is presumed on.
2. `nvidia-smi`'s own temperature.gpu reading, for the hottest reporting
   device, must be strictly under `TEMPERATURE_CEILING_C`. ComfyUI's own
   `GET /system_stats` cannot answer this -- it exposes only
   name/type/vram_total/vram_free for its devices, no temperature key
   (verified live against a running ComfyUI 0.29.0) -- so this shells out to
   `nvidia-smi` directly. Any failure to get a trustworthy reading (the
   binary can't be found, it exits non-zero, its output doesn't parse, or it
   hangs past a timeout) refuses rather than assumes safety.

No bypass, override, or "force" parameter exists anywhere in this module by
design (see the card's "Do not" list) -- the whole point is that nothing can
retry past this the way T-0419's loop retried past per-job interruption.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

#: T-0419 ran at 81-87C; this host's idle baseline (checkpoint loaded, no
#: generation in flight) is 56-64C. The ceiling sits well above idle
#: (11-19C of headroom for ordinary operation) but comfortably below the
#: incident's own operating floor of 81C, so this gate would have refused at
#: job 1 of that run, not let it reach job 39. Inclusive: a reading exactly
#: at the ceiling refuses, it does not need to exceed it.
TEMPERATURE_CEILING_C = 75.0

#: A slow/hanging nvidia-smi must not wedge every submission indefinitely --
#: a timeout refuses (see module docstring point 2), it never waits forever.
NVIDIA_SMI_TIMEOUT_S = 5.0

#: tools/board/ops/cooler-state.json, resolved relative to this file so it
#: works regardless of the caller's CWD -- mirrors
#: gen_client_base.license_allowlist.DEFAULT_ALLOWLIST_PATH's own approach.
_REPO_TOOLS_DIR = Path(__file__).resolve().parents[3]
DEFAULT_COOLER_STATE_PATH = _REPO_TOOLS_DIR / "board" / "ops" / "cooler-state.json"

#: WSL's view of the Windows host's nvidia-smi -- this is where the asset
#: venvs actually run (docs/comfyui-setup.md). Only consulted when
#: `shutil.which("nvidia-smi")` finds nothing on PATH, so a native Linux or
#: plain-Windows environment with nvidia-smi on PATH never touches this.
DEFAULT_WSL_NVIDIA_SMI_PATH = Path("/mnt/c/Windows/System32/nvidia-smi.exe")


class ThermalGateRefused(RuntimeError):
    """The thermal/cooler gate refused a submission.

    Deliberately not a `SubmitError` (`comfy_client.errors`) or any other
    HTTP/transport failure type: those describe a request ComfyUI itself
    rejected or a connection that failed, both of which a caller might
    reasonably retry. This describes a prerequisite that was never checked
    against ComfyUI at all -- retrying gains nothing until a human turns the
    cooler back on or the GPU cools down, so this is its own type a retry
    loop (or a reader) cannot mistake for something transient.
    """


def _cooler_is_on(path: Path) -> bool:
    """True only if `path` is valid JSON containing exactly `"cooler": "ON"`.

    Every other outcome -- unreadable file (including missing), malformed
    JSON, a non-object top level, a missing `cooler` key, or any value other
    than the literal string `"ON"`/`"OFF"` (including the JSON/Python bool
    `true`, which would otherwise be silently truthy) -- raises rather than
    guessing. `"OFF"` returns False cleanly; everything else that isn't a
    clean `"ON"` raises `ThermalGateRefused` directly, so no ambiguous state
    is ever read as safe.
    """
    try:
        raw = path.read_text()
    except OSError as exc:
        raise ThermalGateRefused(
            f"cooler-state file unreadable at {path} ({exc}) -- refusing rather than "
            "assuming the cooler is on"
        ) from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ThermalGateRefused(f"cooler-state file at {path} is not valid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ThermalGateRefused(
            f"cooler-state file at {path} must contain a JSON object, got {type(data).__name__}"
        )

    cooler = data.get("cooler")
    if cooler == "ON":
        return True
    if cooler == "OFF":
        return False
    raise ThermalGateRefused(
        f"cooler-state file at {path} has cooler={cooler!r} -- expected the exact string "
        "'ON' or 'OFF', refusing rather than guessing"
    )


def _resolve_nvidia_smi_command(
    which: Callable[[str], str | None] = shutil.which,
    wsl_path: Path = DEFAULT_WSL_NVIDIA_SMI_PATH,
) -> str:
    """Cross-environment resolution: prefer PATH (native Linux, or Windows
    with nvidia-smi on PATH), fall back to the fixed WSL-sees-Windows-host
    path this repo's asset venvs actually run under. Refuses if neither
    resolves -- a hard-coded path that only works in one environment would
    be a silent fail-open in the other.
    """
    on_path = which("nvidia-smi")
    if on_path:
        return on_path
    if wsl_path.exists():
        return str(wsl_path)
    raise ThermalGateRefused(
        f"nvidia-smi not found on PATH and not found at {wsl_path} -- cannot confirm GPU "
        "temperature is safe, refusing"
    )


def _shell_nvidia_smi_temperature_c(
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    resolve_command: Callable[[], str] = _resolve_nvidia_smi_command,
    timeout: float = NVIDIA_SMI_TIMEOUT_S,
) -> float:
    """Runs `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits`
    and returns the hottest reporting device's temperature in Celsius.

    Multi-GPU/multi-line policy: the hottest device decides. One overheating
    GPU is reason enough to refuse, regardless of how many other devices on
    the same host are cool -- parsing "the first line" by luck would miss
    exactly that case.

    Refuses (raises `ThermalGateRefused`) rather than returning a guessed
    value on every failure mode: the binary can't be resolved, it can't be
    launched, it times out, it exits non-zero, or its output doesn't parse
    as one-float-per-line. We cannot confirm the reading is safe, so we do
    not proceed.
    """
    command = resolve_command()

    try:
        result = run(
            [command, "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ThermalGateRefused(f"nvidia-smi failed to run ({command}): {exc}") from exc

    if result.returncode != 0:
        stderr = (result.stderr or "").strip() or "(no stderr)"
        raise ThermalGateRefused(f"nvidia-smi exited {result.returncode}: {stderr}")

    readings: list[float] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            readings.append(float(line))
        except ValueError as exc:
            raise ThermalGateRefused(
                f"nvidia-smi produced unparseable temperature output: {line!r}"
            ) from exc

    if not readings:
        raise ThermalGateRefused(f"nvidia-smi produced no temperature readings: {result.stdout!r}")

    return max(readings)


def assert_thermal_gate_open(
    cooler_state_path: str | Path | None = None,
    temperature_reader: Callable[[], float] | None = None,
) -> None:
    """Raise `ThermalGateRefused` unless the cooler is ON and the GPU
    temperature is under `TEMPERATURE_CEILING_C`.

    Injectable the same way `gen_client_base.license_allowlist.
    assert_checkpoint_allowed` takes `allowlist=None`: pass an explicit
    `cooler_state_path`/`temperature_reader` in tests to avoid touching a
    real file or shelling out to real hardware; production code (via
    `ComfyUIClient.submit()`) leaves both `None` and gets the real committed
    flag file plus a real `nvidia-smi` reading.

    Checks the cooler flag first -- an explicit OFF refuses before
    `temperature_reader` is even called, so a reader that would raise or
    hang can never turn an OFF into an accidental allow.
    """
    path = Path(cooler_state_path) if cooler_state_path is not None else DEFAULT_COOLER_STATE_PATH
    if not _cooler_is_on(path):
        raise ThermalGateRefused(
            f"cooler is OFF per {path} -- refusing to submit to ComfyUI until it is back ON"
        )

    reader = temperature_reader or _shell_nvidia_smi_temperature_c
    temperature_c = reader()
    if temperature_c >= TEMPERATURE_CEILING_C:
        raise ThermalGateRefused(
            f"GPU temperature {temperature_c}C is at or above the {TEMPERATURE_CEILING_C}C "
            "ceiling -- refusing to submit to ComfyUI"
        )
