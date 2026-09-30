"""Shared fixtures: a controllable fake clock for poll/backoff tests, and a
minimal rendered workflow graph so client/pipeline tests don't need to
hand-build one."""

from __future__ import annotations

import pytest

from comfy_client import thermal_gate
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


_PROVENANCE_HEADER = (
    "# Asset Provenance\n\n"
    "| Asset | Model | License | Prompt | Seed |\n"
    "|---|---|---|---|---|\n"
)


@pytest.fixture(autouse=True)
def _default_provenance_md(tmp_path, monkeypatch):
    """Create ASSET_PROVENANCE.md in tmp_path and patch CWD so generate() defaults to it.

    Ensures every generate() call writes provenance even when tests don't pass
    provenance_md= explicitly (T-0075: provenance is non-optional).
    """
    (tmp_path / "ASSET_PROVENANCE.md").write_text(_PROVENANCE_HEADER)
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _safe_default_thermal_reading(monkeypatch):
    """T-0422: `ComfyUIClient.submit()`'s thermal gate runs on every call by
    default (that default IS the point -- see `test_thermal_gate.py` and the
    T-0422 tests in `test_comfyui_client.py`). Left alone, the package's
    ~244 pre-existing tests -- none of which know this gate exists -- would
    each try to shell out to a real `nvidia-smi` the sandbox this suite runs
    in doesn't have, refusing every one of them (an unreadable/failing
    nvidia-smi refuses, by design). Patching only the low-level shell-out
    (not `assert_thermal_gate_open` itself, and not the real, committed
    `tools/board/ops/cooler-state.json`, which stays real and ON -- both
    exactly as safe to read for real in tests as the checkpoint allowlist
    file already is) gives every test a safe, in-ceiling reading with no
    subprocess ever spawned, the same way `_default_provenance_md` above
    gives every test a safe provenance file without each one asking for it.
    Tests that want to exercise a refusal inject their own
    cooler_state_path/temperature_reader/thermal_gate explicitly instead of
    relying on this fixture.
    """
    monkeypatch.setattr(thermal_gate, "_shell_nvidia_smi_temperature_c", lambda **_: 60.0)


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
