"""Error types for the generation-client submit -> poll -> fetch pipeline."""

from __future__ import annotations

from typing import Any


class ComfyClientError(RuntimeError):
    """Base for every error this package raises."""


class SubmitError(ComfyClientError):
    """POST /prompt was rejected: validation/node errors or a non-2xx response."""

    def __init__(
        self,
        message: str,
        node_errors: dict[str, Any] | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.node_errors = node_errors or {}
        self.status_code = status_code


class ExecutionError(ComfyClientError):
    """The queued job reached /history with an error status."""

    def __init__(self, message: str, messages: list[Any] | None = None) -> None:
        super().__init__(message)
        self.messages = messages or []


class PollTimeoutError(ComfyClientError):
    """Polling /history exceeded the caller's deadline without completing."""


class FetchError(ComfyClientError):
    """GET /view failed, or the completed job had no fetchable output."""


class UploadError(ComfyClientError):
    """POST /upload/image failed -- used by the img2img conditioning path (T-0106)."""


class MissingModelHashError(ComfyClientError):
    """Provenance cannot be written without a checkpoint hash (T-0151).

    PLAN.md §0: a null hash means the exact weights that produced an asset
    cannot be proven.  Call generate() with checkpoint_dir= or set
    recipe.model_hash before generating.
    """
