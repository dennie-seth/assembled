"""Validating `.provenance.json` sidecar writer (HANDOFF §22-c, `13` §6.15).

Every generated asset carries a `<name>.provenance.json` sidecar whose
`generator` field must resolve to a committed file in the repo -- that is what
makes the asset regenerable (P-3) instead of a claim nobody can check.  The
gate that enforces it, `asset_gate.generator.check_provenance_generator_resolvable`,
resolves the field **verbatim**::

    (repo_root / provenance["generator"]).resolve().is_file()

No token splitting, no stripping of a trailing parenthetical.

**Why this module exists.** The concept-generation path
(:mod:`comfy_client.concept`) used to emit sidecars with no ``generator`` key at
all, so whoever ran it hand-added one afterwards, in prose.  T-0226 shipped::

    "assets/src/concept/_comfyui_structure_workflow.json (ComfyUI 0.29.0
     img2img+LoRA workflow, submitted via tools/board/scripts/agentCurl.js
     per T-0226)"

-- a real committed path with a sentence stapled to it.  The gate saw one
118-character "path", failed, and the card burned CI cycles on a defect that was
knowable the instant the file was written.  A sibling sheet
(``signal_tower_concept_sheet_v1``) went the other way and has no ``generator``
field at all (T-0236).

This writer removes the opportunity.  Callers pass *structured* arguments; the
writer sets ``generator`` itself from a path it has validated, and free text has
nowhere to go except ``comfyui_version`` / ``card`` / ``_generator_note`` --
the shape the canonical records already use
(``assets/final/props/signal_tower/*.provenance.json``, post-T-0221/T-0223).

**Two checks, both at write time, both fatal:**

1. *Structural* -- ``generator`` must be a bare repo-relative POSIX path.
   Whitespace, parentheses, quotes and commas are refused outright, because a
   path never needs them and prose always does.
2. *Resolvable and tracked* -- delegated to asset-gate's own predicate (so the
   rule cannot drift), plus a ``git ls-files`` check.  Git-awareness matters in
   both directions: a **staged but not yet committed** recipe counts (it will be
   in the PR), while a file merely sitting **untracked** on disk does not -- that
   one passes a local `is_file()` and then fails on CI's clean checkout, which is
   precisely the trap this module exists to spring early.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Sequence
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

try:
    from asset_gate.generator import check_provenance_generator_resolvable
except ImportError as _exc:  # pragma: no cover - environment wiring, not logic
    # Deliberately imported rather than restated: sharing asset-gate's predicate is
    # what stops the writer and the CI gate drifting apart. asset_gate.generator
    # itself pulls in only json + pathlib, so this costs nothing at runtime -- but
    # the package still has to be importable, and a bare ModuleNotFoundError here
    # would be a confusing way to find that out mid-generation.
    raise ImportError(
        "comfy_client.provenance_sidecar needs the sibling asset-gate package: it reuses "
        "asset_gate.generator.check_provenance_generator_resolvable so the provenance writer "
        "and the CI resolvability gate cannot diverge.\n"
        "Install it with:  pip install -e tools/asset-gate\n"
        "(pytest runs already resolve it via the pythonpath entry in "
        "tools/comfy-client/pyproject.toml.)"
    ) from _exc

#: A bare repo-relative POSIX path: alphanumerics, dot, underscore, dash, slash.
#: Deliberately strict -- anything a real recipe path needs, and nothing prose
#: needs.  Leading slash (absolute) and leading dash are excluded by the anchor.
_BARE_REPO_PATH_RE = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_.\-/]*$")

#: The one key the writer owns outright.  A record carrying its own `generator`
#: cannot override the validated value -- otherwise free text would just move one
#: level down and reappear in the gated field.  `comfyui_version` / `card` /
#: `_generator_note` are ordinary record fields on some shapes (e.g.
#: CutoutProvenanceRecord pins comfyui_version), so those are kept and merely
#: overridden when the corresponding keyword argument is supplied.
_WRITER_OWNED_KEYS = ("generator",)


class GeneratorFieldError(ValueError):
    """`generator` is not a bare repo-relative path (free text, absolute, traversal)."""


class GeneratorNotCommittedError(ValueError):
    """`generator` is a well-formed path that the repo does not have as a tracked file."""


def _discover_repo_root(start: Path) -> Path:
    """`git rev-parse --show-toplevel`, probed from the nearest existing ancestor.

    Walks up rather than creating directories: discovery must not have side
    effects, and the sidecar path handed to the writer routinely names a
    directory that does not exist yet.
    """
    probe = start if start.is_dir() else start.parent
    while not probe.is_dir() and probe != probe.parent:
        probe = probe.parent
    try:
        out = subprocess.run(
            ["git", "-C", str(probe), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise GeneratorNotCommittedError(
            f"cannot locate a git repository from {probe} -- provenance is only "
            "meaningful inside the repo whose files the gate resolves against"
        ) from exc
    return Path(out.stdout.strip())


def package_repo_root() -> Path:
    """git toplevel of the repo that contains *this module*.

    The generation paths record generators like
    ``tools/comfy-client/src/comfy_client/concept.py`` -- paths relative to the
    assembled repo root, not to wherever the caller happens to be writing its
    output (``out_dir`` is routinely a scratch or tmp directory outside the
    repo).  Resolving against this package own repo is what makes validation
    meaningful from those call sites.
    """
    return _discover_repo_root(Path(__file__).resolve().parent)


def _is_tracked(repo_root: Path, rel_path: str) -> bool:
    """True if git has *rel_path* in the index -- committed OR freshly staged.

    `git ls-files` reads the index, so a recipe `git add`-ed during this same
    run counts: it is going to be in the PR, which is all the gate needs.  An
    untracked file is excluded on purpose (see module docstring).
    """
    result = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "--error-unmatch", "--", rel_path],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def validate_generator_field(generator: Any, repo_root: Path | str | None = None) -> str:
    """Validate a `generator` value, returning it unchanged if it is acceptable.

    Args:
        generator: the candidate value.  Must be a bare repo-relative POSIX
            path to a git-tracked file.
        repo_root: repository root.  Defaults to the git toplevel of the CWD.

    Returns:
        The validated path string.

    Raises:
        TypeError: *generator* is not a string.
        GeneratorFieldError: it is not a bare repo-relative path -- the T-0226
            free-text case.
        GeneratorNotCommittedError: it is a well-formed path, but the repo has
            no tracked file there.
    """
    if not isinstance(generator, str):
        raise TypeError(
            f"generator must be a string repo-relative path, got {type(generator).__name__} "
            f"({generator!r})"
        )

    if not generator:
        raise GeneratorFieldError(
            "generator is empty -- it must be a bare repo-relative path to the committed "
            "script or workflow that produced this asset (HANDOFF §22-c)"
        )

    if not _BARE_REPO_PATH_RE.match(generator) or ".." in Path(generator).parts:
        raise GeneratorFieldError(
            f"generator must be a BARE repo-relative path, got {generator!r}.\n"
            "The P-7 gate (asset_gate.generator) resolves this field verbatim as a path -- "
            "it does not strip a trailing parenthetical or split on whitespace, so any prose "
            "appended here makes the whole string an unresolvable path (this is the T-0226 "
            "failure).\n"
            "Put the ComfyUI version in comfyui_version=, the card id in card=, and any other "
            "detail in note= (written as _generator_note)."
        )

    root = Path(repo_root) if repo_root is not None else _discover_repo_root(Path.cwd())

    # Same predicate the CI gate applies, imported rather than restated so the two
    # cannot drift apart.
    resolvable = check_provenance_generator_resolvable({"generator": generator}, root)
    if not resolvable.passed:
        raise GeneratorNotCommittedError(
            f"recipe not found: {resolvable.reason}\n"
            f"Commit {generator} before recording provenance for an asset that claims it."
        )

    if not _is_tracked(root, generator):
        raise GeneratorNotCommittedError(
            f"recipe not committed: {generator} exists on disk but git is not tracking it.\n"
            f"CI resolves this field against a clean checkout, where an untracked file does not "
            f"exist at all -- the gate would fail there while passing here.\n"
            f"Run: git add {generator}   (staged is enough; it does not need to be committed yet)"
        )

    return generator


def write_provenance_sidecar(
    sidecar_path: Path | str,
    record: Any,
    *,
    generator: str,
    repo_root: Path | str | None = None,
    comfyui_version: str | None = None,
    card: str | None = None,
    note: str | None = None,
    extra: dict | None = None,
) -> dict:
    """Write a `.provenance.json` sidecar with a validated, structural `generator`.

    The generation facts come from *record*; the fields this writer owns are
    passed separately and typed, so prose cannot end up concatenated into
    ``generator``.  Validation happens **before** anything is written, so a bad
    generator leaves no half-valid sidecar behind.

    Args:
        sidecar_path: where to write (``<name>.provenance.json``).
        record: dataclass or dict of generation facts (model, seed, prompt,
            hashes, ...).  Any ``generator``/``comfyui_version``/``card``/
            ``_generator_note`` key it carries is ignored in favour of the
            keyword arguments below.
        generator: bare repo-relative path to the committed script or workflow
            that produced the asset.  Validated by
            :func:`validate_generator_field`.
        repo_root: repository root; defaults to the git toplevel of
            *sidecar_path*.
        comfyui_version: e.g. ``"0.29.0"`` -- its own field, never appended to
            ``generator``.
        card: originating card id, e.g. ``"T-0226"``.
        note: freeform prose.  Written as ``_generator_note``.  This is the
            only place free text is allowed to go.
        extra: additional structured fields to merge in.

    Returns:
        The dict that was written.

    Raises:
        GeneratorFieldError / GeneratorNotCommittedError: see
            :func:`validate_generator_field`.  Nothing is written in either case.
    """
    out_path = Path(sidecar_path)
    root = Path(repo_root) if repo_root is not None else _discover_repo_root(out_path)

    # Validate first: a rejected generator must not leave a partial file on disk.
    validated = validate_generator_field(generator, repo_root=root)

    if is_dataclass(record) and not isinstance(record, type):
        payload: dict = asdict(record)
    elif isinstance(record, dict):
        payload = dict(record)
    else:
        raise TypeError(
            f"record must be a dataclass instance or a dict, got {type(record).__name__}"
        )

    for key in _WRITER_OWNED_KEYS:
        payload.pop(key, None)

    if extra:
        payload.update(extra)

    payload["generator"] = validated
    if comfyui_version is not None:
        payload["comfyui_version"] = comfyui_version
    if card is not None:
        payload["card"] = card
    if note is not None:
        payload["_generator_note"] = note

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    return payload


#: Arm C's own measured frame-delta range (T-0230, deterministic seeded
#: script) -- the tightest silhouette-delta result this pipeline has ever
#: produced. `docs/board-invariants.md` CHR-1 (DL-25, PR #287) requires every
#: character-generation output to record both its own frame-delta and a
#: comparison against this pair; CHR-2 clarifies the comparison is recorded,
#: not deciding -- the shipped winning arm (§24-e, T-0252) does not itself
#: beat it. Before T-0258 this pair was hardcoded independently in
#: `gen_hybrid_idle_T0252.py` and `gen_pose_authority_idle_T0249.py`
#: (`gen_chained_idle_T0250.py` re-exported the latter) -- one shared home,
#: imported everywhere, is the point of this module gaining it.
ARM_C_BENCHMARK = (0.072, 0.112)

#: The three CHR-1 fields `apply_arm_c_benchmark_fields` owns outright, same
#: idiom as `_WRITER_OWNED_KEYS` above: a record's own values for these keys
#: are discarded, not merged, so a caller cannot pass `beats_arm_c_benchmark
#: =True` for a sheet whose measured ratios do not actually clear the bound.
_ARM_C_BENCHMARK_OWNED_KEYS = ("frame_delta_range", "arm_c_benchmark", "beats_arm_c_benchmark")


def apply_arm_c_benchmark_fields(record: dict, ratios: Sequence[float]) -> dict:
    """Derive and attach CHR-1's frame-delta + Arm-C benchmark fields.

    Callers pass the measured per-adjacent-frame silhouette-delta ratios
    (one `asset_gate.art.check_frame_consistency` result's ``ratio`` per
    adjacent-cell pair of a character sheet); this derives and sets:

    - ``frame_delta_range``: ``[min(ratios), max(ratios)]``
    - ``arm_c_benchmark``: the shared benchmark pair as a list (JSON has no
      tuple type)
    - ``beats_arm_c_benchmark``: whether the worst (max) ratio clears Arm
      C's upper bound -- always derived from *ratios*, never trusted from
      *record* (see ``_ARM_C_BENCHMARK_OWNED_KEYS``)

    Args:
        record: a dict to extend -- a provenance record in progress, or a
            plain dict of gate results a caller merges into one later. Not
            mutated; a new dict is returned.
        ratios: the measured frame-delta ratios this sheet's own adjacent
            frames produced. Must be non-empty.

    Returns:
        A new dict: *record* with the three owned keys set from *ratios*.

    Raises:
        ValueError: *ratios* is empty -- there is nothing to derive a range
            or a comparison from.
    """
    if not ratios:
        raise ValueError(
            "ratios must be non-empty -- CHR-1's frame-delta range has nothing to derive from"
        )

    payload = dict(record)
    for key in _ARM_C_BENCHMARK_OWNED_KEYS:
        payload.pop(key, None)

    payload["frame_delta_range"] = [min(ratios), max(ratios)]
    payload["arm_c_benchmark"] = list(ARM_C_BENCHMARK)
    payload["beats_arm_c_benchmark"] = max(ratios) <= ARM_C_BENCHMARK[1]
    return payload
