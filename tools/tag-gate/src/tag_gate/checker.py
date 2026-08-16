"""Anchor-tag completeness check (INV-12, docs/design/08-invariants.md §1).

Every variant must implement every anchor tag its archetype declares.
A missing tag is a build failure; an extra, undeclared tag is a warning.

Pure functions — no I/O, no side effects — so they are composable and
testable without patching the file system.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a single tag-completeness check for one variant.

    ``passed=True``  — the variant implements all required tags.
    ``passed=False`` — one or more required tags are missing; build must fail.
    ``details``      — structured data: ``variant_id``, ``missing_tags``, etc.
    """

    check: str
    passed: bool
    reason: str
    details: dict[str, Any] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return self.passed


def check_tag_completeness(
    archetype_tags: dict[int, set[int]],
    variants: list[dict[str, Any]],
) -> tuple[list[CheckResult], list[dict[str, Any]]]:
    """Check every variant against its archetype's declared anchor tags.

    Args:
        archetype_tags: ``{archetype_id: {tag, …}}`` from ``catalogue.parse_anchor_tags``.
        variants: list of variant dicts, each with keys:
            - ``id`` (int): variant identifier
            - ``archetype_id`` (int): which archetype this variant belongs to
            - ``tags`` (list[int]): anchor tags the variant implements

    Returns:
        ``(failures, warnings)`` where:
        - *failures* is a list of :class:`CheckResult` with ``passed=False``,
          one per variant that is missing required tags or references an
          unknown archetype.
        - *warnings* is a list of dicts (``variant_id``, ``extra_tags``) for
          variants that implement tags not declared by their archetype.
          Warnings do not fail the build.
    """
    failures: list[CheckResult] = []
    warnings: list[dict[str, Any]] = []

    for variant in variants:
        vid = variant["id"]
        arch_id = variant["archetype_id"]
        implemented = set(variant.get("tags", []))

        if arch_id not in archetype_tags:
            failures.append(
                CheckResult(
                    check="tag_completeness",
                    passed=False,
                    reason=f"variant {vid}: archetype {arch_id} not found in catalogue",
                    details={"variant_id": vid, "archetype_id": arch_id, "missing_tags": set()},
                )
            )
            continue

        required = archetype_tags[arch_id]
        missing = required - implemented
        extra = implemented - required

        if missing:
            failures.append(
                CheckResult(
                    check="tag_completeness",
                    passed=False,
                    reason=(
                        f"variant {vid} (archetype {arch_id}) missing "
                        f"{len(missing)} required tag(s): {sorted(missing)}"
                    ),
                    details={
                        "variant_id": vid,
                        "archetype_id": arch_id,
                        "missing_tags": missing,
                    },
                )
            )

        if extra:
            warnings.append(
                {
                    "variant_id": vid,
                    "archetype_id": arch_id,
                    "extra_tags": extra,
                }
            )

    return failures, warnings
