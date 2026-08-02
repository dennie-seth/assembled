"""Enforced checkpoint license allowlist (T-0071 acceptance, .claude/rules/assets.md).

Not a convention: `pipeline.generate` (comfy_client.pipeline) calls
`assert_checkpoint_allowed` before ever constructing a workflow, so a
disallowed checkpoint cannot reach ComfyUI regardless of caller.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# .claude/rules/assets.md: "generated assets only from Apache-2.0 / OpenRAIL /
# CC0-derived models" -- no CC-BY-NC weights, ever.
APPROVED_LICENSE_FAMILIES = {"Apache-2.0", "OpenRAIL", "CC0"}

DEFAULT_ALLOWLIST_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "checkpoint_allowlist.json"
)


class CheckpointNotAllowedError(RuntimeError):
    """A recipe's checkpoint isn't on the approved-license allowlist."""


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
