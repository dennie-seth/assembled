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


def test_provenance_records_motion_class_for_chr1_cap_selection(out_dir: Path) -> None:
    """T-0271/DL-26: this sheet is a walk cycle -- locomotion, not idle --
    and `asset_gate.character.check_character_frame_delta_cap` reads
    `motion_class` from the *sidecar itself*, not from this script's
    in-memory `MOTION_CLASS` constant, to pick which frame-delta cap a
    promoted sheet is graded against. `run_attempt` already computes
    `arm_c_fields["motion_class"]` via `apply_arm_c_benchmark_fields` to get
    `MAX_FRAME_DELTA_RATIO` right internally, but was dropping it before it
    ever reached the returned/written provenance dict -- so a future
    promoted sheet would silently fall back to the stricter idle cap (0.30)
    for a lost field, not because it was genuinely unclassified."""
    result = _run(max_frames=walk.FRAME_COUNT)
    assert result is not None
    assert result["motion_class"] == walk.MOTION_CLASS == "locomotion"


def test_run_attempt_uses_blend_background_correction_for_identity_reference(
    out_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T-0259 2026-09-08 probe finding: T-0319's hard-fill correction on the
    IDENTITY REFERENCE crop specifically destabilises IP-Adapter into
    incoherent output (attempts 3-4), while a partial alpha-blend toward
    the same fill stays coherent (blend_0.5/0.8) and gets darker than doing
    nothing at all (bypass, attempts 5-9's own regime, which stayed under
    the background-fraction floor). `run_attempt` must select the blend
    correction via `crop_identity_reference`'s new `background_correction`
    keyword -- not the old hard_fill default, and not "none" -- and record
    which correction it used in the returned provenance."""
    calls: list[str | None] = []
    original = walk.crop_identity_reference

    def spy(concept_sheet_path, dest_path, **kwargs):
        calls.append(kwargs.get("background_correction"))
        return original(concept_sheet_path, dest_path, **kwargs)

    monkeypatch.setattr(walk, "crop_identity_reference", spy)

    result = _run(max_frames=walk.FRAME_COUNT)
    assert result is not None
    assert calls == ["blend_0.5"]
    assert result["identity_reference_background_correction"] == "blend_0.5"


def test_walk_negative_prompt_extends_idle_negative_without_editing_it() -> None:
    """T-0259: every real attempt (5-9) shows chromatic-fringe/channel-
    misalignment/glow artifacting the idle recipe's shared negative prompt
    has no term for -- it was never a problem for a static idle pose. The
    walk recipe's own negative prompt must be a strict, additive extension
    of the idle one (never an edit of the shared constant in place, which
    would risk regressing the idle sheet's own already-shipped recipe)."""
    from gen_pose_authority_idle_T0249 import MAIN_NEGATIVE as idle_negative

    assert walk.WALK_NEGATIVE.startswith(idle_negative)
    assert walk.WALK_NEGATIVE != idle_negative
    for term in ("chromatic aberration", "glow", "halo"):
        assert term in walk.WALK_NEGATIVE


def test_walk_negative_prompt_excludes_decorative_frame_borders() -> None:
    """2026-09-08 session-6 finding: every real unchained attempt (5-9) has a
    literal black-and-white decorative frame/border rendered around the
    composition -- confirmed by sampling attempt 7 frame 0's own border
    pixels directly ([0, 0, 0] and [255, 255, 255] both present at
    meaningful frequency alongside the intended mid-grey panel tone). That
    border poisons `char_gen.cutout.border_flood_background_mask`: its
    near-black representative is, by absolute Oklab distance, indistinguishable
    from this character's own near-black outline stroke colour, so the
    border-connected flood walks straight through the (fully connected)
    outline network into the character's interior -- sweeping entire limbs
    to background regardless of the keypoints hint (measured: attempt 7
    frame 0 retains only 19.3% foreground at 384px with the outline gone,
    down further to 9% if the border is additionally hard-filled first,
    since the character's own dark green torso then also collides with a
    forced near-black fill). No keypoints-hint recalibration can fix a
    defect at the flood-classification stage, upstream of any hint use.
    Never a term the idle recipe needed (a static portrait framing rarely
    renders a decorative border); additive-only, like the other WALK-specific
    terms above."""
    for term in ("picture frame", "border", "vignette", "framed photo"):
        assert term in walk.WALK_NEGATIVE
