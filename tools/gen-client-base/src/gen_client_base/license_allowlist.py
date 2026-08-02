"""Enforced generation-model license allowlist (.claude/rules/assets.md).

Extracted from `tools/comfy-client` (T-0071) so both `comfy_client.pipeline`
(ComfyUI checkpoints) and `audio_agent.pipeline` (ACE-Step, T-0082) enforce
the same guardrail from the same config file, `config/checkpoint_allowlist.json`
in this package. Not a convention: each pipeline's `generate()` calls
`assert_checkpoint_allowed` before ever constructing a request, so a
disallowed checkpoint/model cannot reach a generation backend regardless of
caller.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# .claude/rules/assets.md: "generated assets only from Apache-2.0 / OpenRAIL /
# CC0-derived models" -- no CC-BY-NC weights, ever.
#
# "Stability-Community" is an approved-with-caveat fourth family, added for
# `stabilityai/stable-audio-open-1.0` (T-0081): the Stability AI Community
# License is free for orgs under $1M annual revenue, but is NOT one of the
# plain Apache-2.0/OpenRAIL/CC0 tier above -- if the project's revenue model
# ever crosses that threshold, Stability registration/commercial licensing
# is required for continued use (docs/stable-audio-setup.md). Still
# categorically excludes CC-BY-NC (MusicGen, AudioGen, etc.), which has no
# such compliance path at any revenue level.
APPROVED_LICENSE_FAMILIES = {"Apache-2.0", "OpenRAIL", "CC0", "Stability-Community"}

DEFAULT_ALLOWLIST_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "checkpoint_allowlist.json"
)


class CheckpointNotAllowedError(RuntimeError):
    """A recipe's checkpoint/model isn't on the approved-license allowlist."""


@dataclass(frozen=True)
class CheckpointEntry:
    filename: str
    license: str
    license_family: str


def load_allowlist(path: str | Path = DEFAULT_ALLOWLIST_PATH) -> dict[str, CheckpointEntry]:
    data = json.loads(Path(path).read_text())
    return {
        item["filename"]: CheckpointEntry(
            filename=item["filename"],
            license=item["license"],
            license_family=item["license_family"],
        )
        for item in data["checkpoints"]
    }


def assert_checkpoint_allowed(
    checkpoint: str, allowlist: dict[str, CheckpointEntry] | None = None
) -> CheckpointEntry:
    """Return the checkpoint's allowlist entry, or raise `CheckpointNotAllowedError`."""
    resolved = load_allowlist() if allowlist is None else allowlist
    entry = resolved.get(checkpoint)
    if entry is None:
        raise CheckpointNotAllowedError(
            f"checkpoint {checkpoint!r} is not on the approved allowlist "
            f"({DEFAULT_ALLOWLIST_PATH})"
        )
    if entry.license_family not in APPROVED_LICENSE_FAMILIES:
        raise CheckpointNotAllowedError(
            f"checkpoint {checkpoint!r} has license family {entry.license_family!r}, "
            f"not one of the approved families {sorted(APPROVED_LICENSE_FAMILIES)}"
        )
    return entry
