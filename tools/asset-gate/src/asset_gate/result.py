"""Shared pass/fail result type for every check in the gate (art + audio)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CheckResult:
    """The outcome of a single validation-gate check.

    `check` is a stable machine-readable name (e.g. "palette_membership"),
    `reason` is a one-line human-readable explanation of the pass/fail
    verdict, and `details` carries structured data (offending indices,
    measured values, etc.) for callers that want more than the summary.
    """

    check: str
    passed: bool
    reason: str
    details: dict[str, Any] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return self.passed


def all_passed(results: list[CheckResult]) -> bool:
    return all(r.passed for r in results)


def format_report(results: list[CheckResult]) -> str:
    lines = []
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        lines.append(f"[{status}] {r.check}: {r.reason}")
    return "\n".join(lines)
