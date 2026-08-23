"""Generator resolvability check (T-0219).

Validates that every ``*.provenance.json`` sidecar's ``generator`` field
resolves to an existing committed file within the repo tree.

Implements ``13-asset-pipeline.md`` §6.15 (HANDOFF §22-c): a ``generator``
string that names a process, script, or ComfyUI node-chain that doesn't exist
as a committed file in the repo makes the asset effectively unregeneraable,
circumventing P-3 ("the recipe is the artifact / anything regenerable is not
committed") and P-1 (ships-as-is / reject hand-edits).

The resolution rule is intentionally strict: ``generator`` must be a
repo-relative path (forward-slashes) to a committed file -- a Python script,
JS module, or ComfyUI workflow ``.json``.  Free-text descriptions
(e.g. ``"ComfyUI 0.29.0 via T-0215 (SolidMask + JoinImageWithAlpha)"``)
are not machine-checkable and therefore fail, because there is no way to
verify that the named process can actually be re-run.
"""

from __future__ import annotations

import json
from pathlib import Path

from asset_gate.result import CheckResult

_MISSING = object()
_GENERATOR_BASELINE_FILENAME = "generator_baseline.txt"


def check_provenance_generator_resolvable(provenance: dict, repo_root: Path) -> CheckResult:
    """Fail if ``generator`` is absent, empty, or doesn't resolve to a repo file.

    ``generator`` must be a repo-relative path (e.g.
    ``"assets/src/workflows/gen_props.json"``) that exists as a committed
    file under ``repo_root``.  Free-text strings like
    ``"ComfyUI 0.29.0 via T-0215 (SolidMask + JoinImageWithAlpha)"`` fail
    because ``SolidMask`` and ``JoinImageWithAlpha`` are not committed files
    anywhere in the repo.

    Args:
        provenance: dict loaded from a ``.provenance.json`` sidecar.
        repo_root: absolute ``Path`` to the repository root -- used to
            resolve the ``generator`` field as a file path.

    Returns:
        ``CheckResult`` with ``passed=True`` iff ``generator`` is a
        non-empty string that resolves to an existing file under
        ``repo_root``.
    """
    generator = provenance.get("generator", _MISSING)

    if generator is _MISSING:
        return CheckResult(
            check="provenance_generator_resolvable",
            passed=False,
            reason=(
                "generator field is missing -- asset recipe is not traceable to a committed "
                "path; add a repo-relative path to the script/workflow that produced this "
                "asset (HANDOFF §22-c)"
            ),
            details={"present": False},
        )

    if not generator:
        return CheckResult(
            check="provenance_generator_resolvable",
            passed=False,
            reason="generator field is null or empty (HANDOFF §22-c)",
            details={"generator": generator},
        )

    resolved = (Path(repo_root) / generator).resolve()
    try:
        resolved.relative_to(Path(repo_root).resolve())
    except ValueError:
        return CheckResult(
            check="provenance_generator_resolvable",
            passed=False,
            reason=f"generator '{generator}' escapes the repo tree (path traversal)",
            details={"generator": generator},
        )

    if not resolved.is_file():
        return CheckResult(
            check="provenance_generator_resolvable",
            passed=False,
            reason=(
                f"generator '{generator}' does not resolve to a committed file in the repo "
                "(HANDOFF §22-c)"
            ),
            details={"generator": generator},
        )

    return CheckResult(
        check="provenance_generator_resolvable",
        passed=True,
        reason=f"generator resolves to an existing repo file: {generator}",
        details={"generator": generator},
    )


def _default_generator_baseline_path() -> Path:
    return Path(__file__).parent / _GENERATOR_BASELINE_FILENAME


def load_generator_baseline(path: Path | str | None = None) -> frozenset[str]:
    """Load the set of documented pre-existing generator-gap paths (HANDOFF §22-c).

    These are already-audited files that were committed before the
    ``generator`` field requirement existed.  They are tracked for proper
    remediation in follow-up cards rather than fixed here.
    ``sweep_provenance_generator_resolvable`` exempts exactly these paths so
    the gate is mergeable today while still failing on new violations and on
    the 5 signal_tower props (which are NOT in the baseline -- they are the
    motivating failure case).
    """
    baseline_path = Path(path) if path is not None else _default_generator_baseline_path()
    if not baseline_path.exists():
        return frozenset()
    return frozenset(
        line.strip()
        for line in baseline_path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    )


def sweep_provenance_generator_resolvable(
    root: Path | str,
    repo_root: Path | str,
    baseline: frozenset[str] = frozenset(),
) -> list[CheckResult]:
    """Run ``check_provenance_generator_resolvable`` against every
    ``*.provenance.json`` under *root*, recursively.

    Writer-agnostic: reads the sidecars that actually landed in the repo, so
    a gap in any writer (ComfyUI pipeline, synth fallback, standalone script)
    is caught here regardless of how the file was produced.

    Args:
        root: directory to search recursively (e.g. ``assets/``).
        repo_root: repository root used to resolve ``generator`` paths.
        baseline: set of paths (relative to *root*, forward-slashed) that are
            allowed to keep failing -- documented pre-existing gaps.  Anything
            not in *baseline* must pass.  The 5 signal_tower props must never
            be added to this baseline (HANDOFF §22-c).
    """
    results = []
    for path in sorted(Path(root).rglob("*.provenance.json")):
        provenance = json.loads(path.read_text())
        single = check_provenance_generator_resolvable(provenance, Path(repo_root))
        rel = path.relative_to(root) if path.is_relative_to(root) else path
        rel_str = str(rel).replace("\\", "/")

        if not single.passed and rel_str in baseline:
            results.append(
                CheckResult(
                    check="provenance_generator_resolvable",
                    passed=True,
                    reason=(
                        f"{rel}: {single.reason} "
                        "[baseline-exempt: documented pre-existing gap, HANDOFF §22-c]"
                    ),
                    details={**single.details, "path": rel_str, "baseline_exempt": True},
                )
            )
            continue

        results.append(
            CheckResult(
                check="provenance_generator_resolvable",
                passed=single.passed,
                reason=f"{rel}: {single.reason}",
                details={**single.details, "path": rel_str},
            )
        )
    return results
