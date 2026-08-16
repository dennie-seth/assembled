"""Tests for tag completeness check (INV-12, docs/design/08-invariants.md §1).

Tests are committed before implementation per TDD discipline.  Fixtures use
inline HPP text rather than parsing the real shared/note_templates.hpp so the
suite is hermetic and does not break when the catalogue grows.
"""

from tag_gate.catalogue import parse_anchor_tags
from tag_gate.checker import check_tag_completeness

# Minimal synthetic HPP content — 2 archetypes, 3 and 2 tags respectively.
SAMPLE_HPP = """
inline constexpr std::array<AnchorTagDef, 5> kAnchorTags = {{
    {1, 1}, // entrance
    {1, 2}, // ward_north
    {1, 3}, // ward_south
    {2, 1}, // platform
    {2, 2}, // waiting_room
}};
"""


# ── catalogue.parse_anchor_tags ───────────────────────────────────────────────


def test_parse_anchor_tags_extracts_all_pairs():
    tags = parse_anchor_tags(SAMPLE_HPP)
    assert tags == {1: {1, 2, 3}, 2: {1, 2}}


def test_parse_anchor_tags_empty_array():
    hpp = "inline constexpr std::array<AnchorTagDef, 0> kAnchorTags = {{}};"
    assert parse_anchor_tags(hpp) == {}


def test_parse_anchor_tags_single_archetype():
    hpp = """
    inline constexpr std::array<AnchorTagDef, 2> kAnchorTags = {{
        {5, 1},
        {5, 2},
    }};
    """
    tags = parse_anchor_tags(hpp)
    assert tags == {5: {1, 2}}


# ── checker.check_tag_completeness ───────────────────────────────────────────


def test_complete_variant_passes():
    tags = parse_anchor_tags(SAMPLE_HPP)
    variants = [{"id": 1, "archetype_id": 1, "tags": [1, 2, 3]}]
    failures, warnings = check_tag_completeness(tags, variants)
    assert failures == []
    assert warnings == []


def test_missing_tag_produces_failure():
    tags = parse_anchor_tags(SAMPLE_HPP)
    # Archetype 1 requires tags {1,2,3}; variant only implements {1,2}.
    variants = [{"id": 1, "archetype_id": 1, "tags": [1, 2]}]
    failures, warnings = check_tag_completeness(tags, variants)
    assert len(failures) == 1
    assert not failures[0].passed
    assert failures[0].details["variant_id"] == 1
    assert 3 in failures[0].details["missing_tags"]


def test_extra_tag_produces_warning_not_failure():
    tags = parse_anchor_tags(SAMPLE_HPP)
    # Tag 99 is not declared by archetype 1.
    variants = [{"id": 2, "archetype_id": 1, "tags": [1, 2, 3, 99]}]
    failures, warnings = check_tag_completeness(tags, variants)
    assert failures == []
    assert len(warnings) == 1
    assert warnings[0]["variant_id"] == 2
    assert 99 in warnings[0]["extra_tags"]


def test_missing_and_extra_tags_both_reported():
    tags = parse_anchor_tags(SAMPLE_HPP)
    # Missing tag 3, extra tag 99.
    variants = [{"id": 3, "archetype_id": 1, "tags": [1, 2, 99]}]
    failures, warnings = check_tag_completeness(tags, variants)
    assert len(failures) == 1
    assert not failures[0].passed
    assert 3 in failures[0].details["missing_tags"]
    assert len(warnings) == 1
    assert 99 in warnings[0]["extra_tags"]


def test_no_variants_passes():
    tags = parse_anchor_tags(SAMPLE_HPP)
    failures, warnings = check_tag_completeness(tags, [])
    assert failures == []
    assert warnings == []


def test_multiple_variants_checked_independently():
    tags = parse_anchor_tags(SAMPLE_HPP)
    variants = [
        {"id": 1, "archetype_id": 1, "tags": [1, 2, 3]},  # pass
        {"id": 2, "archetype_id": 2, "tags": [1]},         # missing tag 2
    ]
    failures, warnings = check_tag_completeness(tags, variants)
    assert len(failures) == 1
    assert failures[0].details["variant_id"] == 2
    assert 2 in failures[0].details["missing_tags"]


def test_multiple_missing_tags_all_reported():
    tags = parse_anchor_tags(SAMPLE_HPP)
    variants = [{"id": 5, "archetype_id": 1, "tags": []}]  # all three missing
    failures, warnings = check_tag_completeness(tags, variants)
    assert len(failures) == 1
    assert failures[0].details["missing_tags"] == {1, 2, 3}


def test_variant_with_unknown_archetype_fails():
    tags = parse_anchor_tags(SAMPLE_HPP)
    # Archetype 99 does not exist in the catalogue.
    variants = [{"id": 7, "archetype_id": 99, "tags": [1]}]
    failures, warnings = check_tag_completeness(tags, variants)
    assert len(failures) == 1
    assert not failures[0].passed
    assert failures[0].details["variant_id"] == 7


def test_two_variants_same_archetype_each_checked():
    tags = parse_anchor_tags(SAMPLE_HPP)
    variants = [
        {"id": 10, "archetype_id": 2, "tags": [1, 2]},  # pass
        {"id": 11, "archetype_id": 2, "tags": [1]},      # fail — missing 2
    ]
    failures, warnings = check_tag_completeness(tags, variants)
    assert len(failures) == 1
    assert failures[0].details["variant_id"] == 11
