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

1. The human-owned cooler-state flag must say the cooler is explicitly "ON".
   Anything else -- an explicit "OFF", a missing file, malformed JSON, a
   missing/wrong-typed field -- refuses.

   Round-2 fix (T-0422 PR #425 review): round 1 resolved this file relative
   to `__file__`, i.e. relative to *whichever checkout's copy of this module
   happened to run it*. The board runs agents in per-task worktrees
   (`tools/board/src/runner/claudeCliRunner.js`), so every worktree got its
   own committed copy, each independently defaulting to ON -- a human
   editing the file in one checkout could never stop a submission running
   from another. There is now exactly ONE authoritative location, resolved
   the same way regardless of which checkout, cwd, or installed-wheel
   location this module happens to run from:
   `~/.local/share/assembled-board/cooler-state.json`, overridable via the
   `COOLER_STATE_PATH` env var -- the same override pattern
   `tools/board/src/lib/db/connection.js` uses for `BOARD_DB_PATH`/
   `DEFAULT_DB_PATH`, rooted out-of-repo for the identical reason
   `httpApi.js` states for that file: "so `git pull`/checkout on the repo
   can never touch" it. `tools/board/ops/cooler-state.json` (round 1's
   location) no longer exists; there is exactly one file that looks like
   the cooler switch. See `resolve_cooler_state_path()`.

   The file does not ship pre-created outside the repo (it can't -- nothing
   commits there); it must be seeded once per host, deliberately, by a
   human/deploy step, never auto-created ON by this module on first read.
   See docs/comfyui-setup.md#thermal-cooler-gate-t-0422 for that step.
2. `nvidia-smi`'s own temperature.gpu reading, for the hottest reporting
   device, must be a finite number strictly under `TEMPERATURE_CEILING_C`.
   ComfyUI's own `GET /system_stats` cannot answer this -- it exposes only
   name/type/vram_total/vram_free for its devices, no temperature key
   (verified live against a running ComfyUI 0.29.0) -- so this shells out to
   `nvidia-smi` directly. Any failure to get a trustworthy reading (the
   binary can't be found, it exits non-zero, its output doesn't parse, it
   hangs past a timeout, or it parses but is non-finite -- `nan`/`inf`/
   `-inf`) refuses rather than assumes safety.

   Round-2 fix: `float()` happily parses `"nan"`/`"-inf"`/`"inf"` without
   raising, and `nan >= TEMPERATURE_CEILING_C` is `False`, so an unvalidated
   NaN reading used to allow silently. Worse, a NaN anywhere in a multi-line
   `nvidia-smi` response could make Python's own `max()` return the NaN
   itself and lose a genuinely hot reading behind it (NaN comparisons are
   always `False`, so `max([nan, 87.0])` returns `nan`, not `87.0`). Every
   parsed device line is now validated with `math.isfinite` immediately, one
   line at a time, before it ever reaches `max()` -- so a non-finite line
   refuses on the spot, in the order it was read, regardless of what
   surrounds it. The temperature this function is ultimately handed --
   whether from `_shell_nvidia_smi_temperature_c` or an injected
   `temperature_reader` -- is validated again in `assert_thermal_gate_open`
   before the ceiling comparison, so a non-finite reading is always reported
   as non-finite, never as "conveniently over the ceiling by accident".

No bypass, override, or "force" parameter exists anywhere in this module by
design (see the card's "Do not" list) -- the whole point is that nothing can
retry past this the way T-0419's loop retried past per-job interruption.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from collections.abc import Callable, Mapping
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

#: The ONE authoritative cooler-state location, shared by every checkout,
#: worktree, and installed-wheel invocation on this host -- deliberately
#: NOT derived from `__file__`/cwd/repo location (that was round 1's bug:
#: see the module docstring). Rooted under the user's home directory the
#: same way `tools/board/src/lib/db/connection.js`'s `DEFAULT_DB_PATH` roots
#: `board.db` out-of-repo, so a `git pull`/checkout/new-worktree can never
#: fork it. Overridable via the `COOLER_STATE_PATH` env var -- the same
#: override pattern as that file's `BOARD_DB_PATH`.
DEFAULT_COOLER_STATE_PATH = (
    Path.home() / ".local" / "share" / "assembled-board" / "cooler-state.json"
)

#: Env var name for the `COOLER_STATE_PATH` override above -- named here so
#: `resolve_cooler_state_path`'s docstring and callers can point at one
#: source of truth for the literal string.
COOLER_STATE_PATH_ENV_VAR = "COOLER_STATE_PATH"


def resolve_cooler_state_path(env: Mapping[str, str] | None = None) -> Path:
    """Resolve the one authoritative cooler-state file: `COOLER_STATE_PATH`
    env var if set (verbatim, e.g. for tests or an unusual host layout),
    else `DEFAULT_COOLER_STATE_PATH`. Never falls back to anything derived
    from this module's own install location -- that is exactly the bug this
    function replaces (see module docstring, finding 1).

    Reads `DEFAULT_COOLER_STATE_PATH` as a module global rather than a
    function-default value, so tests that `monkeypatch.setattr` it (the
    pre-existing convention -- see `conftest.py`'s `_safe_default_thermal_reading`)
    keep working unchanged.
    """
    env = os.environ if env is None else env
    override = env.get(COOLER_STATE_PATH_ENV_VAR)
    if override:
        return Path(override)
    return DEFAULT_COOLER_STATE_PATH


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
    launched, it times out, it exits non-zero, its output doesn't parse as
    one-float-per-line, or a parsed value is non-finite (`nan`/`inf`/
    `-inf` -- `float()` parses all three without raising, so this is
    checked separately with `math.isfinite`). We cannot confirm the reading
    is safe, so we do not proceed.

    Each line is validated with `math.isfinite` the moment it's parsed,
    before it is added to `readings` or compared against anything else --
    so a non-finite line refuses immediately regardless of where it falls
    in a multi-line response, and never reaches `max()`. This matters
    because `max()` on a list already containing a NaN can silently return
    the NaN itself and lose a genuinely hot reading behind it (NaN
    comparisons are always `False`, so `max([nan, 87.0]) == nan`, not
    `87.0`) -- validating per-line, before aggregation, closes that off at
    the source rather than relying on `max()` to notice.
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
            value = float(line)
        except ValueError as exc:
            raise ThermalGateRefused(
                f"nvidia-smi produced unparseable temperature output: {line!r}"
            ) from exc
        if not math.isfinite(value):
            raise ThermalGateRefused(
                f"nvidia-smi produced a non-finite temperature reading ({line!r}) -- cannot "
                "confirm this is a safe temperature, refusing"
            )
        readings.append(value)

    if not readings:
        raise ThermalGateRefused(f"nvidia-smi produced no temperature readings: {result.stdout!r}")

    hottest = max(readings)
    if not math.isfinite(hottest):
        raise ThermalGateRefused(
            f"aggregated GPU temperature reading is non-finite ({hottest!r}) -- refusing"
        )
    return hottest


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
    `ComfyUIClient.submit()`) leaves both `None` and gets the one
    authoritative flag file (`resolve_cooler_state_path()`) plus a real
    `nvidia-smi` reading. Resolution happens fresh on every call -- nothing
    here caches a path or a decision across calls or across client
    construction, so a flag flipped after a `ComfyUIClient` already exists
    still takes effect on that client's very next `submit()`.

    Checks the cooler flag first -- an explicit OFF refuses before
    `temperature_reader` is even called, so a reader that would raise or
    hang can never turn an OFF into an accidental allow.
    """
    path = Path(cooler_state_path) if cooler_state_path is not None else resolve_cooler_state_path()
    if not _cooler_is_on(path):
        raise ThermalGateRefused(
            f"cooler is OFF per {path} -- refusing to submit to ComfyUI until it is back ON"
        )

    reader = temperature_reader or _shell_nvidia_smi_temperature_c
    temperature_c = reader()
    if not math.isfinite(temperature_c):
        raise ThermalGateRefused(
            f"GPU temperature reading is non-finite ({temperature_c!r}) -- cannot confirm this "
            "is a safe temperature, refusing to submit to ComfyUI"
        )
    if temperature_c >= TEMPERATURE_CEILING_C:
        raise ThermalGateRefused(
            f"GPU temperature {temperature_c}C is at or above the {TEMPERATURE_CEILING_C}C "
            "ceiling -- refusing to submit to ComfyUI"
        )
