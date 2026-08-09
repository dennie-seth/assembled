/// T-0123: RunAssembler integration tests.
/// TDD: this file is committed BEFORE the implementation exists.
///
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and ci-server integration
/// job run the live DB assertions.
///
/// Acceptance criteria verified here:
///   - Exactly 3 archetypes are assembled, one variant each (distinct archetype_ids).
///   - Only variants whose unlock_population <= current population are eligible
///     (V-9 gating; an ineligible variant is never selected regardless of
///     how many times assembly runs).
///   - Room counts across the 3 selected variants sum to at most 18
///     (01-vision.md §7).
///   - The assembled set is recorded in run_variant and archetype_seen
///     (04-data-model.md §6) so proof-of-play checks (D-12) have something
///     to query.
///   - Two consecutive assemblies for the same population can produce
///     different archetype/variant combinations (selection is not hardcoded).
///
/// Test archetype IDs 50-66 and variant IDs 50-80 are reserved for this
/// file; they fall outside the seeded catalogue (archetypes 1-5, 003_seed_vocab)
/// so tests do not interfere with production seed data.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <algorithm>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/RunAssembler.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Helpers ──────────────────────────────────────────────────────────────────

namespace {

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
                    token);
}

void seedArchetype(const drogon::orm::DbClientPtr &db, int16_t id) {
    db->execSqlSync("INSERT INTO archetype (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", id);
}

void seedVariant(const drogon::orm::DbClientPtr &db, int16_t id, int16_t archetype_id,
                 int32_t unlock_population, int16_t room_count) {
    db->execSqlSync("INSERT INTO variant (id, archetype_id, unlock_population, room_count) "
                    "VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
                    id, archetype_id, unlock_population, room_count);
}

/// Remove all test data seeded by this test file so each TEST_CASE starts clean.
/// Must be called at the START of each test case, not the end — guards against
/// a previous crashed run leaving debris.
void cleanupTestData(const drogon::orm::DbClientPtr &db, const std::string &token,
                     int16_t variant_lo, int16_t variant_hi, int16_t arch_lo, int16_t arch_hi) {
    // Order respects FK constraints: dependents before parents.
    // Delete by range first to catch cross-token rows: a prior test's assembly may
    // have selected archetypes/variants from this range (all test archetypes share
    // the same DB), so we cannot limit these deletes to a single token.
    db->execSqlSync("DELETE FROM run_variant WHERE variant_id BETWEEN $1 AND $2", variant_lo,
                    variant_hi);
    db->execSqlSync("DELETE FROM run_variant WHERE run_id IN (SELECT id FROM run WHERE token = $1)",
                    token);
    db->execSqlSync("DELETE FROM archetype_seen WHERE archetype_id BETWEEN $1 AND $2", arch_lo,
                    arch_hi);
    db->execSqlSync("DELETE FROM archetype_seen WHERE token = $1", token);
    db->execSqlSync("DELETE FROM run WHERE token = $1", token);
    db->execSqlSync("DELETE FROM unlock WHERE variant_id BETWEEN $1 AND $2", variant_lo,
                    variant_hi);
    db->execSqlSync("DELETE FROM variant WHERE id BETWEEN $1 AND $2", variant_lo, variant_hi);
    db->execSqlSync("DELETE FROM archetype WHERE id BETWEEN $1 AND $2", arch_lo, arch_hi);
}

} // namespace

// ── Test cases ────────────────────────────────────────────────────────────────

TEST_CASE("assemble: exactly 3 archetypes and one variant each") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-run-asm-t1";
    // Archetypes 50-52, variants 50-52.
    cleanupTestData(db->getClient(), token, 50, 52, 50, 52);

    seedArchetype(db->getClient(), 50);
    seedArchetype(db->getClient(), 51);
    seedArchetype(db->getClient(), 52);
    seedIdentity(db->getClient(), token);

    // One eligible variant per archetype, 6 rooms each (6+6+6=18 <= 18).
    seedVariant(db->getClient(), 50, 50, 0, 6);
    seedVariant(db->getClient(), 51, 51, 0, 6);
    seedVariant(db->getClient(), 52, 52, 0, 6);

    assembled_server::PgRunAssembler assembler(db->getClient());
    auto result = assembler.assemble({token, 0});

    REQUIRE(result.has_value());
    CHECK(result->selections.size() == 3);

    // All 3 archetype_ids must be distinct.
    std::set<int16_t> arch_ids;
    for (const auto &sel : result->selections) {
        arch_ids.insert(sel.archetype_id);
    }
    CHECK(arch_ids.size() == 3);

    // Each selection must carry a non-zero variant_id.
    for (const auto &sel : result->selections) {
        CHECK(sel.variant_id != 0);
        CHECK(sel.room_count > 0);
    }
}

TEST_CASE("assemble: ineligible variant (unlock_population above current) is never selected") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-run-asm-t2";
    // Archetypes 53-55, variants 53-56.
    cleanupTestData(db->getClient(), token, 53, 56, 53, 55);

    seedArchetype(db->getClient(), 53);
    seedArchetype(db->getClient(), 54);
    seedArchetype(db->getClient(), 55);
    seedIdentity(db->getClient(), token);

    // Archetype 53 has two variants:
    //   variant 53 — eligible (unlock_population=0)
    //   variant 54 — ineligible (unlock_population=999)
    // Archetypes 54 and 55 each have one eligible variant.
    seedVariant(db->getClient(), 53, 53, 0, 6);   // eligible
    seedVariant(db->getClient(), 54, 53, 999, 6); // ineligible at population=0
    seedVariant(db->getClient(), 55, 54, 0, 6);
    seedVariant(db->getClient(), 56, 55, 0, 6);

    assembled_server::PgRunAssembler assembler(db->getClient());

    // Run assembly many times; the ineligible variant (id=54) must never appear.
    for (int run = 0; run < 40; ++run) {
        auto result = assembler.assemble({token, 0}); // population=0 < 999
        REQUIRE_MESSAGE(result.has_value(), "assemble returned nullopt on iteration " << run);
        for (const auto &sel : result->selections) {
            CHECK_MESSAGE(sel.variant_id != 54,
                          "ineligible variant 54 was selected on iteration " << run);
        }
    }
}

TEST_CASE("assemble: two consecutive assemblies can produce different results") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-run-asm-t3";
    // Archetypes 56-60, variants 57-71 (3 variants per archetype, 6 rooms each).
    cleanupTestData(db->getClient(), token, 57, 71, 56, 60);

    for (int16_t aid = 56; aid <= 60; ++aid) {
        seedArchetype(db->getClient(), aid);
    }
    seedIdentity(db->getClient(), token);

    // 5 archetypes x 3 variants = 270 valid assembly combinations at 6 rooms each.
    // C(5,3) = 10 archetype combos; each times 3^3 = 27 variant combos per set.
    int16_t vid = 57;
    for (int16_t aid = 56; aid <= 60; ++aid) {
        for (int v = 0; v < 3; ++v, ++vid) {
            seedVariant(db->getClient(), vid, aid, 0, 6);
        }
    }

    assembled_server::PgRunAssembler assembler(db->getClient());

    // Collect results; at least 2 of 50 runs must differ.
    std::set<std::tuple<int16_t, int16_t, int16_t>> seen_arch_combos;
    for (int run = 0; run < 50; ++run) {
        auto result = assembler.assemble({token, 0});
        REQUIRE_MESSAGE(result.has_value(), "assemble returned nullopt on iteration " << run);
        REQUIRE(result->selections.size() == 3);

        const auto &s = result->selections;
        seen_arch_combos.insert({s[0].archetype_id, s[1].archetype_id, s[2].archetype_id});
    }

    CHECK_MESSAGE(seen_arch_combos.size() >= 2,
                  "all 50 assemblies produced identical archetype combinations — "
                  "selection appears hardcoded");
}

TEST_CASE("assemble: room counts always sum to at most 18") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-run-asm-t4";
    // Archetypes 61-63, variants 72-77.
    // Each archetype has a large variant (8 rooms) and a small variant (5 rooms).
    // Unconstrained selection would yield combos like 8+8+8=24 > 18; the
    // assembler must reject those and always land on a valid combination.
    cleanupTestData(db->getClient(), token, 72, 77, 61, 63);

    seedArchetype(db->getClient(), 61);
    seedArchetype(db->getClient(), 62);
    seedArchetype(db->getClient(), 63);
    seedIdentity(db->getClient(), token);

    seedVariant(db->getClient(), 72, 61, 0, 8); // arch 61, large
    seedVariant(db->getClient(), 73, 61, 0, 5); // arch 61, small
    seedVariant(db->getClient(), 74, 62, 0, 8); // arch 62, large
    seedVariant(db->getClient(), 75, 62, 0, 5); // arch 62, small
    seedVariant(db->getClient(), 76, 63, 0, 8); // arch 63, large
    seedVariant(db->getClient(), 77, 63, 0, 5); // arch 63, small

    assembled_server::PgRunAssembler assembler(db->getClient());

    for (int run = 0; run < 40; ++run) {
        auto result = assembler.assemble({token, 0});
        REQUIRE_MESSAGE(result.has_value(), "assemble returned nullopt on iteration " << run);
        REQUIRE(result->selections.size() == 3);

        int32_t total_rooms = 0;
        for (const auto &sel : result->selections) {
            total_rooms += sel.room_count;
        }
        CHECK_MESSAGE(total_rooms <= 18,
                      "room cap violated on iteration " << run << ": total=" << total_rooms);
    }
}

TEST_CASE("assemble: result is recorded in run_variant and archetype_seen") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-run-asm-t5";
    // Widen cleanup to the full test range (50-80 / 50-66) so archetypes seeded by
    // earlier test cases are removed before assembly runs.  Without this, the
    // assembler could draw from the shared pool (archetypes 50-63 still in the DB
    // after tests t1-t4), producing archetype_seen rows outside {64,65,66} and
    // causing the idempotency count to come up short.
    cleanupTestData(db->getClient(), token, 50, 80, 50, 66);

    seedArchetype(db->getClient(), 64);
    seedArchetype(db->getClient(), 65);
    seedArchetype(db->getClient(), 66);
    seedIdentity(db->getClient(), token);

    seedVariant(db->getClient(), 78, 64, 0, 6);
    seedVariant(db->getClient(), 79, 65, 0, 6);
    seedVariant(db->getClient(), 80, 66, 0, 6);

    assembled_server::PgRunAssembler assembler(db->getClient());
    auto result = assembler.assemble({token, 0});

    REQUIRE(result.has_value());
    REQUIRE(!result->run_id.empty());
    REQUIRE(result->selections.size() == 3);

    // run_variant: exactly 3 rows for this run_id.
    auto rv = db->getClient()->execSqlSync(
        "SELECT COUNT(*)::int AS c FROM run_variant WHERE run_id = $1::uuid", result->run_id);
    CHECK(rv[0]["c"].as<int>() == 3);

    // Each selected variant_id must appear in run_variant.
    for (const auto &sel : result->selections) {
        auto check = db->getClient()->execSqlSync(
            "SELECT 1 FROM run_variant WHERE run_id = $1::uuid AND variant_id = $2", result->run_id,
            sel.variant_id);
        CHECK_MESSAGE(!check.empty(),
                      "variant_id " << sel.variant_id << " missing from run_variant");
    }

    // archetype_seen: exactly 3 rows for this token (one per assembled archetype).
    auto as_rows = db->getClient()->execSqlSync(
        "SELECT archetype_id FROM archetype_seen WHERE token = $1", token);
    CHECK(as_rows.size() == 3);

    // Each assembled archetype_id must be present.
    std::set<int16_t> seen_arch_ids;
    for (size_t i = 0; i < as_rows.size(); ++i) {
        seen_arch_ids.insert(as_rows[i]["archetype_id"].as<int16_t>());
    }
    for (const auto &sel : result->selections) {
        CHECK_MESSAGE(seen_arch_ids.count(sel.archetype_id) == 1,
                      "archetype_id " << sel.archetype_id << " missing from archetype_seen");
    }

    // archetype_seen is idempotent: a second assembly upserts, not duplicates.
    auto result2 = assembler.assemble({token, 0});
    REQUIRE(result2.has_value());

    auto as_rows2 =
        db->getClient()->execSqlSync("SELECT COUNT(*)::int AS c FROM archetype_seen WHERE token = "
                                     "$1 AND archetype_id IN (64, 65, 66)",
                                     token);
    CHECK(as_rows2[0]["c"].as<int>() == 3);
}

/// Teardown — must be the last TEST_CASE in this file.
/// Removes all test data (archetypes 50-66, variants 50-80) so sibling test
/// executables (e.g. seed_parity_test) do not see leftover rows from this suite.
TEST_CASE("assemble: teardown — remove all test data from DB") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    // Call for each test token so run rows are also cleaned up.
    for (const auto *tok : {"test-run-asm-t1", "test-run-asm-t2", "test-run-asm-t3",
                            "test-run-asm-t4", "test-run-asm-t5"}) {
        cleanupTestData(db->getClient(), tok, 50, 80, 50, 66);
    }
}
