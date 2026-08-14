"""Parse shared/note_templates.hpp to extract the archetype → anchor-tag map.

Implements INV-12 (docs/design/08-invariants.md §1): every variant must
implement every anchor tag its archetype declares.  The single source of truth
for archetype and tag IDs is shared/note_templates.hpp; this module reads it
so the checker never has a private copy.
"""

from __future__ import annotations

import re


# Matches individual {archetype_id, tag} entries inside kAnchorTags.
# Handles optional trailing comma and whitespace.  Comments after // are ignored
# because the regex stops at the closing brace.
_ENTRY_RE = re.compile(r"\{\s*(\d+)\s*,\s*(\d+)\s*\}")

# Locates the kAnchorTags initialiser block between the outer {{ and }}.
_BLOCK_RE = re.compile(r"kAnchorTags\s*=\s*\{\{(.*?)\}\}", re.DOTALL)


def parse_anchor_tags(hpp_text: str) -> dict[int, set[int]]:
    """Return ``{archetype_id: {tag, …}}`` by parsing *hpp_text*.

    The HPP text must contain a ``kAnchorTags`` array initialiser in the form
    produced by ``shared/note_templates.hpp``.  If the array is absent or
    empty, an empty dict is returned.
    """
    block_match = _BLOCK_RE.search(hpp_text)
    if not block_match:
        return {}

    result: dict[int, set[int]] = {}
    for m in _ENTRY_RE.finditer(block_match.group(1)):
        arch_id = int(m.group(1))
        tag = int(m.group(2))
        result.setdefault(arch_id, set()).add(tag)
    return result
