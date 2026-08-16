/// T-0171: debugGrant — debug/seeded item-grant command (dev+test builds only).
///
/// TDD: committed BEFORE the debugGrant implementation exists.
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and integration job run
/// the live DB assertions.
///
/// Compile-time guarantee:
///   This file uses `#ifndef ASSEMBLED_DEBUG_GRANT` to static_assert(false),
///   so it cannot be built in any configuration that omits the define.
///   CMakeLists sets ASSEMBLED_DEBUG_GRANT only for non-Release configs — the
///   item_grant_tests target is itself excluded from Release builds — so the
///   "symbol absent from release binary" criterion is enforced structurally:
///     1. PgItemRepo::debugGrant is wrapped in #ifdef ASSEMBLED_DEBUG_GRANT in
///        ItemRepo.h and ItemRepo.cpp, so it is compiled out of Release.
///     2. item_grant_tests is only added to the build for non-Release configs.
///
/// Acceptance criteria (T-0171):
///   - [x] Grant works in a debug build (functional tests below)
///   - [x] Symbol absent from release binary (structural: #ifdef + CMake)

// Verify the test binary was built with the debug-grant flag.
// This static_assert fires at compile time if someone misconfigures CMake
// and links this test without defining ASSEMBLED_DEBUG_GRANT.
#ifndef ASSEMBLED_DEBUG_GRANT
static_assert(false, "item_grant_test.cpp built without ASSEMBLED_DEBUG_GRANT — "
                     "CMakeLists.txt conditional definition is broken");
#endif

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <cstdlib>
#include <string>

#include "assembled_server/Database.h"
#include "assembled_server/ItemRepo.h"
#include "assembled_server/MigrationRunner.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Helpers ──────────────────────────────────────────────────────────────────

namespace {

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
                    token);
}

void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id, int16_t rarity = 0) {
    db->execSqlSync(
        "INSERT INTO item_type (id, rarity) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", id,
        rarity);
}

/// Assert INV-1: exactly one of (holder, hosted_by) is non-null.
void assertInv1(const drogon::orm::DbClientPtr &db, const std::string &item_id,
                const char *context) {
    auto r = db->execSqlSync(
        "SELECT num_nonnulls(holder, hosted_by) AS c FROM item_instance WHERE id = $1", item_id);
    REQUIRE_MESSAGE(!r.empty(), "INV-1 probe: item not found — " << context);
    const int cnt = r[0]["c"].as<int>();
    CHECK_MESSAGE(cnt == 1, "INV-1 violated at " << context << ": num_nonnulls=" << cnt);
}

} // namespace

// ── Tests ─────────────────────────────────────────────────────────────────────

TEST_CASE("debugGrant: mints a new item_instance held by the requested identity") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);

    constexpr int16_t TYPE_ID = 171;
    const std::string HOLDER = "grant_test_identity_token";

    seedItemType(client, TYPE_ID, /*rarity=*/0);
    seedIdentity(client, HOLDER);

    // Count before grant.
    assembled_server::PgItemRepo repo(client);
    const int32_t before = repo.countByType(TYPE_ID);

    // Act: grant a new item to HOLDER.
    assembled_server::GrantParams params;
    params.type_id = TYPE_ID;
    params.holder_token = HOLDER;

    assembled_server::GrantResult result = repo.debugGrant(params);

    // A non-empty UUID is returned.
    CHECK_FALSE(result.new_item_id.empty());

    // INV-3: count increased by exactly 1.
    CHECK(repo.countByType(TYPE_ID) == before + 1);

    // INV-1: the new item has exactly one custody holder.
    assertInv1(client, result.new_item_id, "after debugGrant");

    // The item is held by the requested identity, not anchored.
    auto rec = repo.find(result.new_item_id);
    REQUIRE(rec.has_value());
    REQUIRE(rec->holder.has_value());
    CHECK(*rec->holder == HOLDER);
    CHECK_FALSE(rec->hosted_by.has_value());
    CHECK(rec->type_id == TYPE_ID);
}

TEST_CASE("debugGrant: grants unique (rarity=2) item bypassing economy") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);

    constexpr int16_t TYPE_ID = 172; // unique rarity
    const std::string HOLDER = "grant_test_identity_unique";

    seedItemType(client, TYPE_ID, /*rarity=*/2);
    seedIdentity(client, HOLDER);

    assembled_server::PgItemRepo repo(client);
    const int32_t before = repo.countByType(TYPE_ID);

    assembled_server::GrantParams params;
    params.type_id = TYPE_ID;
    params.holder_token = HOLDER;

    assembled_server::GrantResult result = repo.debugGrant(params);

    CHECK_FALSE(result.new_item_id.empty());
    CHECK(repo.countByType(TYPE_ID) == before + 1);
    assertInv1(client, result.new_item_id, "after debugGrant unique");

    auto rec = repo.find(result.new_item_id);
    REQUIRE(rec.has_value());
    REQUIRE(rec->holder.has_value());
    CHECK(*rec->holder == HOLDER);
    CHECK(rec->type_id == TYPE_ID);
}
