"""T-0418 acceptance: 'the T-0337 generator's behaviour is asserted, not
assumed.' This package (`infra`'s own scope) never edits
`assets/src/character/**` -- that belongs to the `assets` agent -- so this
test reaches the real generator source instead of restating it by hand:

- The exact SAM3 graph shape comes from the real, imported
  `char_gen.cutout_sam3.build_sam3_part_workflow` (lightweight: only numpy +
  Pillow + `char_gen.cutout`, already comfy-client's own dependencies --
  never a hand-rolled stand-in for that function).
- The checkpoint filename comes from parsing
  `gen_master_sheet_cutout_compare_T0337.py`'s own
  `SAM3_UNET_CHECKPOINT = "..."` line at test time, so this test tracks
  whatever the generator actually declares rather than assuming a value
  that could silently drift out of sync.

Feeds the resulting graph through `ComfyUIClient.submit()` -- the same call
the generator's `_make_sam3_runner` closure uses -- and asserts whichever
world this branch's base is actually in: `sam3.1_multiplex_fp16.safetensors`
is on the allowlist as of T-0418's own base (PR #421, `chore/approve-sam-
license-family`), so submission must succeed; if that licence approval were
ever reverted, this test documents that it must instead be refused with
`CheckpointNotAllowedError`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
import responses
from gen_client_base.license_allowlist import CheckpointNotAllowedError

from comfy_client.comfyui_client import ComfyUIClient

REPO_ROOT = Path(__file__).resolve().parents[3]
CHARACTER_SRC = REPO_ROOT / "assets" / "src" / "character" / "src"
GENERATOR_PATH = (
    REPO_ROOT / "assets" / "src" / "character" / "gen_master_sheet_cutout_compare_T0337.py"
)
BASE_URL = "http://172.18.192.1:8188"

if str(CHARACTER_SRC) not in sys.path:
    sys.path.insert(0, str(CHARACTER_SRC))

from char_gen.cutout_sam3 import build_sam3_part_workflow  # noqa: E402


def _generator_sam3_checkpoint() -> str:
    """Parses the real `SAM3_UNET_CHECKPOINT = "..."` line out of the
    generator's own source -- never hardcoded here, so a future rename of
    that constant can't silently make this test assert the wrong world."""
    text = GENERATOR_PATH.read_text()
    match = re.search(r'^SAM3_UNET_CHECKPOINT\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, "gen_master_sheet_cutout_compare_T0337.SAM3_UNET_CHECKPOINT not found"
    return match.group(1)


def _generator_shaped_graph(checkpoint: str) -> dict:
    """Mirrors `_sam3_model_loader()` (gen_master_sheet_cutout_compare_T0337.py):
    a `UNETLoader` node naming the SAM3 checkpoint, fed into the real
    `build_sam3_part_workflow` -- the same function `_make_sam3_runner`'s
    `_run` closure calls before `client.submit(workflow)`."""
    model_loader = {
        "class_type": "UNETLoader",
        "inputs": {"unet_name": checkpoint, "weight_dtype": "default"},
    }
    return build_sam3_part_workflow(
        "T0337_panel_test.png",
        model_loader,
        positive_coords=[{"x": 10, "y": 10}],
        negative_coords=[{"x": 1, "y": 1}],
        filename_prefix="T0337_sam3_test",
    )


@responses.activate
def test_t0337_generators_real_sam3_checkpoint_is_currently_allowlisted(fake_clock):
    """As of this branch's base, sam3.1_multiplex_fp16.safetensors IS on the
    allowlist (PR #421) -- so the generator's own graph must submit
    successfully through the same gated ComfyUIClient.submit() call."""
    checkpoint = _generator_sam3_checkpoint()
    assert checkpoint == "sam3.1_multiplex_fp16.safetensors", (
        "this branch's base has the SAM3.1 licence approved for this exact filename "
        "(PR #421) -- if the generator's own constant changed, re-check which world "
        "this test is in before changing the assertion below"
    )
    graph = _generator_shaped_graph(checkpoint)

    responses.add(
        responses.POST,
        f"{BASE_URL}/prompt",
        json={"prompt_id": "t0337-ok", "node_errors": {}},
        status=200,
    )
    client = ComfyUIClient(base_url=BASE_URL, sleep=fake_clock.sleep, now=fake_clock.now)
    assert client.submit(graph) == "t0337-ok"


@responses.activate
def test_t0337_shaped_graph_naming_an_unregistered_checkpoint_is_refused(fake_clock):
    """Same graph shape, a checkpoint that was never registered -- this is
    exactly what T-0337 exercised before the SAM licence family was approved,
    and exactly what the closed bypass now refuses instead of reaching
    ComfyUI. No /prompt route is registered, so a leak through would fail as
    a connection error, not a CheckpointNotAllowedError."""
    graph = _generator_shaped_graph("some_future_unregistered_sam_variant.safetensors")
    client = ComfyUIClient(base_url=BASE_URL, sleep=fake_clock.sleep, now=fake_clock.now)

    with pytest.raises(CheckpointNotAllowedError):
        client.submit(graph)
    assert responses.calls == []
