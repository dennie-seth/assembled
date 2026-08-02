"""ComfyUI HTTP client: POST /prompt -> poll GET /history/{id} -> GET /view.
All calls are mocked via `responses` -- no live ComfyUI calls in the suite."""

from __future__ import annotations

import json

import pytest
import responses

from comfy_client.comfyui_client import ComfyUIClient
from comfy_client.errors import ExecutionError, FetchError, PollTimeoutError, SubmitError

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
        body=ConnectionError("connection refused"),
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
    job_result = {"outputs": {"9": {"images": [{"filename": "out.png", "subfolder": "", "type": "output"}]}}}
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
                "outputs": {"9": {"images": [{"filename": "out.png", "subfolder": "", "type": "output"}]}},
            }
        },
        status=200,
    )
    responses.add(responses.GET, f"{BASE_URL}/view", body=b"PNGDATA", status=200)

    client = make_client(fake_clock)
    data = client.generate(sample_graph, timeout=30, poll_interval=1.0)
    assert data == b"PNGDATA"
