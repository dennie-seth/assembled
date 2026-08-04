"""ACE-Step HTTP backend: POST /generate (blocking) -> GET /output/{filename}.

ACE-Step's patched `infer-api.py` (docs/ace-step-setup.md) has no separate
poll endpoint -- `/generate` blocks server-side for the full generation
(model already loaded persistently; just the diffusion run, ~20-40s+ per
docs/ace-step-setup.md's measurements) and returns the result inline. To
still honor `GenerationClient`'s submit -> wait_for_completion -> fetch_output
shape (and let the caller's `timeout` actually bound the slow part), the
blocking POST happens in `wait_for_completion`, not `submit`:

- `submit()` only stashes the rendered request under a job id (the
  request's `output_path`) and returns immediately -- no HTTP call.
- `wait_for_completion()` performs the actual blocking `POST /generate`
  with the caller-supplied `timeout`, and is where a `SubmitError` /
  `ExecutionError` / `PollTimeoutError` can actually occur. `poll_interval`
  is accepted for ABC signature compatibility but unused -- there is
  nothing to poll.
- `fetch_output()` downloads the bytes ACE-Step wrote server-side via the
  patch's `GET /output/{filename}` endpoint (added alongside the
  persistent-pipeline patch; ACE-Step's stock `infer-api.py` has no way to
  serve the file it wrote).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import requests
from gen_client_base.client import GenerationClient

from audio_agent.errors import ExecutionError, FetchError, PollTimeoutError, SubmitError

DEFAULT_REQUEST_TIMEOUT = 30.0


class AudioClient(GenerationClient):
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
                f"ACE-Step job {job_id} did not complete within {timeout}s: {exc}"
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
                f"ACE-Step job {job_id} failed during execution: {detail}", detail=detail
            )

        if body.get("status") != "success":
            raise ExecutionError(
                f"ACE-Step job {job_id} reported status {body.get('status')!r}: "
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
