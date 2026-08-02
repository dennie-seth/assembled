"""Single-GPU serialization guard (T-0082 acceptance).

docs/ace-step-setup.md (T-0080): an 8-second ACE-Step generation peaked at
**7949 MiB / 8192 MiB** system-wide VRAM on this 8GB card -- ~243 MB of
headroom, with nothing else GPU-heavy running. ComfyUI (T-0070, AssetAgent)
and ACE-Step (AudioAgent) cannot fit on this card at the same time; running
them concurrently is a near-certain OOM, not a performance hit.

This module is a documented **seam**, not a distributed lock: it's a
plain advisory file lock (`fcntl.flock`, POSIX) at a well-known path any
GPU-heavy generation process on this machine can choose to acquire around
its own generation call. It only serializes processes that opt in by
acquiring the *same* lock file -- it does not discover or preempt a
ComfyUI process that isn't using it. `audio_agent.pipeline.generate()`
acquires it around every `AudioClient.generate()` call; the board
orchestration (not built yet) is the natural place to make AssetAgent's
comfy-client pipeline acquire the same lock, so the two agents never run
generation simultaneously regardless of which kicks off first.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import time
from pathlib import Path

DEFAULT_LOCK_PATH = Path(os.environ.get("ASSEMBLED_GPU_LOCK_PATH", "/tmp/assembled-gpu.lock"))
POLL_INTERVAL = 0.5


class GPULockTimeoutError(RuntimeError):
    """Another process held the GPU lock past the caller's timeout."""


@contextlib.contextmanager
def gpu_lock(lock_path: Path = DEFAULT_LOCK_PATH, timeout: float | None = None):
    """Hold an exclusive advisory lock at `lock_path` for the `with` block's duration.

    Blocks until acquired if `timeout` is `None` (the default); raises
    `GPULockTimeoutError` if `timeout` elapses first.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR)
    deadline = None if timeout is None else time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if deadline is not None and time.monotonic() >= deadline:
                    raise GPULockTimeoutError(
                        f"could not acquire GPU lock {lock_path} within {timeout}s"
                    ) from None
                time.sleep(POLL_INTERVAL)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
