"""CHR-1 enforcement: the character asset-gate (T-0258, docs/board-invariants.md CHR-1).

CHR-1 (DL-25, PR #287) requires every character-generation output to record
both its own frame-delta measurement (``frame_delta_range``) and its
comparison against the Arm-C benchmark (``arm_c_benchmark`` +
``beats_arm_c_benchmark``) in its provenance sidecar. Before this module that
was convention only -- CHR-1's own coverage cell said so, and a new
character-sheet generator could drop the fields silently. This is the
enforcement half; ``comfy_client.provenance_sidecar.apply_arm_c_benchmark_fields``
is the write half that guarantees the fields go in together, correctly
derived -- this gate catches anything that lands without it, from any writer.

**Scope.** CHR-1 only applies to the ``character`` asset class -- classified
the same way ``transparency.asset_class`` does, by top-level directory under
``assets/final/``. Props, tiles, concept sheets, and entity sheets (their own
top-level class, ``assets/final/entity/``) are explicitly out of scope and
must never fail this gate; ``sweep_character_arm_c_provenance`` reports them
as passing, skipped, without even opening them.

**CHR-2 (recorded, not deciding).** ``beats_arm_c_benchmark`` records whether
a sheet's frame-delta beat Arm C's own benchmark, not whether the sheet is
acceptable -- the shipped winning arm (§24-e, T-0252) is itself ``false``.
``check_character_arm_c_provenance`` only asserts the fields are *present
and well-formed*; it never fails a sheet for ``beats_arm_c_benchmark: false``.

**Backfill (T-0258 item 5, option (b)).** 15 character sidecars predate
CHR-1 and are not backfilled by this card -- a frame-delta that was never
measured must not be invented. They are listed in
``character_arm_c_baseline.txt``, the same baseline-exemption idiom
``generator_baseline.txt``/``provenance_baseline.txt``/``transparency_baseline.txt``
already use. That list is expected to shrink to zero as each sheet is
regenerated or has its CHR-1 fields genuinely backfilled by a dedicated card
-- never by adding a new exemption for a new output.
"""

from __future__ import annotations

import json
import numbers
from pathlib import Path

from asset_gate.result import CheckResult

_MISSING = object()
_BASELINE_FILENAME = "character_arm_c_baseline.txt"

#: The asset class this gate applies to -- see the module docstring's Scope
#: section. Everything else is reported as passing, skipped.
CHARACTER_CLASS = "character"


def asset_class(relative_path: Path | str) -> str:
    """The top-level asset class of a path relative to `assets/final/`.

    Mirrors `transparency.asset_class` exactly -- same classification rule,
    kept here rather than imported so this module has no import-time
    dependency on `transparency`'s own (unrelated) scope list.
    """
    parts = Path(relative_path).parts
    return parts[0] if len(parts) > 1 else ""


def _is_well_formed_range(value: object) -> bool:
    """A 2-element numeric sequence, lo <= hi. `bool` is excluded even
    though it subclasses `int` in Python -- a range built from booleans is
    never a real measurement."""
    if not isinstance(value, list | tuple) or len(value) != 2:
        return False
    lo, hi = value
    if isinstance(lo, bool) or isinstance(hi, bool):
        return False
    if not isinstance(lo, numbers.Real) or not isinstance(hi, numbers.Real):
        return False
    return lo <= hi


def check_character_arm_c_provenance(provenance: dict, sheet_name: str = "<sheet>") -> CheckResult:
    """Fail if `frame_delta_range` or the Arm-C comparison fields are absent
    or malformed on a character-class provenance record.

    Checks presence and shape only -- never the derived verdict (CHR-2). A
    sheet whose `beats_arm_c_benchmark` is `False` still passes; only a
    missing or malformed field fails it.

    Args:
        provenance: dict loaded from a `.provenance.json` sidecar.
        sheet_name: identifies the sheet in the failure message (typically
            its path relative to some root) -- callers doing a one-off check
            outside a sweep may leave this as the default.

    Returns:
        `CheckResult` with `passed=True` iff `frame_delta_range`,
        `arm_c_benchmark` and `beats_arm_c_benchmark` are all present and
        well-formed.
    """
    missing: list[str] = []

    frame_delta_range = provenance.get("frame_delta_range", _MISSING)
    if frame_delta_range is _MISSING or not _is_well_formed_range(frame_delta_range):
        missing.append("frame_delta_range")

    arm_c_benchmark = provenance.get("arm_c_benchmark", _MISSING)
    if arm_c_benchmark is _MISSING or not _is_well_formed_range(arm_c_benchmark):
        missing.append("arm_c_benchmark")

    beats_arm_c_benchmark = provenance.get("beats_arm_c_benchmark", _MISSING)
    if beats_arm_c_benchmark is _MISSING or not isinstance(beats_arm_c_benchmark, bool):
        missing.append("beats_arm_c_benchmark")

    if missing:
        return CheckResult(
            check="character_arm_c_provenance",
            passed=False,
            reason=(
                f"{sheet_name} is missing or has a malformed CHR-1 field(s): "
                f"{', '.join(missing)} -- every character-generation output must record both "
                "its frame-delta and its Arm-C benchmark comparison "
                "(docs/board-invariants.md CHR-1)"
            ),
            details={"missing": missing},
        )

    return CheckResult(
        check="character_arm_c_provenance",
        passed=True,
        reason=f"{sheet_name}: frame_delta_range + Arm-C benchmark comparison both recorded",
        details={
            "frame_delta_range": frame_delta_range,
            "arm_c_benchmark": arm_c_benchmark,
            "beats_arm_c_benchmark": beats_arm_c_benchmark,
        },
    )


def _default_baseline_path() -> Path:
    return Path(__file__).parent / _BASELINE_FILENAME


def load_character_arm_c_baseline(path: Path | str | None = None) -> frozenset[str]:
    """Load the set of documented pre-existing CHR-1 gaps (T-0258 item 5,
    option (b)) -- character sidecars committed before CHR-1 existed, not
    backfilled here.  `sweep_character_arm_c_provenance` exempts exactly
    these paths; anything not listed here still fails the gate.
    """
    baseline_path = Path(path) if path is not None else _default_baseline_path()
    if not baseline_path.is_file():
        return frozenset()
    return frozenset(
        line.strip()
        for line in baseline_path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    )


def sweep_character_arm_c_provenance(
    root: Path | str, baseline: frozenset[str] = frozenset()
) -> list[CheckResult]:
    """Run `check_character_arm_c_provenance` against every `*.provenance.json`
    under *root*, scoped to the `character` asset class (CHR-1's own scope).

    Writer-agnostic, same shape as the other sweeps in this package: reads
    the sidecars that actually landed in the repo, so a gap in any writer is
    caught here regardless of which script produced it.

    Args:
        root: directory to search recursively (e.g. `assets/final`). Asset
            class is read from each sidecar's path relative to *root* --
            pass a root whose immediate subdirectories are the asset
            classes (`character/`, `props/`, `tiles/`, ...), not a directory
            already scoped to `character/` itself.
        baseline: paths (relative to *root*, forward-slashed) allowed to
            keep failing -- documented pre-existing gaps (see
            `load_character_arm_c_baseline`). Anything not in *baseline*
            must pass.
    """
    root_path = Path(root)
    results = []
    for path in sorted(root_path.rglob("*.provenance.json")):
        rel = path.relative_to(root_path)
        rel_str = rel.as_posix()
        cls = asset_class(rel)

        if cls != CHARACTER_CLASS:
            results.append(
                CheckResult(
                    check="character_arm_c_provenance",
                    passed=True,
                    reason=(
                        f"{rel_str}: asset class {cls!r} is not character -- CHR-1 does not apply"
                    ),
                    details={"path": rel_str, "asset_class": cls, "skipped": True},
                )
            )
            continue

        provenance = json.loads(path.read_text())
        single = check_character_arm_c_provenance(provenance, sheet_name=rel_str)

        if not single.passed and rel_str in baseline:
            results.append(
                CheckResult(
                    check="character_arm_c_provenance",
                    passed=True,
                    reason=f"{single.reason} [baseline-exempt: predates CHR-1, T-0258]",
                    details={**single.details, "path": rel_str, "baseline_exempt": True},
                )
            )
            continue

        results.append(
            CheckResult(
                check="character_arm_c_provenance",
                passed=single.passed,
                reason=single.reason,
                details={**single.details, "path": rel_str},
            )
        )
    return results
