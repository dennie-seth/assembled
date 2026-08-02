"""ComfyUI HTTP backend: POST /prompt -> poll GET /history/{id} -> GET /view.

Poll uses capped exponential backoff (never hammers the server on a slow
queue, never overshoots the caller's timeout) and distinguishes three
failure modes the AssetAgent needs to react to differently: a rejected
submission (`SubmitError`, often a bad checkpoint/node), a job that queued
but failed during execution (`ExecutionError`, e.g. OOM), and a job that
never completed in time (`PollTimeoutError`).
"""

from __future__ import annotations

import time
import uuid
from typing import Any

import requests

from comfy_client.client import GenerationClient
from comfy_client.errors import ExecutionError, FetchError, PollTimeoutError, SubmitError

DEFAULT_TIMEOUT = 300.0
DEFAULT_POLL_INTERVAL = 1.0
MAX_POLL_INTERVAL = 5.0


class ComfyUIClient(GenerationClient):
    def __init__(
        self,
        base_url: str,
        session: requests.Session | None = None,
        client_id: str | None = None,
        request_timeout: float = 30.0,
        sleep=time.sleep,
        now=time.monotonic,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.client_id = client_id or str(uuid.uuid4())
        self.request_timeout = request_timeout
        self._sleep = sleep
        self._now = now

    def submit(self, workflow: dict[str, Any]) -> str:
        try:
            resp = self.session.post(
                f"{self.base_url}/prompt",
                json={"prompt": workflow, "client_id": self.client_id},
                timeout=self.request_timeout,
            )
        except requests.RequestException as exc:
            raise SubmitError(f"POST /prompt failed to connect: {exc}") from exc

        try:
            body = resp.json()
        except ValueError:
            body = {}

        node_errors = body.get("node_errors") or {}
        if resp.status_code >= 400 or node_errors:
            error = body.get("error")
            message = error.get("message") if isinstance(error, dict) else None
            raise SubmitError(
                message or f"POST /prompt rejected the workflow (HTTP {resp.status_code})",
                node_errors=node_errors,
                status_code=resp.status_code,
            )

        prompt_id = body.get("prompt_id")
        if not prompt_id:
            raise SubmitError(f"POST /prompt response had no prompt_id: {body!r}")
        return prompt_id

    def wait_for_completion(
        self,
        job_id: str,
        timeout: float = DEFAULT_TIMEOUT,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
    ) -> dict[str, Any]:
        deadline = self._now() + timeout
        interval = poll_interval
        while True:
            try:
                resp = self.session.get(
                    f"{self.base_url}/history/{job_id}", timeout=self.request_timeout
                )
                resp.raise_for_status()
                history = resp.json()
            except requests.RequestException as exc:
                raise PollTimeoutError(f"GET /history/{job_id} failed: {exc}") from exc

            entry = history.get(job_id)
            if entry is not None:
                status = entry.get("status", {})
                if status.get("completed") or status.get("status_str") == "success":
                    return entry
                if status.get("status_str") == "error":
                    raise ExecutionError(
                        f"ComfyUI job {job_id} failed during execution",
                        messages=status.get("messages", []),
                    )

            remaining = deadline - self._now()
            if remaining <= 0:
                raise PollTimeoutError(f"ComfyUI job {job_id} did not complete within {timeout}s")
            self._sleep(min(interval, remaining))
            interval = min(interval * 2, MAX_POLL_INTERVAL)

    def fetch_output(self, job_result: dict[str, Any]) -> bytes:
        outputs = job_result.get("outputs", {})
        for node_output in outputs.values():
            images = node_output.get("images")
            if images:
                image = images[0]
                return self._fetch_view(
                    image["filename"], image.get("subfolder", ""), image.get("type", "output")
                )
        raise FetchError(f"no image outputs found in job result: {job_result!r}")

    def _fetch_view(self, filename: str, subfolder: str, file_type: str) -> bytes:
        try:
            resp = self.session.get(
                f"{self.base_url}/view",
                params={"filename": filename, "subfolder": subfolder, "type": file_type},
                timeout=self.request_timeout,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise FetchError(f"GET /view failed for {filename!r}: {exc}") from exc
        return resp.content
