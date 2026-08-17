"""GNU gettext .po file parser for locale-gate.

Parses the minimal subset of the .po format that the locale-gate checks require:
  - Header entry (msgid "" / msgstr "") with optional X-Incomplete marker.
  - Standard msgid/msgstr pairs; multi-line msgstr is supported.
  - Empty msgstr is treated as untranslated and excluded from translations.

Pure functions — no I/O, no side effects.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class PoFile:
    """Parsed representation of a single .po locale file.

    Attributes:
        is_incomplete: True when the file header contains ``X-Incomplete: true``.
            Incomplete locales are excluded from L-1 (coverage) and L-2 (slot
            consistency) but are still checked by L-3 (positional placeholders)
            and L-4 (seed-word presence).
        translations: Mapping from msgid to msgstr for entries whose msgstr is
            non-empty.  The special header entry (msgid "") is not included.
    """

    is_incomplete: bool
    translations: dict[str, str] = field(default_factory=dict)


def parse_po(text: str) -> PoFile:
    """Parse a .po file text into a :class:`PoFile`.

    Entries with an empty msgstr are not added to ``translations`` — they
    indicate untranslated strings and are treated as missing keys for L-1.

    Args:
        text: full text of the .po file.

    Returns:
        :class:`PoFile` with ``is_incomplete`` and ``translations`` populated.
    """
    entries = _split_entries(text)
    is_incomplete = False
    translations: dict[str, str] = {}

    for msgid, msgstr in entries:
        if msgid == "":
            # Header entry — check for the X-Incomplete marker.
            if re.search(r'X-Incomplete:\s*true', msgstr, re.IGNORECASE):
                is_incomplete = True
            continue

        if msgstr:
            translations[msgid] = msgstr

    return PoFile(is_incomplete=is_incomplete, translations=translations)


# ── internal helpers ────────────────────────────────────────────────────────────


def _split_entries(text: str) -> list[tuple[str, str]]:
    """Split .po text into (msgid, msgstr) pairs.

    Handles:
    - Single-line: ``msgid "foo"``
    - Continuation lines (quoted strings on the next line, no keyword prefix)
    - Comments (``#``-prefixed lines) stripped.
    - Blank lines separate entries.
    """
    entries: list[tuple[str, str]] = []
    current_msgid: str | None = None
    current_msgstr: str | None = None
    state: str = "idle"  # "idle" | "in_msgid" | "in_msgstr"

    def flush() -> None:
        if current_msgid is not None and current_msgstr is not None:
            entries.append((current_msgid, current_msgstr))

    for raw_line in text.splitlines():
        line = raw_line.strip()

        # Strip comments.
        if line.startswith("#"):
            continue

        # Blank line — flush current entry.
        if not line:
            if state != "idle":
                flush()
                current_msgid = None
                current_msgstr = None
                state = "idle"
            continue

        if line.startswith("msgid "):
            if state != "idle":
                flush()
            current_msgid = _extract_string(line[len("msgid "):])
            current_msgstr = None
            state = "in_msgid"

        elif line.startswith("msgstr "):
            current_msgstr = _extract_string(line[len("msgstr "):])
            state = "in_msgstr"

        elif line.startswith('"') and state == "in_msgid":
            assert current_msgid is not None
            current_msgid += _extract_string(line)

        elif line.startswith('"') and state == "in_msgstr":
            assert current_msgstr is not None
            current_msgstr += _extract_string(line)

    # Flush last entry.
    if state != "idle":
        flush()

    return entries


def _extract_string(token: str) -> str:
    """Extract the unescaped string value from a quoted .po token.

    Handles ``"text"`` and processes ``\\n`` escape sequences.
    """
    token = token.strip()
    if token.startswith('"') and token.endswith('"'):
        inner = token[1:-1]
        # Unescape common sequences relevant to headers.
        inner = inner.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
        return inner
    return token
