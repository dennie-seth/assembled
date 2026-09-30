"""T-0422: the thermal/cooler submit gate, from the T-0419 incident (39
ComfyUI jobs ran with the cooler off, GPU 81-87C, before a running board run
had to be cancelled -- per-job interruption could not keep up with a retry
loop that just resubmitted).

Pure unit tests of `assert_thermal_gate_open` and its two building blocks
(`_cooler_is_on`, `_shell_nvidia_smi_temperature_c` + its command resolver),
all injected with stub cooler-state paths / process runners -- no real
nvidia-smi call, no dependency on the real
`~/.local/share/assembled-board/cooler-state.json` (the one authoritative
location as of round 2 -- see `comfy_client.thermal_gate`'s module
docstring). See test_comfyui_client.py for the choke-point regression
proving `ComfyUIClient.submit()` itself is gated, not only this module in
isolation.

RED state (round 1): `comfy_client.thermal_gate` does not exist yet ->
ImportError. RED state (round 2, this file's `test_two_independent_checkouts_*`/
`test_*_non_finite_*` additions): fail against `9434490969d2`, which
resolves the cooler-state path relative to `__file__` and does not validate
`math.isfinite` at all.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
from pathlib import Path

import pytest

from comfy_client import thermal_gate
from comfy_client.thermal_gate import (
    NVIDIA_SMI_TIMEOUT_S,
    TEMPERATURE_CEILING_C,
    ThermalGateRefused,
    _resolve_nvidia_smi_command,
    _shell_nvidia_smi_temperature_c,
    assert_thermal_gate_open,
)


def _write_cooler_state(tmp_path, payload):
    path = tmp_path / "cooler-state.json"
    path.write_text(payload if isinstance(payload, str) else json.dumps(payload))
    return path


def _reader(value):
    return lambda: value


# ---- assert_thermal_gate_open: cooler flag ---------------------------------


def test_allows_when_cooler_on_and_temperature_under_ceiling(tmp_path):
    path = _write_cooler_state(tmp_path, {"cooler": "ON"})
    assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(60.0))  # no raise


def test_refuses_when_cooler_is_off(tmp_path):
    path = _write_cooler_state(tmp_path, {"cooler": "OFF"})
    with pytest.raises(ThermalGateRefused, match="[Cc]ooler.*OFF"):
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(60.0))


def test_never_fails_open_on_explicit_off_even_if_temperature_reader_would_blow_up(tmp_path):
    """An explicit OFF refuses before the temperature reader is even
    consulted -- proves OFF can't be short-circuited into an allow by a
    reader that would otherwise raise or return something unexpected."""
    path = _write_cooler_state(tmp_path, {"cooler": "OFF"})

    def _must_not_be_called():
        raise AssertionError("temperature_reader must not run when the cooler is OFF")

    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_must_not_be_called)


def test_refuses_when_cooler_state_file_is_missing(tmp_path):
    """Committed to the repo, so missing means something is wrong (a broken
    checkout, an accidental deletion) -- refuse rather than guess ON."""
    missing = tmp_path / "does-not-exist.json"
    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(cooler_state_path=missing, temperature_reader=_reader(60.0))


def test_refuses_on_malformed_json(tmp_path):
    path = _write_cooler_state(tmp_path, "{not valid json")
    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(60.0))


def test_refuses_when_file_is_not_a_json_object(tmp_path):
    path = _write_cooler_state(tmp_path, ["ON"])
    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(60.0))


def test_refuses_when_cooler_field_is_missing(tmp_path):
    path = _write_cooler_state(tmp_path, {"decidedBy": "@DennieSeth"})
    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(60.0))


@pytest.mark.parametrize("bad_value", [True, False, 1, 0, None, "on", "off", "", ["ON"]])
def test_refuses_when_cooler_field_has_an_unexpected_type_or_string(tmp_path, bad_value):
    """Must not be read as ON by accident -- only the exact string 'ON' opens
    the gate; every other type or casing (including the Python bool True,
    which JSON would also happily deserialize) refuses."""
    path = _write_cooler_state(tmp_path, {"cooler": bad_value})
    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(60.0))


# ---- assert_thermal_gate_open: temperature ceiling --------------------------


def test_refuses_when_temperature_is_over_the_ceiling(tmp_path):
    path = _write_cooler_state(tmp_path, {"cooler": "ON"})
    with pytest.raises(ThermalGateRefused, match=r"[Tt]emperature|GPU"):
        assert_thermal_gate_open(
            cooler_state_path=path, temperature_reader=_reader(TEMPERATURE_CEILING_C + 5)
        )


def test_refuses_exactly_at_the_ceiling_boundary_inclusive(tmp_path):
    """The ceiling is inclusive: a reading equal to the ceiling refuses, it
    does not need to exceed it."""
    path = _write_cooler_state(tmp_path, {"cooler": "ON"})
    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(
            cooler_state_path=path, temperature_reader=_reader(TEMPERATURE_CEILING_C)
        )


def test_allows_just_under_the_ceiling(tmp_path):
    path = _write_cooler_state(tmp_path, {"cooler": "ON"})
    assert_thermal_gate_open(
        cooler_state_path=path, temperature_reader=_reader(TEMPERATURE_CEILING_C - 0.1)
    )  # no raise


def test_error_message_states_cooler_off_as_the_firing_condition(tmp_path):
    path = _write_cooler_state(tmp_path, {"cooler": "OFF"})
    with pytest.raises(ThermalGateRefused) as exc_info:
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(60.0))
    message = str(exc_info.value).lower()
    assert "cooler" in message and "off" in message


def test_error_message_states_the_temperature_reading_as_the_firing_condition(tmp_path):
    path = _write_cooler_state(tmp_path, {"cooler": "ON"})
    with pytest.raises(ThermalGateRefused) as exc_info:
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(91.0))
    message = str(exc_info.value)
    assert "91" in message


# ---- nvidia-smi command resolution (cross WSL/Windows/native-Linux) --------


def test_resolve_prefers_a_path_lookup_when_present():
    assert _resolve_nvidia_smi_command(which=lambda name: "/usr/bin/nvidia-smi") == (
        "/usr/bin/nvidia-smi"
    )


def test_resolve_falls_back_to_the_wsl_windows_host_path(tmp_path):
    wsl_stub = tmp_path / "nvidia-smi.exe"
    wsl_stub.write_text("")
    resolved = _resolve_nvidia_smi_command(which=lambda name: None, wsl_path=wsl_stub)
    assert resolved == str(wsl_stub)


def test_resolve_refuses_when_neither_path_nor_wsl_fallback_exist(tmp_path):
    with pytest.raises(ThermalGateRefused):
        _resolve_nvidia_smi_command(which=lambda name: None, wsl_path=tmp_path / "missing.exe")


# ---- shelling out to nvidia-smi and parsing its output ----------------------


class _FakeCompletedProcess:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_shell_reads_a_single_gpu_reading():
    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="63\n")

    assert _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi") == 63.0


def test_shell_multi_gpu_response_uses_the_hottest_device():
    """Policy: the hottest device decides -- one overheating GPU is reason
    enough to refuse regardless of how many other devices are cool."""

    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="61\n74\n68\n")

    temp = _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")
    assert temp == 74.0


def test_shell_refuses_on_non_zero_exit():
    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(returncode=1, stderr="no devices found")

    with pytest.raises(ThermalGateRefused):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_on_unparseable_output():
    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="not-a-number\n")

    with pytest.raises(ThermalGateRefused):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_on_empty_output():
    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="\n")

    with pytest.raises(ThermalGateRefused):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_on_timeout():
    def _run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout"))

    with pytest.raises(ThermalGateRefused):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_when_the_binary_cannot_be_launched_at_all():
    def _run(cmd, **kwargs):
        raise OSError("no such file or directory")

    with pytest.raises(ThermalGateRefused):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_when_command_resolution_itself_refuses():
    """Covers the 'binary missing entirely' case end-to-end through the
    reader, not just at the resolver in isolation."""

    def _resolve():
        raise ThermalGateRefused("nvidia-smi not found anywhere")

    with pytest.raises(ThermalGateRefused):
        _shell_nvidia_smi_temperature_c(resolve_command=_resolve)


def test_shell_passes_the_stated_timeout_through_to_run():
    seen = {}

    def _run(cmd, **kwargs):
        seen["timeout"] = kwargs.get("timeout")
        return _FakeCompletedProcess(stdout="60\n")

    _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")
    assert seen["timeout"] == NVIDIA_SMI_TIMEOUT_S


# ---- T-0422 round 2, finding 1: exactly ONE authoritative cooler-state ----
# location, shared by every checkout/worktree -- never module-relative -----


def _load_thermal_gate_copy(tmp_path, checkout_name):
    """Copies this module's own source into a fresh fake-checkout tree at the
    same relative depth it really lives at
    (tools/comfy-client/src/comfy_client/thermal_gate.py) and imports it as
    an independent module -- reproduces the round-2 reviewer probe's own
    methodology: two separate checkouts, each running their own copy of this
    file, must still resolve to the identical authoritative cooler-state
    path, not one each. On the pre-fix module (a path relative to its own
    `__file__`), two such copies would diverge; that is exactly finding 1.

    Also used for a single fresh copy when a test needs
    `DEFAULT_COOLER_STATE_PATH`'s real value: `conftest.py`'s autouse
    `_safe_default_thermal_reading` fixture monkeypatches that attribute on
    the shared, already-imported `comfy_client.thermal_gate` module for
    every test in this suite, so reading it straight off that module would
    only ever see the fixture's tmp-path stub, never the real default. A
    freshly `importlib`-loaded copy is a distinct module object the fixture
    never touches.
    """
    checkout_root = tmp_path / checkout_name / "tools" / "comfy-client" / "src" / "comfy_client"
    checkout_root.mkdir(parents=True)
    dest = checkout_root / "thermal_gate.py"
    dest.write_text(Path(thermal_gate.__file__).read_text())
    spec = importlib.util.spec_from_file_location(f"_t0422_probe_{checkout_name}", dest)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_default_cooler_state_path_is_rooted_under_home_not_any_checkout(tmp_path):
    """Round-2 regression: `DEFAULT_COOLER_STATE_PATH` must not be derived
    from this module's own `__file__`/repo location (round 1's bug -- see
    the module docstring) -- it must be one fixed location under the user's
    home directory, the same way `tools/board/src/lib/db/connection.js`'s
    `DEFAULT_DB_PATH` roots `board.db` out-of-repo. Uses a freshly loaded
    copy -- see `_load_thermal_gate_copy`'s docstring for why."""
    fresh = _load_thermal_gate_copy(tmp_path, "fresh_default_check")
    assert fresh.DEFAULT_COOLER_STATE_PATH == (
        Path.home() / ".local" / "share" / "assembled-board" / "cooler-state.json"
    )


def test_two_independent_checkouts_resolve_to_the_identical_cooler_state_path(tmp_path):
    """The reviewer's round-2 probe, reproduced exactly: load two independent
    copies of this module from two different filesystem locations (standing
    in for two board task worktrees) and prove they agree on
    `DEFAULT_COOLER_STATE_PATH` -- neither copy's own on-disk location leaks
    into the path either resolves to."""
    main_checkout = _load_thermal_gate_copy(tmp_path, "main_checkout")
    worker_checkout = _load_thermal_gate_copy(tmp_path, "worker_checkout")

    assert main_checkout.DEFAULT_COOLER_STATE_PATH == worker_checkout.DEFAULT_COOLER_STATE_PATH
    assert "main_checkout" not in str(main_checkout.DEFAULT_COOLER_STATE_PATH)
    assert "worker_checkout" not in str(worker_checkout.DEFAULT_COOLER_STATE_PATH)


def test_resolve_cooler_state_path_ignores_cwd(tmp_path, monkeypatch):
    """A submitter running from an arbitrary cwd (an installed wheel, a
    different working directory than any checkout) must still resolve the
    same authoritative location -- never a cwd-relative fallback."""
    before = thermal_gate.resolve_cooler_state_path(env={})
    monkeypatch.chdir(tmp_path)
    after = thermal_gate.resolve_cooler_state_path(env={})
    assert before == after


def test_resolve_cooler_state_path_defaults_when_env_override_absent():
    resolved = thermal_gate.resolve_cooler_state_path(env={})
    assert resolved == thermal_gate.DEFAULT_COOLER_STATE_PATH


def test_resolve_cooler_state_path_honors_env_override(tmp_path):
    override = tmp_path / "custom-cooler-state.json"
    resolved = thermal_gate.resolve_cooler_state_path(env={"COOLER_STATE_PATH": str(override)})
    assert resolved == override


def test_assert_thermal_gate_open_honors_env_override_when_no_explicit_path_given(
    tmp_path, monkeypatch
):
    """The env override must reach the real gate entry point too, not just
    the standalone resolver -- and must win even over a `DEFAULT_COOLER_STATE_PATH`
    the test suite's own autouse fixture has repointed."""
    custom = tmp_path / "custom-cooler-state.json"
    custom.write_text('{"cooler": "OFF"}')
    monkeypatch.setenv("COOLER_STATE_PATH", str(custom))
    with pytest.raises(ThermalGateRefused):
        assert_thermal_gate_open(temperature_reader=_reader(60.0))


def test_env_override_pointing_at_a_missing_path_fails_closed_and_names_the_path(
    tmp_path, monkeypatch
):
    """Edge case: the env override points somewhere that doesn't exist --
    must fail closed with a message naming the exact path it tried, so a
    misconfiguration is diagnosable rather than mysterious."""
    missing = tmp_path / "does-not-exist" / "cooler-state.json"
    monkeypatch.setenv("COOLER_STATE_PATH", str(missing))
    with pytest.raises(ThermalGateRefused, match=re.escape(str(missing))):
        assert_thermal_gate_open(temperature_reader=_reader(60.0))


# ---- T-0422 round 2, finding 2: non-finite temperature readings must ------
# always refuse, never silently allow -----------------------------------


@pytest.mark.parametrize("stdout", ["nan\n", "-inf\n", "inf\n"])
def test_shell_refuses_on_non_finite_single_reading(stdout):
    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout=stdout)

    with pytest.raises(ThermalGateRefused, match="non-finite"):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_on_mixed_non_finite_then_hot_reading():
    """The exact reviewer probe repro (`'nan\\n87\\n' ALLOWED`, an 87C
    reading let through): a NaN before a genuinely hot 87C reading must
    refuse, citing the non-finite reading -- not silently let the 87C
    reading decide via `max()` losing the NaN's presence."""

    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="nan\n87\n")

    with pytest.raises(ThermalGateRefused, match="non-finite"):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_on_mixed_hot_then_non_finite_reading():
    """Same policy, opposite line order -- a finite hot reading followed by
    a non-finite one must still refuse, not silently return the finite 87
    because it was already the running max when the non-finite line hit."""

    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="87\nnan\n")

    with pytest.raises(ThermalGateRefused, match="non-finite"):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_refuses_when_all_device_lines_are_non_finite():
    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="nan\ninf\n-inf\n")

    with pytest.raises(ThermalGateRefused, match="non-finite"):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


def test_shell_still_refuses_on_empty_output_after_isfinite_validation_added():
    """Round 1's empty/whitespace-only stdout refusal must survive the
    finding-2 fix untouched."""

    def _run(cmd, **kwargs):
        return _FakeCompletedProcess(stdout="   \n\n")

    with pytest.raises(ThermalGateRefused):
        _shell_nvidia_smi_temperature_c(run=_run, resolve_command=lambda: "nvidia-smi")


@pytest.mark.parametrize("bad_value", [float("nan"), float("inf"), float("-inf")])
def test_assert_thermal_gate_open_refuses_a_non_finite_reader_result(tmp_path, bad_value):
    """Covers an injected `temperature_reader` returning a non-finite value
    directly, not only the shell-parsing path -- `assert_thermal_gate_open`
    validates whatever the reader hands back, before the ceiling
    comparison, so a non-standard reader can't bypass the check either."""
    path = _write_cooler_state(tmp_path, {"cooler": "ON"})
    with pytest.raises(ThermalGateRefused, match="non-finite"):
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(bad_value))


def test_assert_thermal_gate_open_reports_non_finite_reason_not_ceiling_for_positive_infinity(
    tmp_path,
):
    """`+inf` is technically `>= TEMPERATURE_CEILING_C` too, but the recorded
    reason must be the non-finite one, not 'hotter than the ceiling,
    therefore correctly refused by accident' -- so a reader that misbehaves
    is diagnosable, not indistinguishable from an ordinary hot refusal."""
    path = _write_cooler_state(tmp_path, {"cooler": "ON"})
    with pytest.raises(ThermalGateRefused) as exc_info:
        assert_thermal_gate_open(cooler_state_path=path, temperature_reader=_reader(float("inf")))
    message = str(exc_info.value).lower()
    assert "non-finite" in message
    assert "ceiling" not in message
