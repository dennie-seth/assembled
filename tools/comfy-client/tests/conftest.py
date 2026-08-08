"""Shared fixtures: a controllable fake clock for poll/backoff tests, and a
minimal rendered workflow graph so client/pipeline tests don't need to
hand-build one."""

from __future__ import annotations

import pytest

from comfy_client.recipe import Recipe
from comfy_client.workflow import render_workflow


class FakeClock:
    """`now`/`sleep` pair for testing timeout+backoff logic without real waits."""

    def __init__(self, start: float = 0.0) -> None:
        self.t = start
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


@pytest.fixture
def fake_clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def sample_recipe() -> Recipe:
    return Recipe(
        prompt="a derelict signal tower, brutalist concrete",
        seed=42,
        name="signal_tower",
        # Synthetic hash for tests -- real generation requires a checkpoint_dir
        # so hash_checkpoint_file() runs against the actual file (T-0151).
        model_hash="a" * 64,
    )


@pytest.fixture
def sample_graph(sample_recipe) -> dict:
    return render_workflow(sample_recipe)
