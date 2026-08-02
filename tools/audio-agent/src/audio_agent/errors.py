"""Error types for AudioClient's submit -> wait -> fetch pipeline.

ACE-Step's patched `/generate` (docs/ace-step-setup.md) is a single
**synchronous** HTTP call that blocks until generation finishes -- unlike
ComfyUI's async submit/poll split, there is no separate job-status
endpoint. `AudioClient.submit()` performs that blocking call, so a
`requests` timeout during it means the job did not complete in time
(`PollTimeoutError`, matching the semantics callers expect from that error
elsewhere), not that submission itself was rejected.
"""

from __future__ import annotations

from typing import Any


class AudioClientError(RuntimeError):
    """Base for every error this package raises."""


class SubmitError(AudioClientError):
    """POST /generate was rejected before generation started: connection
    failure, or a non-2xx response that isn't an execution failure (e.g. a
    422 request-validation error)."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class ExecutionError(AudioClientError):
    """The ACE-Step pipeline ran but reported failure (HTTP 500 from the
    patched server's exception handler, or `status != "success"`)."""

    def __init__(self, message: str, detail: Any = None) -> None:
        super().__init__(message)
        self.detail = detail


class PollTimeoutError(AudioClientError):
    """The blocking POST /generate call did not return within the caller's
    timeout -- ACE-Step generation (model load + diffusion) can take
    30-60s+; see docs/ace-step-setup.md for measured timings."""


class FetchError(AudioClientError):
    """GET /output/{filename} failed, or the completed job had no
    fetchable output path."""
