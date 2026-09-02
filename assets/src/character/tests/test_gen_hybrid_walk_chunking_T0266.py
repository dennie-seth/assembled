"""gen_hybrid_walk_T0259 wired to char_gen.chunked_frames (T-0266).

Proves the *wiring*, not diffusion: ComfyUI's HTTP boundary
(`upload_image`/`submit_prompt`/`wait_for_completion`/`fetch_save_image`)
is monkeypatched with fakes that write real (tiny, synthetic) PNG bytes, so
this test needs no GPU and no reachable ComfyUI host, per this card's
"Prove this with a test that does not need a GPU" acceptance criterion.

RED state: gen_hybrid_walk_T0259.run_attempt has no `max_frames` parameter
and generates all 8 frames unconditionally in one call -> this module
either fails to import (no `max_frames` kwarg) or the first `run_attempt`
call below already returns a complete provenance dict instead of `None`.
GREEN state: `run_attempt(..., max_frames=4)` generates only 4 of 8 frames
and returns `None`; a second, identical call skips those 4 and finishes
the remaining 4, returning a provenance dict for all 8 -- the same
resumability contract `char_gen.chunked_frames` itself is tested against,
now proven at the real generator's call site.
"""

from __future__ import annotations

import io
import shutil
import sys
from pathlib import Path

import pytest
from PIL import Image

_CHARACTER_DIR = Path(__file__).resolve().parents[1]
if str(_CHARACTER_DIR) not in sys.path:
    sys.path.insert(0, str(_CHARACTER_DIR))

import gen_hybrid_walk_T0259 as walk  # noqa: E402

# Comfortably above the DL-21 attempt cap (1..8) so this never collides with
# a real generation attempt's scratch directory.
TEST_ATTEMPT = 9001


def _png_bytes(size: int, rgb: tuple[int, int, int]) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (size, size), rgb).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def out_dir() -> Path:
    path = walk.REPO_ROOT / "assets" / "out" / "hybrid_walk" / f"attempt_{TEST_ATTEMPT}"
    yield path
    if path.exists():
        shutil.rmtree(path)


@pytest.fixture(autouse=True)
def fake_comfyui(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stand in for the real ComfyUI HTTP round trip -- no network, no GPU."""
    monkeypatch.setattr(walk, "upload_image", lambda path: path.name)
    monkeypatch.setattr(walk, "submit_prompt", lambda graph: f"fake-prompt-{id(graph)}")

    def fake_wait_for_completion(prompt_id: str, timeout_s: int = 300) -> dict:
        return {"prompt_id": prompt_id}

    def fake_fetch_save_image(info: dict, node_id: str) -> bytes:
        if node_id == walk.MAIN_SAVE_NODE_ID:
            return _png_bytes(walk.GEN_PX, (40, 80, 40))
        assert node_id == walk.CELL_SAVE_NODE_ID
        return _png_bytes(walk.FINAL_CELL_PX, (40, 80, 40))

    monkeypatch.setattr(walk, "wait_for_completion", fake_wait_for_completion)
    monkeypatch.setattr(walk, "fetch_save_image", fake_fetch_save_image)


def _run(max_frames: int) -> dict | None:
    return walk.run_attempt(
        attempt=TEST_ATTEMPT,
        seed=1,
        controlnet_strength=1.0,
        controlnet_end=1.0,
        ipadapter_weight=0.6,
        style_lora_weight=0.70,
        identity_lora_weight=0.50,
        max_frames=max_frames,
    )


def test_first_chunk_generates_only_max_frames_and_returns_none(out_dir: Path) -> None:
    result = _run(max_frames=4)
    assert result is None

    for i in range(4):
        assert (out_dir / f"frame_{i}_main_384.png").exists()
        assert (out_dir / f"frame_{i}_cell_48_raw.png").exists()
    for i in range(4, walk.FRAME_COUNT):
        assert not (out_dir / f"frame_{i}_main_384.png").exists()


def test_second_identical_chunk_resumes_and_completes(out_dir: Path) -> None:
    first = _run(max_frames=4)
    assert first is None

    second = _run(max_frames=4)
    assert second is not None
    assert len(second["frame_generation"]) == walk.FRAME_COUNT
    assert second["comfyui_prompt_ids"] is not None

    for i in range(walk.FRAME_COUNT):
        assert (out_dir / f"frame_{i}_main_384.png").exists()


def test_completed_frames_are_not_regenerated(
    out_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first 4 frames from chunk 1 must not be re-submitted to
    ComfyUI in chunk 2 -- that is the whole point of resuming."""
    _run(max_frames=4)

    submitted: list[str] = []
    original_submit = walk.submit_prompt

    def fake_submit(graph: dict) -> str:
        submitted.append(graph[walk.POSE_IMAGE_NODE_ID]["inputs"]["image"])
        return original_submit(graph)

    monkeypatch.setattr(walk, "submit_prompt", fake_submit)

    result = _run(max_frames=4)
    assert result is not None
    # Only the 4 remaining frames (4-7) should have gone through submit_prompt
    # this call -- their skeleton filenames all carry "frame_4".."frame_7".
    assert len(submitted) == 4


def test_full_run_in_one_chunk_when_max_frames_covers_all(out_dir: Path) -> None:
    result = _run(max_frames=walk.FRAME_COUNT)
    assert result is not None
    assert len(result["frame_generation"]) == walk.FRAME_COUNT
