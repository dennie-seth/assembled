"""Tests for locale-gate L-1 through L-4 checks (T-0119, docs/design/17-localization.md §3).

TDD: tests committed before implementation.  Each check (L-1, L-2, L-3, L-4) has
a fixture that currently fails the check and a fixture that currently passes it.

Fixtures use inline PO text and HPP snippets rather than files on disk so the suite
is hermetic and does not break when the real catalogue grows.
"""

from __future__ import annotations

from locale_gate.catalogue import parse_loc_ids, parse_seed_wordlist, parse_template_slots
from locale_gate.checker import (
    check_l1_coverage,
    check_l2_slot_consistency,
    check_l3_no_positional,
    check_l4_no_seed_words,
)
from locale_gate.po_parser import parse_po

# ── Synthetic shared/note_templates.hpp fragment ───────────────────────────────
# 2 words, 2 templates:
#   word:1 (DIRECTION), word:2 (HAZARD)
#   template:1 — 2 slots: slot_a=DIRECTION(1), slot_b=HAZARD(2) → {direction} {hazard}
#   template:2 — 0 slots (fixed phrase)
SAMPLE_HPP = """
namespace assembled {

enum class WordCategory : int16_t {
    DIRECTION = 1,
    HAZARD    = 2,
    ACTION    = 3,
    OBJECT    = 4,
    QUALIFIER = 5,
};

struct WordDef { int16_t id; WordCategory category; };
inline constexpr std::array<WordDef, 2> kWords = {{
    {1, WordCategory::DIRECTION},
    {2, WordCategory::HAZARD},
}};

struct TemplateDef { int16_t id; int16_t slots; int16_t slot_a_category; int16_t slot_b_category; };
inline constexpr std::array<TemplateDef, 2> kTemplates = {{
    {1, 2, 1, 2},   // "{DIRECTION} {HAZARD}"
    {2, 0, 0, 0},   // fixed phrase
}};

} // namespace assembled
"""

# ── Synthetic server/src/SeedPhrase.cpp fragment ──────────────────────────────
# 4-word placeholder list.
SAMPLE_SEED_CPP = """
namespace {
constexpr std::array<std::string_view, 4> kWordlist = {{
    "abandon", "ability", "able", "about",
}};
} // namespace
"""

# ── catalogue.parse_loc_ids ────────────────────────────────────────────────────


def test_parse_loc_ids_returns_word_and_template_keys():
    ids = parse_loc_ids(SAMPLE_HPP)
    assert "word:1" in ids
    assert "word:2" in ids
    assert "template:1" in ids
    assert "template:2" in ids
    assert len(ids) == 4  # 2 words + 2 templates


def test_parse_loc_ids_sorted():
    ids = parse_loc_ids(SAMPLE_HPP)
    assert ids == sorted(ids)


# ── catalogue.parse_template_slots ────────────────────────────────────────────


def test_parse_template_slots_two_slot_template():
    slots = parse_template_slots(SAMPLE_HPP)
    # template:1 has slot_a=DIRECTION(1), slot_b=HAZARD(2)
    assert slots["template:1"] == {"direction", "hazard"}


def test_parse_template_slots_zero_slot_template():
    slots = parse_template_slots(SAMPLE_HPP)
    # template:2 has no slots
    assert slots["template:2"] == set()


# ── catalogue.parse_seed_wordlist ─────────────────────────────────────────────


def test_parse_seed_wordlist_extracts_all_words():
    words = parse_seed_wordlist(SAMPLE_SEED_CPP)
    assert words == {"abandon", "ability", "able", "about"}


def test_parse_seed_wordlist_empty_array():
    cpp = 'constexpr std::array<std::string_view, 0> kWordlist = {{}};'
    assert parse_seed_wordlist(cpp) == set()


# ── po_parser.parse_po ────────────────────────────────────────────────────────


def test_parse_po_basic():
    po = parse_po(
        'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n'
        'msgid "word:1"\nmsgstr "ahead"\n'
    )
    assert not po.is_incomplete
    assert po.translations["word:1"] == "ahead"


def test_parse_po_incomplete_header():
    po = parse_po(
        'msgid ""\nmsgstr ""\n"X-Incomplete: true\\n"\n\n'
        'msgid "word:1"\nmsgstr "partway"\n'
    )
    assert po.is_incomplete
    assert po.translations["word:1"] == "partway"


def test_parse_po_empty_msgstr_not_included():
    po = parse_po(
        'msgid ""\nmsgstr ""\n\n'
        'msgid "word:1"\nmsgstr ""\n'  # empty msgstr = untranslated
    )
    assert "word:1" not in po.translations


def test_parse_po_multiline_msgstr():
    po = parse_po(
        'msgid ""\nmsgstr ""\n\n'
        'msgid "template:1"\n'
        'msgstr "{direction}"\n'
    )
    assert po.translations["template:1"] == "{direction}"


# ── L-1: catalogue coverage ───────────────────────────────────────────────────
# Every LocId in the catalogue resolves in every shipped (non-incomplete) locale.

L1_PASS_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "ahead"

msgid "word:2"
msgstr "le danger"

msgid "template:1"
msgstr "{direction} {hazard}"

msgid "template:2"
msgstr "passage sûr"
"""

L1_FAIL_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "ahead"

msgid "template:1"
msgstr "{direction} {hazard}"

msgid "template:2"
msgstr "passage sûr"
"""
# word:2 is MISSING → L-1 failure

L1_INCOMPLETE_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"X-Incomplete: true\\n"

msgid "word:1"
msgstr "partway"
"""
# word:2, template:1, template:2 missing — but incomplete locale excluded from L-1


def test_l1_complete_locale_passes():
    ids = parse_loc_ids(SAMPLE_HPP)
    locales = {"fr": parse_po(L1_PASS_PO_TEXT)}
    results = check_l1_coverage(ids, locales)
    assert all(r.passed for r in results)
    assert results == []


def test_l1_missing_key_fails():
    ids = parse_loc_ids(SAMPLE_HPP)
    locales = {"fr": parse_po(L1_FAIL_PO_TEXT)}
    results = check_l1_coverage(ids, locales)
    assert len(results) == 1
    assert not results[0].passed
    assert "word:2" in results[0].reason


def test_l1_incomplete_locale_excluded():
    ids = parse_loc_ids(SAMPLE_HPP)
    # Mix: one complete locale passes, one incomplete locale is excluded
    locales = {
        "fr": parse_po(L1_PASS_PO_TEXT),
        "de": parse_po(L1_INCOMPLETE_PO_TEXT),
    }
    results = check_l1_coverage(ids, locales)
    assert results == []


def test_l1_multiple_locales_each_checked():
    ids = parse_loc_ids(SAMPLE_HPP)
    locales = {
        "fr": parse_po(L1_PASS_PO_TEXT),
        "ru": parse_po(L1_FAIL_PO_TEXT),  # missing word:2
    }
    results = check_l1_coverage(ids, locales)
    assert len(results) == 1
    assert results[0].details["locale"] == "ru"


# ── L-2: named slot consistency ───────────────────────────────────────────────
# Every locale's template declares the same named slot set as the reference.
# Reordering is allowed; adding/dropping/renaming is not.

L2_PASS_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "devant"

msgid "word:2"
msgstr "le danger"

msgid "template:1"
msgstr "{hazard} {direction}"

msgid "template:2"
msgstr "passage sûr"
"""
# template:1 reorders slots — same SET, different order → OK

L2_FAIL_RENAMED_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "devant"

msgid "word:2"
msgstr "le danger"

msgid "template:1"
msgstr "{place} {hazard}"

msgid "template:2"
msgstr "passage sûr"
"""
# template:1 renames {direction} to {place} → L-2 failure

L2_FAIL_EXTRA_SLOT_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "devant"

msgid "word:2"
msgstr "le danger"

msgid "template:1"
msgstr "{direction} {hazard} {extra}"

msgid "template:2"
msgstr "passage sûr"
"""
# template:1 adds {extra} slot → L-2 failure


def test_l2_reordered_slots_pass():
    slots = parse_template_slots(SAMPLE_HPP)
    locales = {"fr": parse_po(L2_PASS_PO_TEXT)}
    results = check_l2_slot_consistency(slots, locales)
    assert results == []


def test_l2_renamed_slot_fails():
    slots = parse_template_slots(SAMPLE_HPP)
    locales = {"fr": parse_po(L2_FAIL_RENAMED_PO_TEXT)}
    results = check_l2_slot_consistency(slots, locales)
    assert len(results) == 1
    assert not results[0].passed
    assert "template:1" in results[0].reason


def test_l2_extra_slot_fails():
    slots = parse_template_slots(SAMPLE_HPP)
    locales = {"fr": parse_po(L2_FAIL_EXTRA_SLOT_PO_TEXT)}
    results = check_l2_slot_consistency(slots, locales)
    assert len(results) == 1
    assert not results[0].passed


def test_l2_incomplete_locale_excluded():
    slots = parse_template_slots(SAMPLE_HPP)
    locales = {"de": parse_po(L1_INCOMPLETE_PO_TEXT)}
    results = check_l2_slot_consistency(slots, locales)
    assert results == []


# ── L-3: no positional placeholders ───────────────────────────────────────────
# No locale string may contain a positional placeholder ({0}, {1}, …).

L3_PASS_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "devant"

msgid "template:1"
msgstr "{direction} {hazard}"
"""

L3_FAIL_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "devant"

msgid "template:1"
msgstr "{0} {1}"
"""
# Uses positional {0} and {1} → L-3 failure


def test_l3_named_placeholders_pass():
    locales = {"fr": parse_po(L3_PASS_PO_TEXT)}
    results = check_l3_no_positional(locales)
    assert results == []


def test_l3_positional_placeholder_fails():
    locales = {"fr": parse_po(L3_FAIL_PO_TEXT)}
    results = check_l3_no_positional(locales)
    assert len(results) >= 1
    assert not results[0].passed
    assert "template:1" in results[0].reason or "{0}" in results[0].reason


def test_l3_incomplete_locale_not_excluded():
    # Incomplete locales are still checked for L-3 (positional vs named is
    # an authoring error, not a coverage gap; it should be caught early).
    bad_po = (
        'msgid ""\nmsgstr ""\n"X-Incomplete: true\\n"\n\n'
        'msgid "template:1"\nmsgstr "{0} {1}"\n'
    )
    locales = {"de": parse_po(bad_po)}
    results = check_l3_no_positional(locales)
    assert len(results) >= 1


# ── L-4: seed-phrase wordlist absent from translation catalogue ────────────────
# No seed word may appear as a msgid in any locale file, and the wordlist
# must have been parsed from exactly one authoritative source.

L4_PASS_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "devant"

msgid "word:2"
msgstr "le danger"
"""
# No seed words ("abandon", "ability", "able", "about") are msgids here → pass

L4_FAIL_PO_TEXT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "word:1"
msgstr "devant"

msgid "abandon"
msgstr "verlassen"
"""
# "abandon" is a seed word and appears as a msgid → L-4 failure


def test_l4_no_seed_words_in_catalogue_passes():
    words = parse_seed_wordlist(SAMPLE_SEED_CPP)
    locales = {"fr": parse_po(L4_PASS_PO_TEXT)}
    results = check_l4_no_seed_words(words, locales)
    assert results == []


def test_l4_seed_word_as_msgid_fails():
    words = parse_seed_wordlist(SAMPLE_SEED_CPP)
    locales = {"de": parse_po(L4_FAIL_PO_TEXT)}
    results = check_l4_no_seed_words(words, locales)
    assert len(results) == 1
    assert not results[0].passed
    assert "abandon" in results[0].reason


def test_l4_seed_word_across_locales_both_reported():
    words = parse_seed_wordlist(SAMPLE_SEED_CPP)
    locales = {
        "de": parse_po(L4_FAIL_PO_TEXT),
        "ru": parse_po(L4_FAIL_PO_TEXT),
    }
    results = check_l4_no_seed_words(words, locales)
    assert len(results) == 2


def test_l4_incomplete_locale_still_checked():
    # Incomplete locales are checked for L-4 too — the structural ban on seed
    # words in any catalogue applies regardless of completeness.
    bad_po = (
        'msgid ""\nmsgstr ""\n"X-Incomplete: true\\n"\n\n'
        'msgid "abandon"\nmsgstr "verlassen"\n'
    )
    words = parse_seed_wordlist(SAMPLE_SEED_CPP)
    locales = {"de": parse_po(bad_po)}
    results = check_l4_no_seed_words(words, locales)
    assert len(results) == 1


# ── catalogue: item_ref slot detection ───────────────────────────────────────
# Templates that reference ITEM_REF in their inline comment get "item_ref"
# added to their slot set, so L-2 can verify locale parity.

SAMPLE_HPP_ITEM_REF = """
namespace assembled {

enum class WordCategory : int16_t {
    DIRECTION = 1,
    HAZARD    = 2,
    ACTION    = 3,
    OBJECT    = 4,
    QUALIFIER = 5,
};

struct WordDef { int16_t id; WordCategory category; };
inline constexpr std::array<WordDef, 2> kWords = {{
    {1, WordCategory::DIRECTION},
    {2, WordCategory::OBJECT},
}};

struct TemplateDef { int16_t id; int16_t slots; int16_t slot_a_category; int16_t slot_b_category; };
inline constexpr std::array<TemplateDef, 2> kTemplates = {{
    {1, 0, 0, 0},   // "need {ITEM_REF}"                 — item_ref column only
    {2, 1, 4, 0},   // "{OBJECT} opens with {ITEM_REF}"  — slot_a=OBJECT + item_ref
}};

} // namespace assembled
"""


def test_parse_template_slots_item_ref_only():
    slots = parse_template_slots(SAMPLE_HPP_ITEM_REF)
    assert slots["template:1"] == {"item_ref"}


def test_parse_template_slots_word_slot_plus_item_ref():
    slots = parse_template_slots(SAMPLE_HPP_ITEM_REF)
    assert slots["template:2"] == {"object", "item_ref"}
