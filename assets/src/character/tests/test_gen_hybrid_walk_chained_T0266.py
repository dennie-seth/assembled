"""img2img frame-chaining for the walk gait (T-0266 recipe finding, iter 3).

Two full 8-frame independent-sampling attempts (logged in
`ARM_HYBRID_WALK_CHUNKING_ATTEMPT_LOG_T0266.md`) failed the 0.30 frame-delta
cap even after the identity-reference-crop fix: every frame is its own fully
independent KSampler call, so nothing ties the background -- or even the
character's own rendered costume colours -- across frames. This is the
untried structural lever the log itself named: chain frames 1-7 to frame 0's
own decoded output via VAEEncode at denoise < 1.0 (the same
`gen_chained_idle_T0250.py` precedent, `build_chained_graph` +
`apply_background_hold`, applied here to `gen_hybrid_walk_T0259.py`'s own
build_graph instead of pose_authority's).

RED: `gen_hybrid_walk_T0259.py` has no `build_chained_graph`, no `denoise`
parameter on `run_attempt`, and every frame (including frame 1+) is
generated via a fresh `EmptyLatentImage` graph with no background hold.
GREEN: frame 0 stays a fresh independent sample; frames 1-7 are submitted as
an img2img pass anchored to frame 0's own main_384 output, and their decoded
result is background-held against frame 0 before being written to disk.

No GPU needed: the ComfyUI HTTP boundary is monkeypatched exactly as
`test_gen_hybrid_walk_chunking_T0266.py` does; only wiring (which graph shape
gets submitted, what gets uploaded, what pixels land on disk) is under test.
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

# Comfortably above the DL-21 attempt cap (1..8) and distinct from the other
# two test files' scratch attempt numbers (9001, 9002).
TEST_ATTEMPT = 9003

FRAME0_RGB = (40, 80, 40)
SAMPLED_RGB = (200, 10, 10)


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


@pytest.fixture
def submitted_graphs() -> list:
    return []


@pytest.fixture
def uploaded_paths() -> list:
    return []


@pytest.fixture(autouse=True)
def fake_comfyui(
    monkeypatch: pytest.MonkeyPatch, submitted_graphs: list, uploaded_paths: list
) -> None:
    """Distinguishable fake per-frame output: frame 0's SaveImage output is
    always FRAME0_RGB, every other submitted graph's is SAMPLED_RGB -- lets
    tests tell a chained frame's *sampled* output apart from frame 0's own
    anchor, and check what the background-hold composite did with the two.
    """
    call_count = {"n": 0}

    def fake_upload_image(path: Path) -> str:
        uploaded_paths.append(path)
        return path.name

    def fake_submit(graph: dict) -> str:
        submitted_graphs.append(graph)
        prompt_id = f"fake-prompt-{len(submitted_graphs)}"
        call_count["n"] += 1
        return prompt_id

    def fake_wait_for_completion(prompt_id: str, timeout_s: int = 300) -> dict:
        return {"prompt_id": prompt_id}

    def fake_fetch_save_image(info: dict, node_id: str) -> bytes:
        # First submitted graph is always frame 0 (frame_indices is generated
        # in order, per char_gen.chunked_frames.run_chunk).
        is_frame_zero = info["prompt_id"] == "fake-prompt-1"
        rgb = FRAME0_RGB if is_frame_zero else SAMPLED_RGB
        if node_id == walk.MAIN_SAVE_NODE_ID:
            return _png_bytes(walk.GEN_PX, rgb)
        assert node_id == walk.CELL_SAVE_NODE_ID
        return _png_bytes(walk.FINAL_CELL_PX, rgb)

    monkeypatch.setattr(walk, "upload_image", fake_upload_image)
    monkeypatch.setattr(walk, "submit_prompt", fake_submit)
    monkeypatch.setattr(walk, "wait_for_completion", fake_wait_for_completion)
    monkeypatch.setattr(walk, "fetch_save_image", fake_fetch_save_image)


def _run(max_frames: int, denoise: float = 0.45) -> dict | None:
    return walk.run_attempt(
        attempt=TEST_ATTEMPT,
        seed=1,
        controlnet_strength=1.0,
        controlnet_end=1.0,
        ipadapter_weight=0.6,
        style_lora_weight=0.70,
        identity_lora_weight=0.50,
        max_frames=max_frames,
        denoise=denoise,
    )


def test_build_chained_graph_uses_vaeencode_not_empty_latent() -> None:
    fresh = walk.build_graph(
        seed=1,
        concept_filename="concept.png",
        pose_skeleton_filename="skeleton.png",
        controlnet_strength=1.0,
        controlnet_end=1.0,
        ipadapter_weight=0.6,
        style_lora_weight=0.70,
        identity_lora_weight=0.50,
    )
    chained = walk.build_chained_graph(
        seed=1,
        concept_filename="concept.png",
        pose_skeleton_filename="skeleton.png",
        init_image_filename="frame_0_main_384.png",
        denoise=0.45,
        controlnet_strength=1.0,
        controlnet_end=1.0,
        ipadapter_weight=0.6,
        style_lora_weight=0.70,
        identity_lora_weight=0.50,
    )

    assert walk.LATENT_NODE_ID not in chained
    assert chained[walk.SAMPLER_NODE_ID]["inputs"]["latent_image"] == [
        walk.VAE_ENCODE_NODE_ID,
        0,
    ]
    assert chained[walk.SAMPLER_NODE_ID]["inputs"]["denoise"] == 0.45
    assert chained[walk.INIT_IMAGE_NODE_ID]["inputs"]["image"] == "frame_0_main_384.png"
    assert chained[walk.VAE_ENCODE_NODE_ID]["inputs"]["pixels"] == [walk.INIT_IMAGE_NODE_ID, 0]

    # Every other node (LoRA/IP-Adapter/ControlNet/prompts/checkpoint) is
    # untouched -- chaining patches only the latent source and denoise.
    for node_id in fresh:
        if node_id in (walk.LATENT_NODE_ID,):
            continue
        if node_id == walk.SAMPLER_NODE_ID:
            fresh_inputs = {k: v for k, v in fresh[node_id]["inputs"].items() if k != "denoise"}
            chained_inputs = {
                k: v
                for k, v in chained[node_id]["inputs"].items()
                if k not in ("denoise", "latent_image")
            }
            assert fresh_inputs == {**chained_inputs, "latent_image": [walk.LATENT_NODE_ID, 0]}
            continue
        assert fresh[node_id] == chained[node_id], node_id


def test_frame_zero_is_generated_fresh_not_chained(out_dir: Path, submitted_graphs: list) -> None:
    _run(max_frames=1)

    assert len(submitted_graphs) == 1
    assert walk.LATENT_NODE_ID in submitted_graphs[0]
    assert walk.VAE_ENCODE_NODE_ID not in submitted_graphs[0]


def test_frames_after_zero_are_chained_to_frame_zero(
    out_dir: Path, submitted_graphs: list, uploaded_paths: list
) -> None:
    _run(max_frames=2)

    assert len(submitted_graphs) == 2
    frame1_graph = submitted_graphs[1]
    assert walk.VAE_ENCODE_NODE_ID in frame1_graph
    assert walk.LATENT_NODE_ID not in frame1_graph

    init_filename = frame1_graph[walk.INIT_IMAGE_NODE_ID]["inputs"]["image"]
    uploaded_names = [p.name for p in uploaded_paths]
    assert init_filename in uploaded_names
    # The uploaded init image must be frame 0's own main output, not some
    # other frame's or the identity-reference crop.
    frame0_upload = [p for p in uploaded_paths if p.name == init_filename]
    assert frame0_upload and frame0_upload[0].name.startswith("frame_0_main")


def test_background_is_held_to_frame_zero_for_chained_frames(out_dir: Path) -> None:
    _run(max_frames=2)

    frame0_img = Image.open(out_dir / "frame_0_main_384.png").convert("RGB")
    frame1_img = Image.open(out_dir / "frame_1_main_384.png").convert("RGB")

    assert frame0_img.getpixel((0, 0)) == FRAME0_RGB
    # Every corner is far outside any reasonable walk-pose bounding box +
    # margin, so background-hold must force it to frame 0's own colour.
    for corner in (
        (0, 0),
        (walk.GEN_PX - 1, 0),
        (0, walk.GEN_PX - 1),
        (walk.GEN_PX - 1, walk.GEN_PX - 1),
    ):
        assert frame1_img.getpixel(corner) == FRAME0_RGB, corner

    # The raw sampled frame is preserved separately so a human/reviewer can
    # see what the model actually produced before the hold was applied.
    raw_sampled = Image.open(out_dir / "frame_1_main_384_raw_sampled.png").convert("RGB")
    assert raw_sampled.getpixel((walk.GEN_PX // 2, walk.GEN_PX // 2)) == SAMPLED_RGB


def test_provenance_records_chaining_per_frame(out_dir: Path) -> None:
    provenance = _run(max_frames=walk.FRAME_COUNT, denoise=0.45)
    assert provenance is not None

    frame0_record = provenance["frame_generation"][0]
    assert frame0_record["generation_mode"] == "fresh"
    assert frame0_record["chained_from_frame"] is None

    for record in provenance["frame_generation"][1:]:
        assert record["generation_mode"] == "img2img_chained"
        assert record["chained_from_frame"] == 0
        assert record["denoise"] == 0.45

    assert provenance["denoise"] == 0.45
    assert "img2img chain" in provenance["model"].lower()


def test_denoise_out_of_range_is_rejected(out_dir: Path) -> None:
    with pytest.raises(ValueError):
        _run(max_frames=1, denoise=0.0)
    with pytest.raises(ValueError):
        _run(max_frames=1, denoise=1.0)
