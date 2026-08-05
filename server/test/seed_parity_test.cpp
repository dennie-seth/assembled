/// T-0043: parity check — shared/note_templates.hpp vs. seeded DB rows.
///
/// Two tiers:
///   1. Compile-time (always runs): structural invariants on the header itself —
///      correct word/template/archetype/anchor_tag counts, unique IDs, valid
///      categories, slots ∈ {0,1,2}.  These fail to compile or assert before
///      any DB is needed.
///   2. Runtime (gated on DATABASE_URL): applies pending migrations then queries
///      note_templates, note_words, archetype, and anchor_tag, comparing every
///      row count and ID against the shared header arrays.  A drift here means
///      the SQL seed and the C++ constants diverged.

#include <doctest/doctest.h>

#include <algorithm>
#include <map>
#include <set>
#include <vector>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "shared/note_templates.hpp"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ─── Compile-time structural checks ──────────────────────────────────────────

TEST_CASE("T-0043 header: word count matches design spec (02-notes-system.md §2)") {
    CHECK(assembled::kWords.size() == 56u);
}

TEST_CASE("T-0043 header: template count matches design spec") {
    CHECK(assembled::kTemplates.size() == 20u);
}

TEST_CASE("T-0043 header: archetype count") {
    CHECK(assembled::kArchetypeIds.size() == 5u);
}

TEST_CASE("T-0043 header: anchor_tag count") {
    CHECK(assembled::kAnchorTags.size() == 24u);
}

TEST_CASE("T-0043 header: word category distribution (02-notes-system.md §2)") {
    int counts[6] = {};
    for (const auto &w : assembled::kWords) {
        const int cat = static_cast<int>(w.category);
        REQUIRE(cat >= 1);
        REQUIRE(cat <= 5);
        counts[cat]++;
    }
    CHECK(counts[1] == 8);  // DIRECTION
    CHECK(counts[2] == 12); // HAZARD
    CHECK(counts[3] == 12); // ACTION
    CHECK(counts[4] == 16); // OBJECT
    CHECK(counts[5] == 8);  // QUALIFIER
}

TEST_CASE("T-0043 header: word IDs are unique") {
    std::set<int16_t> seen;
    for (const auto &w : assembled::kWords) {
        CHECK(seen.insert(w.id).second); // fails if id is duplicated
    }
}

TEST_CASE("T-0043 header: template IDs are unique") {
    std::set<int16_t> seen;
    for (const auto &t : assembled::kTemplates) {
        CHECK(seen.insert(t.id).second);
    }
}

TEST_CASE("T-0043 header: template slots are in {0, 1, 2}") {
    for (const auto &t : assembled::kTemplates) {
        CHECK(t.slots >= 0);
        CHECK(t.slots <= 2);
    }
}

TEST_CASE("T-0043 header: anchor_tags reference valid archetype IDs") {
    const std::set<int16_t> arch_ids(assembled::kArchetypeIds.begin(),
                                     assembled::kArchetypeIds.end());
    for (const auto &at : assembled::kAnchorTags) {
        CHECK(arch_ids.count(at.archetype_id) == 1u);
    }
}

TEST_CASE("T-0043 header: anchor_tag (archetype_id, tag) pairs are unique") {
    std::set<std::pair<int16_t, int16_t>> seen;
    for (const auto &at : assembled::kAnchorTags) {
        CHECK(seen.insert({at.archetype_id, at.tag}).second);
    }
}

// ─── Runtime DB parity checks ─────────────────────────────────────────────────

/// Helper: ensure migrations are applied, then return an open DB client.
static drogon::orm::DbClientPtr requireDb() {
    auto db = assembled_server::Database::fromEnv();
    if (!db.has_value()) {
        return nullptr;
    }
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());
    return db->getClient();
}

TEST_CASE("T-0043 DB parity: note_templates row count" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT COUNT(*) AS n FROM note_templates");
    CHECK(res[0]["n"].as<int64_t>() == static_cast<int64_t>(assembled::kTemplates.size()));
}

TEST_CASE("T-0043 DB parity: note_templates IDs match shared header" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT id FROM note_templates ORDER BY id");

    std::vector<int16_t> db_ids;
    for (const auto &row : res) {
        db_ids.push_back(row["id"].as<int16_t>());
    }

    std::vector<int16_t> hdr_ids;
    for (const auto &t : assembled::kTemplates) {
        hdr_ids.push_back(t.id);
    }
    std::sort(hdr_ids.begin(), hdr_ids.end());

    CHECK(db_ids == hdr_ids);
}

TEST_CASE("T-0043 DB parity: note_words row count" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT COUNT(*) AS n FROM note_words");
    CHECK(res[0]["n"].as<int64_t>() == static_cast<int64_t>(assembled::kWords.size()));
}

TEST_CASE("T-0043 DB parity: note_words IDs match shared header" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT id FROM note_words ORDER BY id");

    std::vector<int16_t> db_ids;
    for (const auto &row : res) {
        db_ids.push_back(row["id"].as<int16_t>());
    }

    std::vector<int16_t> hdr_ids;
    for (const auto &w : assembled::kWords) {
        hdr_ids.push_back(w.id);
    }
    std::sort(hdr_ids.begin(), hdr_ids.end());

    CHECK(db_ids == hdr_ids);
}

TEST_CASE("T-0043 DB parity: note_words categories match shared header" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT id, category FROM note_words ORDER BY id");

    std::map<int16_t, int16_t> db_map;
    for (const auto &row : res) {
        db_map[row["id"].as<int16_t>()] = row["category"].as<int16_t>();
    }

    for (const auto &w : assembled::kWords) {
        REQUIRE(db_map.count(w.id) == 1u);
        CHECK(db_map[w.id] == static_cast<int16_t>(w.category));
    }
}

TEST_CASE("T-0043 DB parity: archetype row count" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT COUNT(*) AS n FROM archetype");
    CHECK(res[0]["n"].as<int64_t>() == static_cast<int64_t>(assembled::kArchetypeIds.size()));
}

TEST_CASE("T-0043 DB parity: archetype IDs match shared header" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT id FROM archetype ORDER BY id");

    std::vector<int16_t> db_ids;
    for (const auto &row : res) {
        db_ids.push_back(row["id"].as<int16_t>());
    }

    std::vector<int16_t> hdr_ids(assembled::kArchetypeIds.begin(), assembled::kArchetypeIds.end());
    std::sort(hdr_ids.begin(), hdr_ids.end());

    CHECK(db_ids == hdr_ids);
}

TEST_CASE("T-0043 DB parity: anchor_tag row count" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync("SELECT COUNT(*) AS n FROM anchor_tag");
    CHECK(res[0]["n"].as<int64_t>() == static_cast<int64_t>(assembled::kAnchorTags.size()));
}

TEST_CASE("T-0043 DB parity: anchor_tag pairs match shared header" *
          doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto client = requireDb();
    REQUIRE(client != nullptr);
    auto res = client->execSqlSync(
        "SELECT archetype_id, tag FROM anchor_tag ORDER BY archetype_id, tag");

    using Pair = std::pair<int16_t, int16_t>;
    std::vector<Pair> db_pairs;
    for (const auto &row : res) {
        db_pairs.push_back({row["archetype_id"].as<int16_t>(), row["tag"].as<int16_t>()});
    }

    std::vector<Pair> hdr_pairs;
    for (const auto &at : assembled::kAnchorTags) {
        hdr_pairs.push_back({at.archetype_id, at.tag});
    }
    std::sort(hdr_pairs.begin(), hdr_pairs.end());

    CHECK(db_pairs == hdr_pairs);
}
