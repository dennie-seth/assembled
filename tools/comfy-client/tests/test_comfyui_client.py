"""ComfyUI HTTP client: POST /prompt -> poll GET /history/{id} -> GET /view.
All calls are mocked via `responses` -- no live ComfyUI calls in the suite."""

from __future__ import annotations

import json

import pytest
import responses
from gen_client_base.license_allowlist import CheckpointNotAllowedError
from requests.exceptions import ConnectionError as RequestsConnectionError

from comfy_client import thermal_gate
from comfy_client.comfyui_client import ComfyUIClient
from comfy_client.errors import (
    ExecutionError,
    FetchError,
    PollTimeoutError,
    SubmitError,
    UploadError,
)
from comfy_client.thermal_gate import ThermalGateRefused, assert_thermal_gate_open

BASE_URL = "http://172.18.192.1:8188"


def make_client(fake_clock) -> ComfyUIClient:
    return ComfyUIClient(base_url=BASE_URL, sleep=fake_clock.sleep, now=fake_clock.now)


@responses.activate
def test_submit_returns_prompt_id(sample_graph, fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={"prompt_id": "abc123", "number": 1, "node_errors": {}},
        status=200,
    )
    client = make_client(fake_clock)
    assert client.submit(sample_graph) == "abc123"

    sent = json.loads(responses.calls[0].request.body)
    assert sent["prompt"] == sample_graph
    assert sent["client_id"] == client.client_id


@responses.activate
def test_submit_raises_on_validation_error(sample_graph, fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={
            "error": {"type": "invalid_prompt", "message": "checkpoint not found"},
            "node_errors": {"4": {"errors": [{"message": "ckpt_name not in list"}]}},
        },
        status=400,
    )
    client = make_client(fake_clock)
    with pytest.raises(SubmitError, match="checkpoint not found") as exc_info:
        client.submit(sample_graph)
    assert "4" in exc_info.value.node_errors
    assert exc_info.value.status_code == 400


@responses.activate
def test_submit_raises_when_node_errors_present_even_on_200(sample_graph, fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={"prompt_id": None, "node_errors": {"6": {"errors": ["bad text encoding"]}}},
        status=200,
    )
    client = make_client(fake_clock)
    with pytest.raises(SubmitError):
        client.submit(sample_graph)


@responses.activate
def test_submit_wraps_connection_failure(sample_graph, fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        body=RequestsConnectionError("connection refused"),
    )
    client = make_client(fake_clock)
    with pytest.raises(SubmitError, match="failed to connect"):
        client.submit(sample_graph)


@responses.activate
def test_wait_for_completion_polls_until_success(fake_clock):
    responses.add(responses.GET, f"{BASE_URL}/history/abc123", json={}, status=200)
    responses.add(
        responses.GET,
        f"{BASE_URL}/history/abc123",
        json={
            "abc123": {
                "status": {"status_str": "success", "completed": True, "messages": []},
                "outputs": {"9": {"images": [{"filename": "assembled_00001.png"}]}},
            }
        },
        status=200,
    )
    client = make_client(fake_clock)
    result = client.wait_for_completion("abc123", timeout=30, poll_interval=1.0)
    assert result["status"]["status_str"] == "success"
    assert fake_clock.sleeps == [1.0]


@responses.activate
def test_wait_for_completion_backs_off_exponentially_and_caps(fake_clock):
    for _ in range(4):
        responses.add(responses.GET, f"{BASE_URL}/history/abc123", json={}, status=200)
    responses.add(
        responses.GET,
        f"{BASE_URL}/history/abc123",
        json={"abc123": {"status": {"status_str": "success", "completed": True}, "outputs": {}}},
        status=200,
    )
    client = make_client(fake_clock)
    client.wait_for_completion("abc123", timeout=60, poll_interval=1.0)
    # 1, 2, 4, 5(capped at MAX_POLL_INTERVAL=5) -- never exceeds the cap.
    assert fake_clock.sleeps == [1.0, 2.0, 4.0, 5.0]


@responses.activate
def test_wait_for_completion_raises_on_execution_error(fake_clock):
    responses.add(
        responses.GET,
        f"{BASE_URL}/history/abc123",
        json={
            "abc123": {
                "status": {
                    "status_str": "error",
                    "completed": False,
                    "messages": [["execution_error", {"node_id": "3", "exception_message": "OOM"}]],
                },
                "outputs": {},
            }
        },
        status=200,
    )
    client = make_client(fake_clock)
    with pytest.raises(ExecutionError, match="abc123") as exc_info:
        client.wait_for_completion("abc123", timeout=30, poll_interval=1.0)
    assert exc_info.value.messages


@responses.activate
def test_wait_for_completion_times_out(fake_clock):
    responses.add(responses.GET, f"{BASE_URL}/history/abc123", json={}, status=200)
    client = make_client(fake_clock)
    with pytest.raises(PollTimeoutError, match="abc123"):
        client.wait_for_completion("abc123", timeout=3.0, poll_interval=1.0)


@responses.activate
def test_fetch_output_downloads_the_first_image(fake_clock):
    responses.add(
        responses.GET,
        f"{BASE_URL}/view",
        body=b"\x89PNGfakebytes",
        status=200,
        content_type="image/png",
    )
    client = make_client(fake_clock)
    image = {"filename": "out.png", "subfolder": "", "type": "output"}
    job_result = {"outputs": {"9": {"images": [image]}}}
    data = client.fetch_output(job_result)
    assert data == b"\x89PNGfakebytes"

    req = responses.calls[0].request
    assert "filename=out.png" in req.url
    assert "type=output" in req.url


@responses.activate
def test_fetch_output_raises_when_no_images(fake_clock):
    client = make_client(fake_clock)
    with pytest.raises(FetchError, match="no image outputs"):
        client.fetch_output({"outputs": {"9": {}}})


@responses.activate
def test_upload_image_returns_server_assigned_name(fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/upload/image",
        json={"name": "template_00001.png", "subfolder": "", "type": "input"},
        status=200,
    )
    client = make_client(fake_clock)
    result = client.upload_image(b"\x89PNGtemplatebytes", filename="template.png")
    assert result["name"] == "template_00001.png"

    req = responses.calls[0].request
    assert b"template.png" in req.body
    assert b"\x89PNGtemplatebytes" in req.body


@responses.activate
def test_upload_image_wraps_connection_failure(fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/upload/image",
        body=RequestsConnectionError("connection refused"),
    )
    client = make_client(fake_clock)
    with pytest.raises(UploadError, match="failed for 'template.png'"):
        client.upload_image(b"data", filename="template.png")


@responses.activate
def test_upload_image_raises_on_non_2xx(fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/upload/image",
        json={"error": "bad request"},
        status=400,
    )
    client = make_client(fake_clock)
    with pytest.raises(UploadError):
        client.upload_image(b"data", filename="template.png")


# ---- T-0418: the checkpoint-allowlist gate fires on the direct-submit path,
# not only inside comfy_client.pipeline.generate() ---------------------------


@responses.activate
def test_submit_refuses_a_hand_built_graph_naming_an_unregistered_checkpoint(fake_clock):
    """This is the regression that would have caught T-0337: a hand-built
    graph (never passed through pipeline.generate()'s own gate) submitted
    straight to ComfyUIClient.submit(), the same call
    assets/src/character/gen_master_sheet_cutout_compare_T0337.py's SAM3
    runner uses. No responses.add() is registered for /prompt -- if the gate
    didn't fire first and the code actually tried the HTTP call, this test
    would fail with a connection error, not a CheckpointNotAllowedError."""
    graph = {
        "2": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": "unregistered_checkpoint.safetensors",
                "weight_dtype": "default",
            },
        },
    }
    client = make_client(fake_clock)
    with pytest.raises(CheckpointNotAllowedError):
        client.submit(graph)
    assert len(responses.calls) == 0


@responses.activate
def test_submit_allows_a_hand_built_graph_naming_no_checkpoint_at_all(fake_clock):
    """A SAM3_Detect segmentation graph fed a MASK/IMAGE, naming no checkpoint
    at all, must still submit -- the gate refuses unregistered checkpoints,
    it does not require every graph to have one."""
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={"prompt_id": "seg1", "node_errors": {}},
        status=200,
    )
    graph = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "panel.png"}},
        "3": {"class_type": "SAM3_Detect", "inputs": {"image": ["1", 0], "threshold": 0.5}},
    }
    client = make_client(fake_clock)
    assert client.submit(graph) == "seg1"


@responses.activate
def test_generate_end_to_end(sample_graph, fake_clock):
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={"prompt_id": "abc123", "node_errors": {}},
        status=200,
    )
    responses.add(
        responses.GET,
        f"{BASE_URL}/history/abc123",
        json={
            "abc123": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {"9": {"images": [{"filename": "out.png", "type": "output"}]}},
            }
        },
        status=200,
    )
    responses.add(responses.GET, f"{BASE_URL}/view", body=b"PNGDATA", status=200)

    client = make_client(fake_clock)
    data = client.generate(sample_graph, timeout=30, poll_interval=1.0)
    assert data == b"PNGDATA"


# ---- T-0422: the thermal/cooler gate fires on the direct-submit path, not --
# only through some caller that remembers to check first ---------------------


def _refusing_thermal_gate():
    raise ThermalGateRefused("cooler is OFF per stub -- refusing submission")


@responses.activate
def test_submit_refuses_via_the_real_default_gate_when_the_cooler_state_file_says_off(
    fake_clock, monkeypatch, tmp_path
):
    """The literally bare path: ComfyUIClient constructed with no
    thermal_gate override at all, so submit() runs the real
    assert_thermal_gate_open against DEFAULT_COOLER_STATE_PATH -- proven by
    pointing that default at an OFF file, not by injecting a stub gate
    callable. This is the regression test for the T-0419 incident itself:
    the cooler flag alone, with zero special construction, must stop a
    submission."""
    off_state = tmp_path / "cooler-state.json"
    off_state.write_text('{"cooler": "OFF"}')
    monkeypatch.setattr(thermal_gate, "DEFAULT_COOLER_STATE_PATH", off_state)

    client = make_client(fake_clock)
    graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "panel.png"}}}
    with pytest.raises(ThermalGateRefused):
        client.submit(graph)
    assert len(responses.calls) == 0


@responses.activate
def test_submit_refuses_a_bare_hand_built_graph_when_the_cooler_is_off(fake_clock):
    """The T-0419 regression: a hand-built graph posted straight to
    ComfyUIClient.submit() (never through pipeline.generate()) must be
    refused when the cooler is off, exactly like the checkpoint gate already
    covers a hand-built graph naming a disallowed checkpoint. No responses.add()
    is registered for /prompt -- if the gate didn't fire first and the code
    actually tried the HTTP call, this would fail with a connection error,
    not a ThermalGateRefused."""
    graph = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "panel.png"}},
        "3": {"class_type": "SAM3_Detect", "inputs": {"image": ["1", 0], "threshold": 0.5}},
    }
    client = ComfyUIClient(
        base_url=BASE_URL,
        sleep=fake_clock.sleep,
        now=fake_clock.now,
        thermal_gate=_refusing_thermal_gate,
    )
    with pytest.raises(ThermalGateRefused):
        client.submit(graph)
    assert len(responses.calls) == 0


@responses.activate
def test_submit_allows_when_cooler_is_on_and_temperature_is_under_the_ceiling(fake_clock, tmp_path):
    """A gate that is never open is not a gate: prove the allow path fires
    too, through the real assert_thermal_gate_open (a real ON cooler-state
    file + an injected under-ceiling reading), not a trivial always-allow
    stub."""
    cooler_state = tmp_path / "cooler-state.json"
    cooler_state.write_text('{"cooler": "ON"}')
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={"prompt_id": "thermal-ok", "node_errors": {}},
        status=200,
    )
    client = ComfyUIClient(
        base_url=BASE_URL,
        sleep=fake_clock.sleep,
        now=fake_clock.now,
        thermal_gate=lambda: assert_thermal_gate_open(
            cooler_state_path=cooler_state, temperature_reader=lambda: 60.0
        ),
    )
    graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "panel.png"}}}
    assert client.submit(graph) == "thermal-ok"


@responses.activate
def test_submit_with_no_thermal_override_still_submits_ordinary_mocked_http_flows(fake_clock):
    """The default (uninjected) thermal_gate must not break an ordinary
    mocked-HTTP submit -- this is what keeps the rest of this file's 244
    pre-existing tests green without any of them knowing this gate exists."""
    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={"prompt_id": "default-ok", "node_errors": {}},
        status=200,
    )
    client = make_client(fake_clock)
    graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "panel.png"}}}
    assert client.submit(graph) == "default-ok"


# ---- T-0422 round 2, finding 1: the cooler decision is ONE authoritative --
# state shared by every worktree's own ComfyUIClient, not one flag per -------
# checkout -- and client construction must not cache it ---------------------


@responses.activate
def test_two_linked_worktree_clients_both_see_a_flip_made_after_construction(
    fake_clock, monkeypatch, tmp_path
):
    """The exact regression the round-2 review asked for: two ComfyUIClient
    instances -- standing in for two board task worktrees' own clients,
    each already constructed -- must both read the SAME authoritative
    cooler-state file (round 1's bug was a path derived from each
    checkout's own `__file__`, giving each worktree its own copy). Flip the
    shared file to OFF only *after* both clients already exist, then assert
    the very next submission from BOTH refuses and that no HTTP call left
    either client -- proving neither client cached the ON decision at
    construction time."""
    shared_state = tmp_path / "shared-cooler-state.json"
    shared_state.write_text('{"cooler": "ON"}')
    monkeypatch.setattr(thermal_gate, "DEFAULT_COOLER_STATE_PATH", shared_state)
    monkeypatch.setattr(thermal_gate, "_shell_nvidia_smi_temperature_c", lambda **_: 60.0)

    worktree_a_client = ComfyUIClient(base_url=BASE_URL, sleep=fake_clock.sleep, now=fake_clock.now)
    worktree_b_client = ComfyUIClient(base_url=BASE_URL, sleep=fake_clock.sleep, now=fake_clock.now)

    # Flip AFTER both clients already exist -- construction must not cache.
    shared_state.write_text('{"cooler": "OFF"}')

    graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "panel.png"}}}
    with pytest.raises(ThermalGateRefused):
        worktree_a_client.submit(graph)
    with pytest.raises(ThermalGateRefused):
        worktree_b_client.submit(graph)
    assert len(responses.calls) == 0
