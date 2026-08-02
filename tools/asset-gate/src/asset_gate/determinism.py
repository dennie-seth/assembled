"""Shared determinism harness.

Both the art gate (atlas packing, `13-asset-pipeline.md` §3.6 / T-0074) and
the audio gate (one-shot synthesis, `13-asset-pipeline.md` §4.5 / T-0101)
need the same predicate: same inputs -> byte-identical output. One
implementation, two callers -- see `art.check_atlas_determinism` and
`audio.check_determinism`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from asset_gate.result import CheckResult


def check_reproducible(
    check_name: str,
    produce: Callable[[], bytes],
    runs: int = 2,
) -> CheckResult:
    """Call `produce()` `runs` times and assert every call returns identical bytes."""
    outputs: list[bytes] = [produce() for _ in range(runs)]
    first = outputs[0]
    mismatches = [i for i, out in enumerate(outputs) if out != first]
    if mismatches:
        return CheckResult(
            check=check_name,
            passed=False,
            reason=f"non-deterministic: run(s) {mismatches} differ from run 0",
            details={"runs": runs, "mismatched_runs": mismatches},
        )
    return CheckResult(
        check=check_name,
        passed=True,
        reason=f"identical output across {runs} runs ({len(first)} bytes)",
        details={"runs": runs, "byte_length": len(first)},
    )


def image_bytes(image: Any) -> bytes:
    """Canonical byte representation of a PIL image for determinism comparisons."""
    import io

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
