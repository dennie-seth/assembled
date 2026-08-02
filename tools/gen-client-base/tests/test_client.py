"""`GenerationClient`'s contract: `generate()` drives submit -> wait_for_completion
-> fetch_output in order and returns the fetched bytes; the ABC itself cannot be
instantiated. Both `comfy_client.comfyui_client.ComfyUIClient` and
`audio_agent.audio_client.AudioClient` are exercised against their own real HTTP
shapes in their own packages -- this test only covers the shared scaffolding."""

from __future__ import annotations

import pytest

from gen_client_base.client import GenerationClient


class FakeClient(GenerationClient):
    def __init__(self, job_id: str = "job1", output: bytes = b"DATA") -> None:
        self.job_id = job_id
        self.output = output
        self.calls: list[tuple] = []

    def submit(self, workflow):
        self.calls.append(("submit", workflow))
        return self.job_id

    def wait_for_completion(self, job_id, timeout, poll_interval):
        self.calls.append(("wait", job_id, timeout, poll_interval))
        return {"job_id": job_id}

    def fetch_output(self, job_result):
        self.calls.append(("fetch", job_result))
        return self.output


def test_generate_calls_submit_wait_fetch_in_order():
    client = FakeClient()
    result = client.generate({"prompt": "x"}, timeout=10.0, poll_interval=0.5)

    assert result == b"DATA"
    assert [c[0] for c in client.calls] == ["submit", "wait", "fetch"]


def test_generate_passes_submitted_workflow_through():
    client = FakeClient()
    workflow = {"prompt": "a derelict signal tower"}
    client.generate(workflow)

    _, submitted = client.calls[0]
    assert submitted == workflow


def test_generate_passes_timeout_and_poll_interval_to_wait_for_completion():
    client = FakeClient(job_id="job42")
    client.generate({}, timeout=99.0, poll_interval=2.5)

    _, job_id, timeout, poll_interval = client.calls[1]
    assert job_id == "job42"
    assert timeout == 99.0
    assert poll_interval == 2.5


def test_generation_client_cannot_be_instantiated_directly():
    with pytest.raises(TypeError):
        GenerationClient()
