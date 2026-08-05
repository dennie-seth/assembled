"""Corpus manifest loader and validator.

The corpus.json file is the curation record for the T-0072 style LoRA
training set: 30–50 license-clean reference images drawn from Soviet
brutalist and constructivist architecture photography.

Checked against: 13-asset-pipeline.md §3.2
  "The style LoRA (T-0072) trains on the reference corpus in its natural
   colour ... Concept art does not train the style LoRA."
"""

from __future__ import annotations

import json
import pathlib
import re
from dataclasses import dataclass

CORPUS_MIN = 30
CORPUS_MAX = 50

# Only licenses that permit derivative works and commercial use, with
# no non-commercial (NC) restriction — this repo is public and forks
# must not be poisoned (assets.md).
ALLOWED_LICENSES = frozenset({
    "CC0",
    "CC-BY-4.0",
    "CC-BY-SA-4.0",
    # Older Commons license tags that still resolve to clean use:
    "CC-BY-SA-3.0",
    "CC-BY-3.0",
    "PD-old",
    "PD-old-70-1923",
})

_REF_ID_RE = re.compile(r"^ref_\d{3}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class Ref:
    id: str
    commons_file: str
    license: str
    attribution: str
    sha256: str | None
    curation_notes: str

    def __post_init__(self) -> None:
        if not _REF_ID_RE.match(self.id):
            raise ValueError(
                f"ref id must match ref_NNN, got {self.id!r}"
            )
        if not self.commons_file.startswith("File:"):
            raise ValueError(
                f"commons_file must start with 'File:', got {self.commons_file!r}"
            )
        if self.license not in ALLOWED_LICENSES:
            raise ValueError(
                f"license {self.license!r} not in allowed set {sorted(ALLOWED_LICENSES)}"
            )
        if not self.attribution.strip():
            raise ValueError("attribution must not be empty")
        if not self.curation_notes.strip():
            raise ValueError("curation_notes must not be empty")
        if self.sha256 is not None:
            if not _SHA256_RE.match(self.sha256):
                raise ValueError(
                    f"sha256 must be 64 lowercase hex chars or null, got {self.sha256!r}"
                )


@dataclass(frozen=True)
class Corpus:
    corpus_version: str
    selection_criteria: dict
    allowed_licenses: list
    refs: list[Ref]

    def __post_init__(self) -> None:
        if not isinstance(self.corpus_version, str):
            raise TypeError(
                f"corpus_version must be str, got {type(self.corpus_version).__name__}"
            )
        sc = self.selection_criteria
        if "prefer" not in sc or "avoid" not in sc:
            raise ValueError(
                "selection_criteria must have 'prefer' and 'avoid' keys"
            )
        target = sc.get("target_count", 0)
        if not (CORPUS_MIN <= target <= CORPUS_MAX):
            raise ValueError(
                f"selection_criteria.target_count must be {CORPUS_MIN}–{CORPUS_MAX}, got {target}"
            )
        if not (CORPUS_MIN <= len(self.refs) <= CORPUS_MAX):
            raise ValueError(
                f"refs count must be {CORPUS_MIN}–{CORPUS_MAX}, got {len(self.refs)}"
            )
        ids = [r.id for r in self.refs]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate ref ids found")


def load_corpus(path: pathlib.Path | str) -> Corpus:
    """Load and validate corpus.json."""
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    refs = [Ref(**entry) for entry in data["refs"]]
    return Corpus(
        corpus_version=data["corpus_version"],
        selection_criteria=data["selection_criteria"],
        allowed_licenses=data["allowed_licenses"],
        refs=refs,
    )
