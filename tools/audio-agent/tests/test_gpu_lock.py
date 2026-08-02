"""Single-GPU serialization guard -- docs/ace-step-setup.md: ComfyUI and
ACE-Step cannot both fit on this 8GB card at once."""

from __future__ import annotations

import multiprocessing
import time

import pytest

from audio_agent.gpu_lock import GPULockTimeoutError, gpu_lock


def test_gpu_lock_is_reentrant_free_after_release(tmp_path):
    lock_path = tmp_path / "gpu.lock"
    with gpu_lock(lock_path):
        pass
    with gpu_lock(lock_path):
        pass


def _hold_lock_for(lock_path, seconds):
    with gpu_lock(lock_path):
        time.sleep(seconds)


def test_gpu_lock_blocks_a_second_holder_until_the_first_releases(tmp_path):
    lock_path = tmp_path / "gpu.lock"
    holder = multiprocessing.Process(target=_hold_lock_for, args=(lock_path, 1.0))
    holder.start()
    time.sleep(0.2)  # let the holder actually acquire first

    start = time.monotonic()
    with gpu_lock(lock_path):
        elapsed = time.monotonic() - start

    holder.join()
    assert elapsed >= 0.5  # had to wait out most of the holder's 1.0s


def test_gpu_lock_raises_timeout_error_when_held_too_long(tmp_path):
    lock_path = tmp_path / "gpu.lock"
    holder = multiprocessing.Process(target=_hold_lock_for, args=(lock_path, 2.0))
    holder.start()
    time.sleep(0.2)

    try:
        with pytest.raises(GPULockTimeoutError):
            with gpu_lock(lock_path, timeout=0.3):
                pass
    finally:
        holder.join()
