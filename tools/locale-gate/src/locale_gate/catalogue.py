"""Parse the LocId catalogue and seed-phrase wordlist from C++ source files.

The single source of truth for note vocabulary is shared/note_templates.hpp
(word IDs 1-N and template IDs 1-M).  The single source of truth for the
seed-phrase wordlist is server/src/SeedPhrase.cpp (kWordlist).

Pure functions — no I/O, no side effects.
"""

from __future__ import annotations

import re

# Map from slot_a_category / slot_b_category integer to named-slot identifier.
# Must stay in sync with assembled::WordCategory in shared/note_templates.hpp.
_CATEGORY_SLOT_NAME: dict[int, str] = {
    1: "direction",
    2: "hazard",
    3: "action",
    4: "object",
    5: "qualifier",
}


def parse_loc_ids(hpp_text: str) -> list[str]:
    """Return a sorted list of LocId key strings derived from note_templates.hpp.

    Extracts every word ID from ``kWords`` and every template ID from
    ``kTemplates`` and returns them as ``"word:N"`` / ``"template:N"`` strings.

    Args:
        hpp_text: full text of shared/note_templates.hpp.

    Returns:
        Sorted list of key strings, e.g. ``["template:1", "template:2",
        "word:1", "word:2"]``.
    """
    word_ids = _extract_word_ids(hpp_text)
    template_ids = _extract_template_ids(hpp_text)
    keys = [f"word:{i}" for i in word_ids] + [f"template:{i}" for i in template_ids]
    return sorted(keys)


def parse_template_slots(hpp_text: str) -> dict[str, set[str]]:
    """Return the canonical named-slot set per template from note_templates.hpp.

    The slot names are derived from the ``slot_a_category`` and
    ``slot_b_category`` integers in ``kTemplates`` using the ``WordCategory``
    enum mapping.

    Args:
        hpp_text: full text of shared/note_templates.hpp.

    Returns:
        ``{"template:N": {slot_name, …}}`` for every template ID found.
        Templates with no slots map to an empty set.
    """
    result: dict[str, set[str]] = {}
    for tid, _slots_count, slot_a_cat, slot_b_cat in _extract_template_defs(hpp_text):
        names: set[str] = set()
        if slot_a_cat in _CATEGORY_SLOT_NAME:
            names.add(_CATEGORY_SLOT_NAME[slot_a_cat])
        if slot_b_cat in _CATEGORY_SLOT_NAME:
            names.add(_CATEGORY_SLOT_NAME[slot_b_cat])
        result[f"template:{tid}"] = names
    return result


def parse_seed_wordlist(seed_cpp_text: str) -> set[str]:
    """Extract the seed-phrase wordlist from SeedPhrase.cpp source text.

    Parses the ``kWordlist`` array literal and returns every quoted string
    found inside it.

    Args:
        seed_cpp_text: full text of server/src/SeedPhrase.cpp.

    Returns:
        Set of seed-phrase words, e.g. ``{"abandon", "ability", …}``.
    """
    # Find the kWordlist array body between the outer {{ and }}.
    array_match = re.search(r'kWordlist\s*=\s*\{\{(.*?)\}\}', seed_cpp_text, re.DOTALL)
    if not array_match:
        return set()
    body = array_match.group(1)
    return set(re.findall(r'"([^"]+)"', body))


# ── internal helpers ────────────────────────────────────────────────────────────


def _extract_word_ids(hpp_text: str) -> list[int]:
    """Return sorted list of word IDs from kWords array."""
    array_match = re.search(r'kWords\s*=\s*\{\{(.*?)\}\}', hpp_text, re.DOTALL)
    if not array_match:
        return []
    body = array_match.group(1)
    # Each entry: {id, WordCategory::XXX}
    return sorted(int(m.group(1)) for m in re.finditer(r'\{(\d+),\s*WordCategory', body))


def _extract_template_ids(hpp_text: str) -> list[int]:
    """Return sorted list of template IDs from kTemplates array."""
    return sorted(tid for tid, *_ in _extract_template_defs(hpp_text))


def _extract_template_defs(
    hpp_text: str,
) -> list[tuple[int, int, int, int]]:
    """Return list of (id, slots, slot_a_category, slot_b_category) tuples."""
    array_match = re.search(r'kTemplates\s*=\s*\{\{(.*?)\}\}', hpp_text, re.DOTALL)
    if not array_match:
        return []
    body = array_match.group(1)
    # Each entry: {id, slots, slot_a_category, slot_b_category}
    results = []
    for m in re.finditer(r'\{(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\}', body):
        results.append((int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))))
    return results
