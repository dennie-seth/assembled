"""T-0422: the thermal/cooler submit gate, from the T-0419 incident (39
ComfyUI jobs ran with the cooler off, GPU 81-87C, before a running board run
had to be cancelled -- per-job interruption could not keep up with a retry
loop that just resubmitted).

Pure unit tests of `assert_thermal_gate_open` and its two building blocks
(`_cooler_is_on`, `_shell_nvidia_smi_temperature_c` + its command resolver),
all injected with stub cooler-state paths / process runners -- no real
nvidia-smi call, no dependency on the real committed
`tools/board/ops/cooler-state.json`. See test_comfyui_client.py for the
choke-point regression proving `ComfyUIClient.submit()` itself is gated, not
only this module in isolation.

RED state: `comfy_client.thermal_gate` does not exist yet -> ImportError.
"""

from __future__ import annotations

import json
import subprocess

import pytest

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
