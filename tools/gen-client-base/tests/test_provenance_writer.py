"""ASSET_PROVENANCE.md auto-writer tests (T-0075).

conduct.md: every generated asset needs an ASSET_PROVENANCE.md entry
(model + license + prompt + seed) -- non-optional. This module tests
`gen_client_base.provenance_writer.append_provenance_entry`, which is
called from both comfy_client.pipeline and audio_agent.pipeline after
every generation run so the write happens automatically.
"""

from __future__ import annotations

import pytest

from gen_client_base.provenance_writer import append_provenance_entry

_HEADER = "| Asset | Model | License | Prompt | Seed |"
_SEPARATOR = "|---|---|---|---|---|"


def _make_provenance_md(tmp_path, extra_rows: list[str] | None = None) -> object:
    """Create a minimal ASSET_PROVENANCE.md with the required table header."""
    lines = [
        "# Asset Provenance\n",
        "\n",
        f"{_HEADER}\n",
        f"{_SEPARATOR}\n",
    ]
    if extra_rows:
        for row in extra_rows:
            lines.append(row + "\n")
    path = tmp_path / "ASSET_PROVENANCE.md"
    path.write_text("".join(lines))
    return path


def _make_full_record(
    model: str = "sd_xl_base_1.0.safetensors",
    model_license: str = "CreativeML Open RAIL++-M",
    prompt: str = "a rusted corridor",
    seed: int = 42,
) -> dict:
    return {
        "model": model,
        "model_license": model_license,
        "prompt": prompt,
        "seed": seed,
    }


# ---------------------------------------------------------------------------
# Happy-path: required fields appear in the appended row
# ---------------------------------------------------------------------------


def test_append_adds_row_with_model_license_prompt_seed(tmp_path):
    md = _make_provenance_md(tmp_path)
    record = _make_full_record()
    append_provenance_entry("assets/final/tiles/wall.png", record, provenance_md=md)

    text = md.read_text()
    assert "sd_xl_base_1.0.safetensors" in text
    assert "CreativeML Open RAIL++-M" in text
    assert "a rusted corridor" in text
    assert "42" in text


def test_append_includes_asset_path_in_row(tmp_path):
    md = _make_provenance_md(tmp_path)
    append_provenance_entry(
        "assets/final/tiles/signal_wall.png", _make_full_record(), provenance_md=md
    )
    assert "assets/final/tiles/signal_wall.png" in md.read_text()


def test_append_inserts_row_inside_the_table(tmp_path):
    """New row must sit contiguously inside the markdown table (no blank-line break)."""
    md = _make_provenance_md(tmp_path, extra_rows=["| `old.png` | M | L | p | 1 |"])
    append_provenance_entry("new.png", _make_full_record(), provenance_md=md)

    lines = md.read_text().splitlines()
    table_lines = [ln for ln in lines if ln.startswith("|")]
    # header + separator + old row + new row = 4 pipe lines, all consecutive
    assert len(table_lines) >= 4
    # They must all appear without a blank line between them
    first_pipe = next(i for i, ln in enumerate(lines) if ln.startswith("|"))
    for i in range(first_pipe, first_pipe + len(table_lines)):
        assert lines[i].startswith("|"), f"Gap in table at line {i}: {lines[i]!r}"


def test_append_works_when_table_already_has_rows(tmp_path):
    md = _make_provenance_md(
        tmp_path,
        extra_rows=["| `existing.png` | ModelA | LicA | existing prompt | 1 |"],
    )
    append_provenance_entry("new.png", _make_full_record(seed=99), provenance_md=md)
    text = md.read_text()
    assert "existing.png" in text
    assert "99" in text


# ---------------------------------------------------------------------------
# Prompt handling: escaping and truncation
# ---------------------------------------------------------------------------


def test_append_escapes_pipe_characters_in_prompt(tmp_path):
    md = _make_provenance_md(tmp_path)
    record = _make_full_record(prompt="signal | tower | corridor")
    append_provenance_entry("wall.png", record, provenance_md=md)

    # Literal unescaped | inside a cell would break the table; must be \\|
    text = md.read_text()
    # The prompt cell should not contain a raw unescaped pipe (only \\| is ok)
    # Find the row that contains our asset
    row = next(ln for ln in text.splitlines() if "wall.png" in ln)
    # Remove the leading/trailing pipes and the first/last columns
    # then check no raw pipe remains where the prompt would be
    assert r"\|" in row, "Pipe in prompt must be escaped as \\|"


def test_append_truncates_very_long_prompt(tmp_path):
    md = _make_provenance_md(tmp_path)
    long_prompt = "x" * 200
    append_provenance_entry("wall.png", _make_full_record(prompt=long_prompt), provenance_md=md)
    row = next(ln for ln in md.read_text().splitlines() if "wall.png" in ln)
    # Truncated row should contain the ellipsis and not the full 200-char prompt
    assert "…" in row
    assert "x" * 200 not in row


# ---------------------------------------------------------------------------
# Deterministic / no-model assets: use 'method' fallback
# ---------------------------------------------------------------------------


def test_append_uses_method_field_when_model_is_absent(tmp_path):
    md = _make_provenance_md(tmp_path)
    record = {
        "method": "deterministic_synthesis",
        "model_license": None,
        "prompt": "layered SFX descend",
        "seed": 7,
    }
    append_provenance_entry("sfx/note_drop.wav", record, provenance_md=md)
    text = md.read_text()
    assert "deterministic_synthesis" in text


def test_append_uses_na_for_absent_license(tmp_path):
    md = _make_provenance_md(tmp_path)
    record = {
        "method": "deterministic_synthesis",
        "model_license": None,
        "prompt": "drop sfx",
        "seed": 1,
    }
    append_provenance_entry("sfx/drop.wav", record, provenance_md=md)
    assert "N/A" in md.read_text()


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------


def test_append_raises_file_not_found_when_md_missing(tmp_path):
    missing = tmp_path / "ASSET_PROVENANCE.md"
    with pytest.raises(FileNotFoundError):
        append_provenance_entry("wall.png", _make_full_record(), provenance_md=missing)


def test_append_raises_value_error_when_no_table_sentinel(tmp_path):
    md = tmp_path / "ASSET_PROVENANCE.md"
    md.write_text("# Asset Provenance\n\nNo table here.\n")
    with pytest.raises(ValueError, match="table header"):
        append_provenance_entry("wall.png", _make_full_record(), provenance_md=md)


def test_append_raises_value_error_when_all_required_fields_missing(tmp_path):
    md = _make_provenance_md(tmp_path)
    with pytest.raises(ValueError, match="missing all required fields"):
        append_provenance_entry("wall.png", {}, provenance_md=md)
