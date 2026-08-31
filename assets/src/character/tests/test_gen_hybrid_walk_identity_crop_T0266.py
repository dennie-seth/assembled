"""IP-Adapter identity-reference crop fix (T-0266 recipe finding).

Real generation on this card (two full 8-frame attempts, logged in
`ARM_HYBRID_WALK_CHUNKING_ATTEMPT_LOG_T0266.md`) showed every frame's
adjacent-pair delta well above the 0.30 cap. Visual inspection of the raw
frames showed why: `gen_hybrid_walk_T0259.py` fed the *entire*
`player_character_concept_sheet_v1.png` -- a ~24-panel costume/turnaround
grid (T-0209) -- into `IPAdapterAdvanced` as the identity reference. Each
independently-sampled frame partially reproduced that grid's own
panel/gutter structure (a duplicated prop-like shape recurring in each
quadrant), which is what drove the frame-to-frame deltas past the cap --
not scene "clutter" in the ordinary sense.

RED: `gen_hybrid_walk_T0259.py` has no `crop_identity_reference` function
and `run_attempt` uploads `CONCEPT_SHEET_PATH` (the full 1024x1024 sheet)
directly. GREEN: a single clean front-on panel is cropped out of the sheet
before upload, and that crop -- not the full sheet -- is what
`upload_image` receives as the IP-Adapter reference.

No GPU needed: `upload_image`/`submit_prompt`/`wait_for_completion`/
`fetch_save_image` are monkeypatched exactly as
`test_gen_hybrid_walk_chunking_T0266.py` does; only the *path* passed to
`upload_image` for the concept/identity image is under test here.
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

TEST_ATTEMPT = 9002  # distinct from chunking test's 9001 and the DL-21 1..8 range


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
def fake_comfyui(monkeypatch: pytest.MonkeyPatch, uploaded_paths: list) -> None:
    def fake_upload_image(path: Path) -> str:
        uploaded_paths.append(path)
        return path.name

    monkeypatch.setattr(walk, "upload_image", fake_upload_image)
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


@pytest.fixture
def uploaded_paths() -> list:
    return []


def test_crop_identity_reference_is_smaller_than_the_full_concept_sheet(tmp_path: Path) -> None:
    dest = tmp_path / "identity_reference_crop.png"
    walk.crop_identity_reference(walk.CONCEPT_SHEET_PATH, dest)

    full = Image.open(walk.CONCEPT_SHEET_PATH)
    cropped = Image.open(dest)
    assert cropped.size != full.size
    assert cropped.size == (
        walk.IDENTITY_REFERENCE_CROP_BOX[2] - walk.IDENTITY_REFERENCE_CROP_BOX[0],
        walk.IDENTITY_REFERENCE_CROP_BOX[3] - walk.IDENTITY_REFERENCE_CROP_BOX[1],
    )


def test_run_attempt_uploads_the_cropped_reference_not_the_full_sheet(
    out_dir: Path, uploaded_paths: list
) -> None:
    walk.run_attempt(
        attempt=TEST_ATTEMPT,
        seed=1,
        controlnet_strength=1.0,
        controlnet_end=1.0,
        ipadapter_weight=0.6,
        style_lora_weight=0.70,
        identity_lora_weight=0.50,
        max_frames=1,
    )

    concept_uploads = [p for p in uploaded_paths if p.name.startswith("identity_reference")]
    assert len(concept_uploads) == 1, uploaded_paths
    uploaded = Image.open(concept_uploads[0])
    full = Image.open(walk.CONCEPT_SHEET_PATH)
    assert uploaded.size != full.size


def test_run_attempt_never_uploads_the_full_concept_sheet_path_directly(
    out_dir: Path, uploaded_paths: list
) -> None:
    walk.run_attempt(
        attempt=TEST_ATTEMPT,
        seed=1,
        controlnet_strength=1.0,
        controlnet_end=1.0,
        ipadapter_weight=0.6,
        style_lora_weight=0.70,
        identity_lora_weight=0.50,
        max_frames=1,
    )

    assert walk.CONCEPT_SHEET_PATH not in uploaded_paths
