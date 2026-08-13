"""ASSET_PROVENANCE.md auto-writer (T-0075).

Appends a provenance table row to ASSET_PROVENANCE.md for every generated
asset -- conduct.md: "every generated asset gets an ASSET_PROVENANCE.md
entry (model + license + prompt + seed) -- non-optional."

Works with any provenance dict that has at minimum:
- ``model`` (or ``method`` for deterministic/non-AI assets)
- ``model_license`` (or None for deterministic assets -> rendered as N/A)
- ``prompt`` (or ``description``)
- ``seed``

Called from ``comfy_client.pipeline.generate()`` and
``audio_agent.pipeline.generate()`` / ``generate_texture()`` so every
generation run writes its own row automatically.
"""

from __future__ import annotations

from pathlib import Path

_SENTINEL = "| Asset | Model | License | Prompt | Seed |"
_MAX_PROMPT_LEN = 120


def _escape(text: str) -> str:
    """Escape pipe characters so they don't break the markdown table."""
    return str(text).replace("|", r"\|")


def _truncate(text: str, max_len: int = _MAX_PROMPT_LEN) -> str:
    s = str(text)
    if len(s) <= max_len:
        return s
    return s[:max_len] + "\u2026"


def append_provenance_entry(
    asset_path: str | Path,
    record: dict,
    provenance_md: Path | None = None,
) -> None:
    """Append one row to the ASSET_PROVENANCE.md table.

    Args:
        asset_path: Path to the generated asset (shown in the Asset column).
        record: Provenance dict with at minimum ``model`` (or ``method``),
            ``model_license`` (or None), ``prompt``, and ``seed``.
        provenance_md: Path to ASSET_PROVENANCE.md.  Defaults to
            ``Path("ASSET_PROVENANCE.md")`` (CWD-relative, i.e. the repo root
            when called normally).  Pass an explicit path in tests.

    Raises:
        FileNotFoundError: if *provenance_md* does not exist.
        ValueError: if the required table sentinel is absent, or if all of
            model/method, model_license, and prompt/description are missing.
    """
    if provenance_md is None:
        provenance_md = Path("ASSET_PROVENANCE.md")

    if not provenance_md.exists():
        raise FileNotFoundError(
            f"ASSET_PROVENANCE.md not found at {provenance_md} -- "
            "cannot write provenance entry without an existing table"
        )

    model = record.get("model") or record.get("method") or "N/A"
    license_ = record.get("model_license") or "N/A"
    prompt = record.get("prompt") or record.get("description") or "N/A"
    seed = record.get("seed", "N/A")

    if model == "N/A" and license_ == "N/A" and prompt == "N/A":
        raise ValueError(
            f"provenance record for {asset_path} is missing all required fields "
            "(model/method, model_license, prompt/description)"
        )

    row = (
        f"| `{_escape(str(asset_path))}` "
        f"| {_escape(model)} "
        f"| {_escape(license_)} "
        f"| {_escape(_truncate(prompt))} "
        f"| {seed} |"
    )

    text = provenance_md.read_text()

    if _SENTINEL not in text:
        raise ValueError(
            f"ASSET_PROVENANCE.md at {provenance_md} does not contain the expected "
            f"table header '{_SENTINEL}' -- cannot append a row"
        )

    lines = text.splitlines(keepends=True)

    # Find the header line index.
    header_idx = next(i for i, line in enumerate(lines) if _SENTINEL in line)

    # Walk forward from the header; find the last consecutive | line.
    last_table_idx = header_idx
    for i in range(header_idx + 1, len(lines)):
        if lines[i].startswith("|"):
            last_table_idx = i
        else:
            break

    lines.insert(last_table_idx + 1, row + "\n")
    provenance_md.write_text("".join(lines))
