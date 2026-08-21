"""Provenance validation checks (T-0151).

Validates provenance sidecar JSON against the requirements in PLAN.md §0
and `.claude/rules/conduct.md`: every generated asset must have model +
license + prompt + seed, and (T-0151) a non-null `model_hash` -- without
it, the exact weights that produced the asset cannot be proven.

Implements `13-asset-pipeline.md` §2 (validation gate, T-0102).
"""

from __future__ import annotations

import json
from pathlib import Path

from asset_gate.result import CheckResult

_MISSING = object()


def check_provenance_model_hash(provenance: dict) -> CheckResult:
    """Fail if ``model_hash`` is absent, null, or empty in a provenance record.

    PLAN.md §0: "a null hash means the exact weights that produced an asset
    cannot be proven."  The validation gate (T-0102) must reject any write
    that would leave this field unresolved.

    Args:
        provenance: a dict loaded from a ``.provenance.json`` sidecar.

    Returns:
        ``CheckResult`` with ``passed=True`` iff ``model_hash`` is a
        non-empty string.
    """
    model_hash = provenance.get("model_hash", _MISSING)

    if model_hash is _MISSING:
        return CheckResult(
            check="provenance_model_hash",
            passed=False,
            reason="model_hash key is missing from provenance record (PLAN.md §0)",
            details={"present": False},
        )

    if not model_hash:
        return CheckResult(
            check="provenance_model_hash",
            passed=False,
            reason=(
                "model_hash is null or empty -- exact weights cannot be proven "
                "(PLAN.md §0, T-0151)"
            ),
            details={"model_hash": model_hash},
        )

    return CheckResult(
        check="provenance_model_hash",
        passed=True,
        reason=f"model_hash is present ({str(model_hash)[:16]}...)",
        details={"model_hash": model_hash},
    )


def sweep_provenance_model_hash(root: Path | str) -> list[CheckResult]:
    """Run `check_provenance_model_hash` against every ``*.provenance.json``
    under *root*, recursively.

    (HANDOFF §21) T-0151 enforced ``model_hash`` inside one writer
    (`comfy_client.pipeline.generate()`); several other asset-writing paths
    (concept-art LoRA generation, standalone synth-fallback scripts) never
    went through it and shipped null hashes undetected because nothing
    scanned the committed tree. This sweep is writer-agnostic -- it reads
    the sidecars that actually landed in the repo, so a gap in any future
    writer is still caught here regardless of which code path produced it.
    """
    results = []
    for path in sorted(Path(root).rglob("*.provenance.json")):
        provenance = json.loads(path.read_text())
        single = check_provenance_model_hash(provenance)
        rel = path.relative_to(root) if path.is_relative_to(root) else path
        results.append(
            CheckResult(
                check="provenance_model_hash",
                passed=single.passed,
                reason=f"{rel}: {single.reason}",
                details={**single.details, "path": str(rel)},
            )
        )
    return results
