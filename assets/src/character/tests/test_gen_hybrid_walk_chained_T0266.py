"""Per-frame generation for the walk gait (T-0266's img2img chain, superseded
2026-09-08 session 5 -- T-0259).

T-0266 (iter 3) chained frames 1-7 to frame 0's own decoded output via
VAEEncode at denoise < 1.0, to solve independent sampling's frame-delta
blowout (nothing tied the background -- or the costume colours -- across
independently-sampled frames). It worked for that problem. It created a
different one: `probe_unchained_pose_T0259.py` and this card's own session-4
attempt log show the chain suppresses pose fidelity to the ControlNet
skeleton regardless of denoise (0.35, attempt 5) or IP-Adapter weight
(attempt 7) -- frame 0's own contact-pose skeleton is visibly followed, but
every chained frame stays close to frame 0's own rendered pose even when its
own skeleton (e.g. frame 2's passing/cross stance) is unambiguously
different. Session 5's own `probe_unchained_pose_T0259.py --frame 2` (fresh,
denoise 1.0, no VAEEncode, otherwise identical inputs to attempt 5) visibly
adopts the crossed-leg silhouette attempt 5's own chained frame 2 never does
-- confirming the chain, not the pose rig, was the bottleneck.

Frame-to-frame consistency (T-0266's original problem) turns out not to
depend on the chain at all: `apply_background_hold` (gen_chained_idle_T0250,
reused unchanged here) composites in PIXEL SPACE, after decode -- it forces
every background pixel to frame 0's own regardless of how the foreground was
sampled. And IP-Adapter + identity LoRA + the SAME seed already hold costume
colour consistent across independently-sampled frames (verified visually:
session 5's probe frame matches frame 0's costume colour and style).

RED (session 5): `gen_hybrid_walk_T0259.py` still builds frames 1-7 via
`build_chained_graph` (VAEEncode, denoise < 1.0), which the evidence above
shows suppresses pose motion.
GREEN: every frame (0 through 7) is generated via `build_graph` (fresh,
`EmptyLatentImage`, denoise fixed at 1.0, this frame's own skeleton) -- the
only difference from frame 0 frames 1-7 still have is that their DECODED
output is background-held (pixel space, `apply_background_hold`) against
frame 0's own decoded output before being written to disk, exactly as
before. `build_chained_graph` itself is left intact and still independently
tested below as a reusable primitive (T-0260/T-0261 or a future card may
still want a true low-denoise chain for a different motion); it is simply no
longer called by `_generate_one_frame`.

No GPU needed: the ComfyUI HTTP boundary is monkeypatched exactly as
`test_gen_hybrid_walk_chunking_T0266.py` does; only wiring (which graph shape
gets submitted, what gets uploaded, what pixels land on disk) is under test.
"""

from __future__ import annotations

import io
import json
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
    tests tell a later frame's *sampled* output apart from frame 0's own
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


def test_build_chained_graph_uses_vaeencode_not_empty_latent() -> None:
    """`build_chained_graph` itself is untouched and still correct -- it is
    simply not called from `_generate_one_frame` any more (see module
    docstring). Kept as a reusable, independently-tested primitive."""
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


def test_frame_zero_is_generated_fresh(out_dir: Path, submitted_graphs: list) -> None:
    _run(max_frames=1)

    assert len(submitted_graphs) == 1
    assert walk.LATENT_NODE_ID in submitted_graphs[0]
    assert walk.VAE_ENCODE_NODE_ID not in submitted_graphs[0]


def test_frames_after_zero_are_also_generated_fresh_not_chained(
    out_dir: Path, submitted_graphs: list, uploaded_paths: list
) -> None:
    """The core session-5 fix: frame 1 gets its own EmptyLatentImage graph,
    exactly like frame 0, not a VAEEncode of frame 0's own pixels -- so its
    own ControlNet skeleton (a different pose than frame 0's) actually gets
    to influence the sampled result."""
    _run(max_frames=2)

    assert len(submitted_graphs) == 2
    frame1_graph = submitted_graphs[1]
    assert walk.LATENT_NODE_ID in frame1_graph
    assert walk.VAE_ENCODE_NODE_ID not in frame1_graph
    assert walk.INIT_IMAGE_NODE_ID not in frame1_graph

    # frame 0's own main output is never uploaded as an init image any more
    # -- it is still read locally (for the background hold below), but never
    # sent back to ComfyUI as VAEEncode input.
    uploaded_names = [p.name for p in uploaded_paths]
    assert not any(name.startswith("frame_0_main") for name in uploaded_names)


def test_background_is_held_to_frame_zero_for_every_later_frame(out_dir: Path) -> None:
    _run(max_frames=2)

    frame0_img = Image.open(out_dir / "frame_0_main_384.png").convert("RGB")
    frame1_img = Image.open(out_dir / "frame_1_main_384.png").convert("RGB")

    assert frame0_img.getpixel((0, 0)) == FRAME0_RGB
    # Every corner is far outside any reasonable walk-pose bounding box +
    # margin, so background-hold must force it to frame 0's own colour --
    # this still holds with fresh (non-chained) per-frame sampling, since
    # apply_background_hold works in pixel space on the decoded output,
    # independent of how that output was sampled.
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


def test_provenance_records_fresh_generation_for_every_frame(out_dir: Path) -> None:
    provenance = _run(max_frames=walk.FRAME_COUNT)
    assert provenance is not None

    frame0_record = provenance["frame_generation"][0]
    assert frame0_record["generation_mode"] == "fresh"
    assert frame0_record["background_held_from_frame"] is None

    for record in provenance["frame_generation"][1:]:
        assert record["generation_mode"] == "fresh_background_held"
        assert record["background_held_from_frame"] == 0

    assert "denoise" not in provenance
    assert "chained_from_frame" not in provenance["frame_generation"][0]
    assert "background held" in provenance["model"].lower()


def test_resume_tolerates_a_pre_existing_attempt_whose_meta_predates_this_field(
    out_dir: Path,
) -> None:
    """T-0259 session 9: attempt 5's own real cached directory (the T-0266
    img2img-chain era, predating this field entirely -- its frame_1..7
    `_meta.json` files carry `chained_from_frame`/`denoise` instead) hits a
    bare `KeyError` at `run_attempt`'s per-frame provenance-record step the
    moment every frame is already complete on disk and generation is
    skipped, because that step unconditionally indexes
    `meta["background_held_from_frame"]`. A resume over ALREADY-COMPLETE
    frames must not depend on a field this card added after some of its own
    already-generated attempts were written -- see
    `char_gen.chunked_frames`'s own "skip-existing resume" contract, which
    this session's fix now actually holds for a real historical attempt."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(walk.FRAME_COUNT):
        rgb = FRAME0_RGB if i == 0 else SAMPLED_RGB
        (out_dir / f"frame_{i}_main_384.png").write_bytes(_png_bytes(walk.GEN_PX, rgb))
        (out_dir / f"frame_{i}_cell_48_raw.png").write_bytes(_png_bytes(walk.FINAL_CELL_PX, rgb))
        # The OLD (pre-T-0259-session-5) schema: no "background_held_from_frame"
        # key at all, exactly as a real attempt 5 `frame_N_meta.json` reads.
        meta = {
            "comfyui_prompt_id": f"legacy-prompt-{i}",
            "generation_seconds": 20.0,
            "generation_mode": "fresh" if i == 0 else "img2img_chained",
        }
        (out_dir / f"frame_{i}_meta.json").write_text(json.dumps(meta))

    provenance = _run(max_frames=walk.FRAME_COUNT)
    assert provenance is not None, "every frame is already complete -- must resume, not stall"
    assert provenance["frame_generation"][0]["background_held_from_frame"] is None
    for record in provenance["frame_generation"][1:]:
        assert record["background_held_from_frame"] is None


def test_resumed_sidecar_does_not_claim_fresh_generation_it_did_not_do(
    out_dir: Path,
) -> None:
    """T-0259 session 10, review 2026-09-08T17:51:36.207Z: `model_summary` and
    `method` are hardcoded strings that unconditionally assert 'every frame
    sampled fresh (EmptyLatentImage, denoise 1.0)', written with only the
    current fresh-per-frame architecture in mind. A resume over a
    pre-existing attempt whose frames actually predate that architecture
    (attempt 5's real img2img-chained frames, exercised by the previous
    test) makes that claim FALSE for the very sidecar `frame_generation`
    faithfully records as `img2img_chained` a line above -- an internally
    self-contradictory provenance record that would misdescribe its own
    generation method if ever promoted. The top-level description must
    agree with what `frame_generation` actually says happened."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(walk.FRAME_COUNT):
        rgb = FRAME0_RGB if i == 0 else SAMPLED_RGB
        (out_dir / f"frame_{i}_main_384.png").write_bytes(_png_bytes(walk.GEN_PX, rgb))
        (out_dir / f"frame_{i}_cell_48_raw.png").write_bytes(_png_bytes(walk.FINAL_CELL_PX, rgb))
        meta = {
            "comfyui_prompt_id": f"legacy-prompt-{i}",
            "generation_seconds": 20.0,
            "generation_mode": "fresh" if i == 0 else "img2img_chained",
        }
        (out_dir / f"frame_{i}_meta.json").write_text(json.dumps(meta))

    provenance = _run(max_frames=walk.FRAME_COUNT)
    assert provenance is not None

    modes = {record["generation_mode"] for record in provenance["frame_generation"]}
    assert modes == {"fresh", "img2img_chained"}, "fixture sanity: this test needs a mixed resume"

    lowered_model = provenance["model"].lower()
    lowered_method = provenance["method"].lower()
    assert "every frame sampled fresh" not in lowered_model, (
        "model summary affirmatively claims every frame was sampled fresh, but "
        "frame_generation records an img2img_chained frame"
    )
    assert "img2img_chained" in lowered_model or "img2img_chained" in lowered_method, (
        "provenance must disclose the chained frames its own frame_generation records, "
        "not just silently omit them from the human-readable summary"
    )
