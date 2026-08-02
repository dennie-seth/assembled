"""Stable Audio Open HTTP backend: POST /generate (blocking) -> GET /output/{filename}.

Mirrors `audio_agent.audio_client.AudioClient` (ACE-Step, T-0082) exactly:
the machine-side wrapper this talks to (`F:/StableAudioOpen/infer-api.py`,
docs/stable-audio-setup.md) is a persistent-pipeline FastAPI server built
on the identical pattern as ACE-Step's `infer-api-persistent.py` --
`StableAudioPipeline` loaded once at startup, `POST /generate` blocks
server-side for the full diffusion run (~31s for a 6s clip at 100 steps
per `F:/StableAudioOpen/SETUP-NOTES.md`) and returns the result inline,
with no separate poll endpoint. Same submit/wait/fetch split as
`AudioClient` for the same reason -- see that module's docstring.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import requests
from gen_client_base.client import GenerationClient

from audio_agent.errors import ExecutionError, FetchError, PollTimeoutError, SubmitError

DEFAULT_REQUEST_TIMEOUT = 30.0


class StableAudioClient(GenerationClient):
    def __init__(
        self,
        base_url: str,
        session: requests.Session | None = None,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.request_timeout = request_timeout
        self._pending: dict[str, dict[str, Any]] = {}

    def submit(self, workflow: dict[str, Any]) -> str:
        job_id = workflow.get("output_path")
        if not job_id:
            raise SubmitError("request has no output_path to use as a job id")
        if job_id in self._pending:
            raise SubmitError(f"job id {job_id!r} is already pending on this client")
        self._pending[job_id] = workflow
        return job_id

    def wait_for_completion(
        self, job_id: str, timeout: float, poll_interval: float
    ) -> dict[str, Any]:
        request = self._pending.pop(job_id, None)
        if request is None:
            raise SubmitError(f"no pending request for job id {job_id!r}; submit() first")

        try:
            resp = self.session.post(
                f"{self.base_url}/generate", json=request, timeout=timeout
            )
        except requests.Timeout as exc:
            raise PollTimeoutError(
                f"Stable Audio Open job {job_id} did not complete within {timeout}s: {exc}"
            ) from exc
        except requests.RequestException as exc:
            raise SubmitError(f"POST /generate failed to connect: {exc}") from exc

        try:
            body = resp.json()
        except ValueError:
            body = {}

        if resp.status_code == 422:
            raise SubmitError(
                f"POST /generate rejected the request (HTTP 422): {body}", status_code=422
            )
        if resp.status_code >= 400:
            detail = body.get("detail", body)
            raise ExecutionError(
                f"Stable Audio Open job {job_id} failed during execution: {detail}",
                detail=detail,
            )

        if body.get("status") != "success":
            raise ExecutionError(
                f"Stable Audio Open job {job_id} reported status {body.get('status')!r}: "
                f"{body.get('message')}",
                detail=body,
            )
        return body

    def fetch_output(self, job_result: dict[str, Any]) -> bytes:
        output_path = job_result.get("output_path")
        if not output_path:
            raise FetchError(f"no output_path in job result: {job_result!r}")
        filename = Path(output_path).name

        try:
            resp = self.session.get(
                f"{self.base_url}/output/{filename}", timeout=self.request_timeout
            )
        except requests.RequestException as exc:
            raise FetchError(f"GET /output/{filename} failed: {exc}") from exc

        if resp.status_code != 200:
            raise FetchError(f"GET /output/{filename} returned HTTP {resp.status_code}")
        return resp.content
