"""L-1 through L-4 locale build checks (T-0119, docs/design/17-localization.md §3).

Every check returns a list of :class:`CheckResult` failures.  An empty list means
the check passed.  Incomplete locales (``PoFile.is_incomplete == True``) are
excluded from L-1 and L-2 but are still subject to L-3 and L-4.

Pure functions — no I/O, no side effects — composable and testable in isolation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from locale_gate.po_parser import PoFile

# Positional placeholder pattern: {0}, {1}, {12}, etc.
# Named placeholders like {direction} or {action} are allowed.
_POSITIONAL_RE = re.compile(r'\{(\d+)\}')


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a single locale build check.

    ``passed=False`` means the build must be rejected.

    Attributes:
        check: Check label, e.g. ``"L-1"``.
        passed: ``False`` when the check found a violation.
        reason: Human-readable failure description.
        details: Structured data for programmatic inspection.
    """

    check: str
    passed: bool
    reason: str
    details: dict[str, Any] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return self.passed


def check_l1_coverage(
    catalogue_keys: list[str],
    locales: dict[str, PoFile],
) -> list[CheckResult]:
    """L-1: every LocId in the catalogue resolves in every **shipped** locale.

    Incomplete locales (``po.is_incomplete``) are excluded from this check —
    they represent work-in-progress translations and must not block the build.

    Args:
        catalogue_keys: Sorted list of ``"word:N"`` / ``"template:N"`` keys from
            ``catalogue.parse_loc_ids``.
        locales: Mapping from locale name (e.g. ``"ru"``) to parsed :class:`PoFile`.

    Returns:
        One :class:`CheckResult` per (locale, missing_key) pair.
    """
    failures: list[CheckResult] = []
    for locale_name, po in locales.items():
        if po.is_incomplete:
            continue
        for key in catalogue_keys:
            if key not in po.translations:
                failures.append(
                    CheckResult(
                        check="L-1",
                        passed=False,
                        reason=(
                            f"locale '{locale_name}': key '{key}' not found in translation"
                        ),
                        details={"locale": locale_name, "missing_key": key},
                    )
                )
    return failures


def check_l2_slot_consistency(
    template_slots: dict[str, set[str]],
    locales: dict[str, PoFile],
) -> list[CheckResult]:
    """L-2: every locale's template uses the same named slot set as the reference.

    Reordering slots within the template string is allowed.  Adding, dropping,
    or renaming a slot is a failure.  Incomplete locales are excluded.

    Args:
        template_slots: ``{"template:N": {slot_name, …}}`` from
            ``catalogue.parse_template_slots`` — the reference (English) slot sets.
        locales: Mapping from locale name to parsed :class:`PoFile`.

    Returns:
        One :class:`CheckResult` per (locale, template) pair where the slot set
        differs from the reference.
    """
    failures: list[CheckResult] = []
    for locale_name, po in locales.items():
        if po.is_incomplete:
            continue
        for tmpl_key, reference_slots in template_slots.items():
            msgstr = po.translations.get(tmpl_key)
            if msgstr is None:
                # Missing translation is caught by L-1; skip here.
                continue
            actual_slots = _extract_named_slots(msgstr)
            if actual_slots != reference_slots:
                failures.append(
                    CheckResult(
                        check="L-2",
                        passed=False,
                        reason=(
                            f"locale '{locale_name}', {tmpl_key}: "
                            f"slot set {sorted(actual_slots)} != "
                            f"reference {sorted(reference_slots)}"
                        ),
                        details={
                            "locale": locale_name,
                            "template": tmpl_key,
                            "actual_slots": actual_slots,
                            "reference_slots": reference_slots,
                        },
                    )
                )
    return failures


def check_l3_no_positional(
    locales: dict[str, PoFile],
) -> list[CheckResult]:
    """L-3: no locale string may contain a positional placeholder (e.g. ``{0}``).

    Applied to **all** locales including incomplete ones — positional placeholders
    are an authoring error that should be caught as early as possible.

    Args:
        locales: Mapping from locale name to parsed :class:`PoFile`.

    Returns:
        One :class:`CheckResult` per (locale, msgid) pair where a positional
        placeholder is found.
    """
    failures: list[CheckResult] = []
    for locale_name, po in locales.items():
        for msgid, msgstr in po.translations.items():
            positional = _POSITIONAL_RE.findall(msgstr)
            if positional:
                failures.append(
                    CheckResult(
                        check="L-3",
                        passed=False,
                        reason=(
                            f"locale '{locale_name}', key '{msgid}': "
                            f"positional placeholder(s) found: "
                            f"{['{' + p + '}' for p in positional]}"
                        ),
                        details={
                            "locale": locale_name,
                            "key": msgid,
                            "positional": positional,
                        },
                    )
                )
    return failures


def check_l4_no_seed_words(
    seed_words: set[str],
    locales: dict[str, PoFile],
) -> list[CheckResult]:
    """L-4: the seed-phrase wordlist is absent from every translation catalogue.

    No seed-phrase word may appear as a ``msgid`` in any locale file, complete
    or incomplete.  Seed words are identifiers, not display text — they must
    never be added to the translation catalogue.

    Args:
        seed_words: Set of seed-phrase words from ``catalogue.parse_seed_wordlist``.
        locales: Mapping from locale name to parsed :class:`PoFile`.

    Returns:
        One :class:`CheckResult` per (locale, seed_word) pair found as a msgid.
    """
    failures: list[CheckResult] = []
    for locale_name, po in locales.items():
        for msgid in po.translations:
            if msgid in seed_words:
                failures.append(
                    CheckResult(
                        check="L-4",
                        passed=False,
                        reason=(
                            f"locale '{locale_name}': seed word '{msgid}' found as "
                            f"a msgid — seed-phrase words are identifiers, not "
                            f"translatable text"
                        ),
                        details={"locale": locale_name, "seed_word": msgid},
                    )
                )
    return failures


# ── internal helpers ────────────────────────────────────────────────────────────


def _extract_named_slots(msgstr: str) -> set[str]:
    """Return the set of named (non-positional) slot identifiers in msgstr.

    E.g. ``"{direction} {hazard}"`` → ``{"direction", "hazard"}``.
    Positional slots like ``{0}`` are NOT included; they are caught by L-3.
    """
    return {
        m.group(1)
        for m in re.finditer(r'\{([^}]+)\}', msgstr)
        if not m.group(1).isdigit()
    }
