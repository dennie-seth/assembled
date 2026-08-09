/// T-0096: Two-player economy integration test (INV-1/2/3).
/// TDD: this file is committed BEFORE the real ItemRepo implementation exists.
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and ci-server integration
/// job run the live DB assertions.
///
/// Scenario (docs/design/08-invariants.md §1):
///   A holds item X.
///   A calls leave → X moves to world anchor in B's universe.
///   B calls take  → X moves to B's inventory.
///   C calls take with stale version → CAS conflict, C does not get X.
///
/// Assertions:
///   INV-1: Every item_instance has exactly one non-null entry in
///           (holder, hosted_by) at all times.
///   INV-2: Each transfer wins at most once; C's take returns Lost,
///           meaning only one receipt can ever read "Won".
///   INV-3: count(item_instance WHERE type_id=X) is unchanged by
///           leave/take — they are moves, not spawns or deletions.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <cstdlib>
#include <optional>
#include <string>

#include "assembled_server/Database.h"
#include "assembled_server/ItemRepo.h"
#include "assembled_server/MigrationRunner.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Helpers ──────────────────────────────────────────────────────────────────

namespace {

/// Insert a bare identity row (satisfies FK on item_instance.holder /
/// hosted_by).  ON CONFLICT DO NOTHING is idempotent across test runs.
void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
                    token);
}

/// Insert a test item_type row.  Idempotent.
void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id, int16_t rarity = 0) {
    db->execSqlSync(
        "INSERT INTO item_type (id, rarity) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", id,
        rarity);
}

/// Insert an item_instance held by @p holder_token at version 0.
/// Returns the newly minted UUID.
std::string seedHeldItem(const drogon::orm::DbClientPtr &db, int16_t type_id,
                         const std::string &holder_token) {
    auto result = db->execSqlSync("INSERT INTO item_instance (type_id, holder, bleed_at) "
                                  "VALUES ($1, $2, now() + INTERVAL '1 hour') "
                                  "RETURNING id",
                                  type_id, holder_token);
    return result[0][0].as<std::string>();
}

/// Probe the item_instance row and assert INV-1: exactly one of (holder,
/// hosted_by) is non-null.  Fails the test if the item is not found or if
/// both/neither fields are populated.
void assertInv1(const drogon::orm::DbClientPtr &db, const std::string &item_id,
                const char *context) {
    auto r = db->execSqlSync(
        "SELECT num_nonnulls(holder, hosted_by) AS c FROM item_instance WHERE id = $1", item_id);
    REQUIRE_MESSAGE(!r.empty(), "INV-1 probe: item not found — " << context);
    const int cnt = r[0]["c"].as<int>();
    CHECK_MESSAGE(cnt == 1, "INV-1 violated at " << context << ": num_nonnulls=" << cnt);
}

/// Assert INV-3: the total count of item_instance rows for type_id has not
/// changed from @p expected.
void assertInv3(const drogon::orm::DbClientPtr &db, int16_t type_id, int32_t expected,
                const char *context) {
    auto r =
        db->execSqlSync("SELECT COUNT(*)::int AS c FROM item_instance WHERE type_id = $1", type_id);
    const int32_t cnt = r[0]["c"].as<int32_t>();
    CHECK_MESSAGE(cnt == expected,
                  "INV-3 violated at " << context << ": count=" << cnt << " expected=" << expected);
}

} // namespace

// ── Integration: full A-leaves / B-takes / C-fails scenario ──────────────────

TEST_CASE("two-player economy: A leaves, B takes, C loses (INV-1/2/3)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // ── Identities ────────────────────────────────────────────────────────────
    const std::string token_a = "test-economy-identity-a";
    const std::string token_b = "test-economy-identity-b";
    const std::string token_c = "test-economy-identity-c";
    seedIdentity(db->getClient(), token_a);
    seedIdentity(db->getClient(), token_b);
    seedIdentity(db->getClient(), token_c);

    // ── Item type ─────────────────────────────────────────────────────────────
    constexpr int16_t kTypeId = 99; // test-only type; unlikely to collide
    seedItemType(db->getClient(), kTypeId, 0);

    // ── Seed: A holds item X ──────────────────────────────────────────────────
    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_a);

    // INV-3 baseline: one instance of this type in the world.
    const int32_t baseline_count = 1;
    assertInv3(db->getClient(), kTypeId, baseline_count, "after seed");
    assertInv1(db->getClient(), item_id, "after seed (A holds)");

    // ── Step 1: A leaves item X at anchor (archetype=1, tag=1) in B's universe ─
    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::LeaveParams leave_params;
    leave_params.item_id = item_id;
    leave_params.holder_token = token_a;
    leave_params.expected_version = 0;
    leave_params.hosted_by_token = token_b; // B's universe hosts the anchor
    leave_params.anchor_arch = 1;           // HOSPITAL archetype (seeded in 003)
    leave_params.anchor_tag = 1;            // first anchor tag for HOSPITAL

    const auto leave_result = repo.leave(leave_params);

    CHECK(leave_result.status == assembled_server::TransferStatus::Won);
    CHECK(leave_result.new_version == 1);
    CHECK(leave_result.new_custody_depth == 1); // INV-5: depth incremented

    // A no longer holds X.
    {
        auto r =
            db->getClient()->execSqlSync("SELECT holder FROM item_instance WHERE id = $1", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull()); // A's grip is gone
    }

    assertInv1(db->getClient(), item_id, "after A leaves");
    assertInv3(db->getClient(), kTypeId, baseline_count, "after A leaves (INV-3)");

    // ── Step 2: B takes item X ────────────────────────────────────────────────
    assembled_server::TakeParams take_b_params;
    take_b_params.item_id = item_id;
    take_b_params.taker_token = token_b;
    take_b_params.expected_version = leave_result.new_version; // version is now 1

    const auto take_b_result = repo.take(take_b_params);

    CHECK(take_b_result.status == assembled_server::TransferStatus::Won);
    CHECK(take_b_result.new_version == 2);
    CHECK(take_b_result.new_custody_depth == 2); // INV-5: depth again incremented

    // B now holds X.
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder, hosted_by FROM item_instance WHERE id = $1", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].as<std::string>() == token_b);
        CHECK(r[0]["hosted_by"].isNull());
    }

    assertInv1(db->getClient(), item_id, "after B takes");
    assertInv3(db->getClient(), kTypeId, baseline_count, "after B takes (INV-3)");

    // ── Step 3: C tries to take the same item — must observe a CAS conflict ───
    // C presents the pre-B version (1), but version is now 2: CAS must lose.
    assembled_server::TakeParams take_c_params;
    take_c_params.item_id = item_id;
    take_c_params.taker_token = token_c;
    take_c_params.expected_version = 1; // stale — B already advanced it to 2

    const auto take_c_result = repo.take(take_c_params);

    // INV-2: C's take must lose — exactly one recipient (B) wins.
    CHECK(take_c_result.status == assembled_server::TransferStatus::Lost);

    // C does not hold X: holder is still B.
    {
        auto r =
            db->getClient()->execSqlSync("SELECT holder FROM item_instance WHERE id = $1", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].as<std::string>() == token_b);
    }

    // INV-1 and INV-3 hold at the end.
    assertInv1(db->getClient(), item_id, "after C fails (INV-1)");
    assertInv3(db->getClient(), kTypeId, baseline_count, "after C fails (INV-3)");
}

// ── Integration: concurrent takers — only one wins ───────────────────────────

TEST_CASE("concurrent take: exactly one of two takers wins (INV-2)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_owner = "test-conc-owner";
    const std::string token_p1 = "test-conc-player1";
    const std::string token_p2 = "test-conc-player2";
    seedIdentity(db->getClient(), token_owner);
    seedIdentity(db->getClient(), token_p1);
    seedIdentity(db->getClient(), token_p2);

    constexpr int16_t kTypeId = 98;
    seedItemType(db->getClient(), kTypeId, 0);

    // owner leaves an item at anchor (1, 2) in p1's universe
    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_owner);

    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::LeaveParams lp;
    lp.item_id = item_id;
    lp.holder_token = token_owner;
    lp.expected_version = 0;
    lp.hosted_by_token = token_p1;
    lp.anchor_arch = 1;
    lp.anchor_tag = 2; // HOSPITAL tag 2 (seeded in 003)

    const auto lresult = repo.leave(lp);
    REQUIRE(lresult.status == assembled_server::TransferStatus::Won);

    // Both p1 and p2 attempt to take with the same version (simulating a race).
    assembled_server::TakeParams tp1;
    tp1.item_id = item_id;
    tp1.taker_token = token_p1;
    tp1.expected_version = lresult.new_version;

    assembled_server::TakeParams tp2;
    tp2.item_id = item_id;
    tp2.taker_token = token_p2;
    tp2.expected_version = lresult.new_version;

    const auto r1 = repo.take(tp1);
    const auto r2 = repo.take(tp2); // version already advanced by r1 if r1 Won

    // INV-2: exactly one wins.
    const int wins = (r1.status == assembled_server::TransferStatus::Won ? 1 : 0) +
                     (r2.status == assembled_server::TransferStatus::Won ? 1 : 0);
    CHECK(wins == 1);

    // INV-1: single custody after both attempts.
    assertInv1(db->getClient(), item_id, "after concurrent takes");

    // INV-3: still exactly one instance.
    assertInv3(db->getClient(), kTypeId, 1, "after concurrent takes (INV-3)");
}

// ── Integration: custody_depth is strictly monotonic (INV-5) ─────────────────

TEST_CASE("custody_depth strictly increases on each transfer (INV-5)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_a = "test-depth-a";
    const std::string token_b = "test-depth-b";
    seedIdentity(db->getClient(), token_a);
    seedIdentity(db->getClient(), token_b);

    constexpr int16_t kTypeId = 97;
    seedItemType(db->getClient(), kTypeId, 0);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_a);

    assembled_server::PgItemRepo repo(db->getClient());

    // leave: depth 0 -> 1
    assembled_server::LeaveParams lp;
    lp.item_id = item_id;
    lp.holder_token = token_a;
    lp.expected_version = 0;
    lp.hosted_by_token = token_b;
    lp.anchor_arch = 1;
    lp.anchor_tag = 1;

    const auto lr = repo.leave(lp);
    REQUIRE(lr.status == assembled_server::TransferStatus::Won);
    CHECK(lr.new_custody_depth == 1);

    // take: depth 1 -> 2
    assembled_server::TakeParams tp;
    tp.item_id = item_id;
    tp.taker_token = token_b;
    tp.expected_version = lr.new_version;

    const auto tr = repo.take(tp);
    REQUIRE(tr.status == assembled_server::TransferStatus::Won);
    CHECK(tr.new_custody_depth == 2);

    // Depth in the DB must equal 2.
    auto r = db->getClient()->execSqlSync("SELECT custody_depth FROM item_instance WHERE id = $1",
                                          item_id);
    REQUIRE(!r.empty());
    CHECK(r[0]["custody_depth"].as<int32_t>() == 2);
}

// ── Static: item_instance has no free-text player column (UGC invariant) ─────

TEST_CASE("item_instance table has no free-text player column (UGC)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // The only TEXT columns (holder, hosted_by) are FK references to
    // identity.token which is server-minted.  There must be no column that
    // could hold arbitrary player text.
    auto result = db->getClient()->execSqlSync(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'item_instance' "
        "AND column_name IN ('phrase','text','content','message','body','note','name','label')");
    CHECK(result.size() == 0);
}
