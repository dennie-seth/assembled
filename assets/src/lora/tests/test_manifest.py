"""Tests for the LoRA reference corpus manifest.

Implements T-0072 acceptance criteria:
  - 30–50 curated reference images, sourced and license-clean
  - Provenance (source, license, curation notes) recorded

Checked against: 13-asset-pipeline.md §3.2
  "The style LoRA (T-0072) trains on the reference corpus in its natural
   colour ... Concept art does not train the style LoRA."
"""

from __future__ import annotations

import pathlib
import re

import pytest

from lora_train.manifest import (
    ALLOWED_LICENSES,
    CORPUS_MAX,
    CORPUS_MIN,
    Corpus,
    Ref,
    load_corpus,
)

CORPUS_PATH = pathlib.Path(__file__).parent.parent / "corpus.json"


# ---------------------------------------------------------------------------
# Unit tests — validate behaviour of load_corpus() and the dataclasses
# ---------------------------------------------------------------------------


def _make_ref(**overrides) -> Ref:
    defaults = dict(
        id="ref_001",
        commons_file="File:Soviet_housing_block.jpg",
        license="CC-BY-SA-4.0",
        attribution="Test Author / Wikimedia Commons",
        sha256=None,
        curation_notes="Flat facade, repetitive geometry, desaturated.",
    )
    defaults.update(overrides)
    return Ref(**defaults)


def _make_corpus(**overrides) -> Corpus:
    defaults = dict(
        corpus_version="1",
        selection_criteria={
            "prefer": ["Exterior facades showing repetitive geometry"],
            "avoid": ["Interiors of private spaces"],
            "target_count": 40,
        },
        allowed_licenses=list(ALLOWED_LICENSES),
        refs=[_make_ref(id=f"ref_{i:03d}") for i in range(1, 41)],
    )
    defaults.update(overrides)
    return Corpus(**defaults)


def test_corpus_version_must_be_string():
    with pytest.raises((TypeError, ValueError)):
        _make_corpus(corpus_version=1)  # type: ignore[arg-type]


def test_selection_criteria_must_have_prefer_and_avoid():
    with pytest.raises(ValueError):
        _make_corpus(selection_criteria={"target_count": 40})  # missing prefer/avoid


def test_selection_criteria_target_count_in_corpus_range():
    with pytest.raises(ValueError):
        _make_corpus(
            selection_criteria={
                "prefer": ["x"],
                "avoid": ["y"],
                "target_count": 5,  # below CORPUS_MIN
            }
        )


def test_ref_count_must_be_in_range():
    with pytest.raises(ValueError):
        _make_corpus(refs=[_make_ref(id=f"ref_{i:03d}") for i in range(1, 10)])
    with pytest.raises(ValueError):
        _make_corpus(refs=[_make_ref(id=f"ref_{i:03d}") for i in range(1, 60)])


def test_ref_ids_must_be_unique():
    with pytest.raises(ValueError):
        _make_corpus(refs=[_make_ref(id="ref_001"), _make_ref(id="ref_001")])


def test_ref_id_format():
    with pytest.raises(ValueError):
        _make_ref(id="bad-id-format")


def test_ref_commons_file_must_start_with_File_prefix():
    with pytest.raises(ValueError):
        _make_ref(commons_file="Soviet_housing_block.jpg")  # missing "File:" prefix


def test_ref_license_must_be_in_allowed_set():
    with pytest.raises(ValueError):
        _make_ref(license="CC-BY-NC-4.0")  # NC is not clean
    with pytest.raises(ValueError):
        _make_ref(license="All Rights Reserved")


def test_ref_attribution_must_be_non_empty():
    with pytest.raises(ValueError):
        _make_ref(attribution="")


def test_ref_curation_notes_must_be_non_empty():
    with pytest.raises(ValueError):
        _make_ref(curation_notes="")


def test_ref_sha256_none_is_acceptable():
    # sha256 is null until images are fetched
    ref = _make_ref(sha256=None)
    assert ref.sha256 is None


def test_ref_sha256_must_be_64_hex_chars_if_set():
    good = "a" * 64
    ref = _make_ref(sha256=good)
    assert ref.sha256 == good

    with pytest.raises(ValueError):
        _make_ref(sha256="tooshort")
    with pytest.raises(ValueError):
        _make_ref(sha256="Z" * 64)  # not hex


def test_allowed_licenses_excludes_nc_variants():
    for lic in ALLOWED_LICENSES:
        assert "NC" not in lic, f"NC license must never appear in allowlist: {lic}"


# ---------------------------------------------------------------------------
# Integration tests — load the real corpus.json
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def corpus() -> Corpus:
    return load_corpus(CORPUS_PATH)


def test_corpus_loads_without_error(corpus: Corpus):
    assert corpus is not None


def test_corpus_ref_count_in_range(corpus: Corpus):
    assert CORPUS_MIN <= len(corpus.refs) <= CORPUS_MAX, (
        f"Expected {CORPUS_MIN}–{CORPUS_MAX} refs, got {len(corpus.refs)}"
    )


def test_all_refs_have_required_fields(corpus: Corpus):
    for ref in corpus.refs:
        assert ref.id
        assert ref.commons_file.startswith("File:")
        assert ref.license
        assert ref.attribution
        assert ref.curation_notes


def test_all_ref_licenses_are_clean(corpus: Corpus):
    for ref in corpus.refs:
        assert ref.license in ALLOWED_LICENSES, (
            f"{ref.id}: license {ref.license!r} not in allowlist"
        )


def test_no_duplicate_ref_ids(corpus: Corpus):
    ids = [r.id for r in corpus.refs]
    assert len(ids) == len(set(ids)), "Duplicate ref IDs found"


def test_all_ref_ids_match_pattern(corpus: Corpus):
    pattern = re.compile(r"^ref_\d{3}$")
    for ref in corpus.refs:
        assert pattern.match(ref.id), f"Bad ID format: {ref.id!r}"


def test_selection_criteria_present(corpus: Corpus):
    sc = corpus.selection_criteria
    assert "prefer" in sc
    assert "avoid" in sc
    assert "target_count" in sc
