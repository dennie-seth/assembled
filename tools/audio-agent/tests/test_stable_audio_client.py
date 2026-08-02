"""Stable Audio Open HTTP client: POST /generate (blocking) -> GET
/output/{filename}. Mirrors test_audio_client.py (ACE-Step) -- same
synchronous submit/wait/fetch split, since the machine-side wrapper
(F:/StableAudioOpen/infer-api.py, docs/stable-audio-setup.md) follows the
same pattern as ACE-Step's infer-api-persistent.py. All calls are mocked
via `responses` -- no live Stable Audio Open call in the suite."""

from __future__ import annotations

import pytest
import responses
from requests.exceptions import ConnectionError as RequestsConnectionError
from requests.exceptions import Timeout as RequestsTimeout

from audio_agent.errors import ExecutionError, FetchError, PollTimeoutError, SubmitError
from audio_agent.stable_audio_client import StableAudioClient

BASE_URL = "http://172.18.192.1:8002"


def make_client() -> StableAudioClient:
    return StableAudioClient(base_url=BASE_URL)


def test_submit_returns_output_path_as_job_id(sample_texture_request):
    client = make_client()
    job_id = client.submit(sample_texture_request)
    assert job_id == sample_texture_request["output_path"]


def test_submit_raises_when_request_has_no_output_path():
    client = make_client()
    with pytest.raises(SubmitError, match="output_path"):
        client.submit({"prompt": "x"})


def test_submit_raises_on_duplicate_job_id(sample_texture_request):
    client = make_client()
    client.submit(sample_texture_request)
    with pytest.raises(SubmitError, match="already pending"):
        client.submit(sample_texture_request)


@responses.activate
def test_wait_for_completion_posts_the_pending_request_and_returns_body(sample_texture_request):
    responses.add(
        responses.POST,
        f"{BASE_URL}/generate",
        json={
            "status": "success",
            "output_path": sample_texture_request["output_path"],
            "message": "ok",
        },
        status=200,
    )
    client = make_client()
    job_id = client.submit(sample_texture_request)
    result = client.wait_for_completion(job_id, timeout=60.0, poll_interval=1.0)

    assert result["status"] == "success"
    assert result["output_path"] == sample_texture_request["output_path"]

    import json as jsonlib

    sent = jsonlib.loads(responses.calls[0].request.body)
    assert sent == sample_texture_request


@responses.activate
def test_wait_for_completion_raises_when_job_never_submitted():
    client = make_client()
    with pytest.raises(SubmitError, match="no pending request"):
        client.wait_for_completion("never_submitted.wav", timeout=60.0, poll_interval=1.0)


@responses.activate
def test_wait_for_completion_raises_submit_error_on_validation_rejection(sample_texture_request):
    responses.add(
        responses.POST, f"{BASE_URL}/generate", json={"detail": "bad field"}, status=422
    )
    client = make_client()
    job_id = client.submit(sample_texture_request)
    with pytest.raises(SubmitError, match="422"):
        client.wait_for_completion(job_id, timeout=60.0, poll_interval=1.0)


@responses.activate
def test_wait_for_completion_raises_execution_error_on_500(sample_texture_request):
    responses.add(
        responses.POST,
        f"{BASE_URL}/generate",
        json={"detail": "Error generating audio: CUDA out of memory"},
        status=500,
    )
    client = make_client()
    job_id = client.submit(sample_texture_request)
    with pytest.raises(ExecutionError, match="out of memory") as exc_info:
        client.wait_for_completion(job_id, timeout=60.0, poll_interval=1.0)
    assert "CUDA" in str(exc_info.value.detail)


@responses.activate
def test_wait_for_completion_raises_execution_error_on_non_success_status(sample_texture_request):
    responses.add(
        responses.POST,
        f"{BASE_URL}/generate",
        json={"status": "failed", "output_path": None, "message": "pipeline returned no audio"},
        status=200,
    )
    client = make_client()
    job_id = client.submit(sample_texture_request)
    with pytest.raises(ExecutionError, match="pipeline returned no audio"):
        client.wait_for_completion(job_id, timeout=60.0, poll_interval=1.0)


@responses.activate
def test_wait_for_completion_wraps_connection_failure(sample_texture_request):
    responses.add(
        responses.POST, f"{BASE_URL}/generate", body=RequestsConnectionError("refused")
    )
    client = make_client()
    job_id = client.submit(sample_texture_request)
    with pytest.raises(SubmitError, match="failed to connect"):
        client.wait_for_completion(job_id, timeout=60.0, poll_interval=1.0)


@responses.activate
def test_wait_for_completion_raises_poll_timeout_on_request_timeout(sample_texture_request):
    responses.add(responses.POST, f"{BASE_URL}/generate", body=RequestsTimeout("timed out"))
    client = make_client()
    job_id = client.submit(sample_texture_request)
    with pytest.raises(PollTimeoutError, match=job_id):
        client.wait_for_completion(job_id, timeout=5.0, poll_interval=1.0)


@responses.activate
def test_fetch_output_downloads_bytes_by_basename():
    responses.add(
        responses.GET,
        f"{BASE_URL}/output/out_7.wav",
        body=b"RIFFfakewavdata",
        status=200,
    )
    client = make_client()
    data = client.fetch_output({"output_path": "F:/StableAudioOpen/outputs/out_7.wav"})
    assert data == b"RIFFfakewavdata"


def test_fetch_output_raises_when_no_output_path():
    client = make_client()
    with pytest.raises(FetchError, match="no output_path"):
        client.fetch_output({"status": "success"})


@responses.activate
def test_fetch_output_raises_on_non_200():
    responses.add(responses.GET, f"{BASE_URL}/output/missing.wav", status=404)
    client = make_client()
    with pytest.raises(FetchError, match="404"):
        client.fetch_output({"output_path": "missing.wav"})


@responses.activate
def test_generate_end_to_end(sample_texture_request):
    responses.add(
        responses.POST,
        f"{BASE_URL}/generate",
        json={
            "status": "success",
            "output_path": sample_texture_request["output_path"],
            "message": "ok",
        },
        status=200,
    )
    responses.add(
        responses.GET,
        f"{BASE_URL}/output/{sample_texture_request['output_path']}",
        body=b"WAVDATA",
        status=200,
    )
    client = make_client()
    data = client.generate(sample_texture_request, timeout=60.0, poll_interval=1.0)
    assert data == b"WAVDATA"
