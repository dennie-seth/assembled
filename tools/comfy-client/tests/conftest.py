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
def _safe_default_thermal_reading(tmp_path, monkeypatch):
    """T-0422: `ComfyUIClient.submit()`'s thermal gate runs on every call by
    default (that default IS the point -- see `test_thermal_gate.py` and the
    T-0422 tests in `test_comfyui_client.py`). Left alone, the package's
    ~244 pre-existing tests -- none of which know this gate exists -- would
    each try to shell out to a real `nvidia-smi` the sandbox this suite runs
    in doesn't have (refusing every one of them, since an unreadable/failing
    nvidia-smi refuses by design), AND would each read the real
    `~/.local/share/assembled-board/cooler-state.json` off disk on every
    submit() call (the one authoritative location as of round 2 -- round 1
    committed this file inside the repo at `tools/board/ops/cooler-state.json`,
    which no longer exists).

    Both are stubbed here: the low-level shell-out is replaced with a fixed
    in-ceiling reading, and `DEFAULT_COOLER_STATE_PATH` is repointed at a
    private tmp-path file this fixture writes as `{"cooler": "ON"}` --
    *not* the real out-of-repo file, which a pre-existing test must never
    touch (a prior review round flagged exactly this: patching only the
    shell-out left every one of the ~244 tests still reading the real
    file and passing only because that file currently happens to say ON).
    This gives every test a safe reading with no subprocess ever spawned
    and no real file ever read, the same way `_default_provenance_md`
    above gives every test a safe provenance file without each one asking
    for it. Tests that want to exercise a refusal inject their own
    cooler_state_path/temperature_reader/thermal_gate explicitly (or
    monkeypatch `DEFAULT_COOLER_STATE_PATH` again themselves, which simply
    overrides this fixture's patch for that one test) instead of relying
    on this fixture.
    """
    safe_cooler_state = tmp_path / "_autouse_safe_cooler_state.json"
    safe_cooler_state.write_text('{"cooler": "ON"}')
    monkeypatch.setattr(thermal_gate, "DEFAULT_COOLER_STATE_PATH", safe_cooler_state)
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
