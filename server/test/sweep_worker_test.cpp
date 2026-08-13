/// T-0125: PgSweepWorker integration tests.
/// TDD: this file is committed BEFORE the SweepWorker implementation exists.
///
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and ci-server integration
/// job run the live DB assertions.
///
/// Acceptance criteria verified here:
///   - Exactly one sweep worker instance is active per shard at a time,
///     enforced by an advisory lock. A second tryAcquireLock() returns false
///     — not an error, not a block.
///   - Bleed processing uses FOR UPDATE SKIP LOCKED: a row held inside
///     another session's open transaction is skipped (landed=0, unlanded=0),
///     not waited on.
///   - Expired item_instance rows (bleed_at < now()) are processed: common /
///     rare items re-anchor when a recipient exists; unique items (rarity=2)
///     always re-anchor (never deleted).
///   - Collapsed identities (collapse_expires_at < now()) lose their unlock
///     rows and their held items are queued for immediate bleed (bleed_at set
///     to now()).
///   - Transfer receipts older than 72 h are deleted by runRetention().
///   - type_census is upserted with live counts per type by runCensus().
///
/// Test ID reservations (do not reuse in other test files):
///   shard_id        : 7
///   item_type IDs   : 80 (common), 81 (unique)
///   variant ID      : 80  (for the unlock / collapse test)
///   identity tokens : "test-sweep-alice", "test-sweep-bob"

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <cstdlib>
#include <string>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/SweepWorker.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Test-scope constants ──────────────────────────────────────────────────────

namespace {

constexpr int16_t kTestShard = 7;
constexpr int16_t kTypeCommon = 80; // rarity 0
constexpr int16_t kTypeUnique = 81; // rarity 2
constexpr int16_t kTestVariant = 80;

const std::string kAlice = "test-sweep-alice";
const std::string kBob = "test-sweep-bob";

// ── Seed helpers ──────────────────────────────────────────────────────────────

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync(
        "INSERT INTO identity (token, collapse_expires_at) "
        "VALUES ($1, now() + INTERVAL '21 days') "
        "ON CONFLICT (token) DO NOTHING",
        token);
}

void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id, int16_t rarity) {
    db->execSqlSync("INSERT INTO item_type (id, rarity) VALUES ($1, $2) "
                    "ON CONFLICT (id) DO NOTHING",
                    id, rarity);
}

/// Insert an item held by @p holder with bleed_at in the past (immediately eligible).
/// Returns the new item UUID.
std::string seedExpiredHeldItem(const drogon::orm::DbClientPtr &db, int16_t type_id,
                                const std::string &holder, int16_t shard_id) {
    auto r = db->execSqlSync("INSERT INTO item_instance "
                             "(type_id, holder, shard_id, bleed_at) "
                             "VALUES ($1, $2, $3, now() - INTERVAL '1 hour') "
                             "RETURNING id::text",
                             type_id, holder, shard_id);
    return r[0][0].as<std::string>();
}

/// Seed a variant (needed for unlock rows in the collapse test).
void seedVariant(const drogon::orm::DbClientPtr &db, int16_t variant_id,
                 int16_t archetype_id) {
    db->execSqlSync("INSERT INTO variant (id, archetype_id) VALUES ($1, $2) "
                    "ON CONFLICT (id) DO NOTHING",
                    variant_id, archetype_id);
}

/// Seed an unlock row for @p token that has not yet expired.
void seedUnlock(const drogon::orm::DbClientPtr &db, const std::string &token,
                int16_t variant_id, int16_t tag) {
    db->execSqlSync("INSERT INTO unlock (token, variant_id, tag, expires_at) "
                    "VALUES ($1, $2, $3, now() + INTERVAL '1 day') "
                    "ON CONFLICT (token, variant_id, tag) DO NOTHING",
                    token, variant_id, tag);
}

/// Seed a transfer_receipt with an age of @p hours_ago hours.
std::string seedReceipt(const drogon::orm::DbClientPtr &db, const std::string &token,
                        double hours_ago) {
    auto r = db->execSqlSync(
        "INSERT INTO transfer_receipt "
        "(token, item_instance, kind, outcome, created_at) "
        "VALUES ($1, gen_random_uuid(), 0, 0, now() - make_interval(hours => $2)) "
        "RETURNING transfer_id::text",
        token, hours_ago);
    return r[0][0].as<std::string>();
}

/// Remove all test-scoped rows in dependency order.
void cleanup(const drogon::orm::DbClientPtr &db) {
    // receipts
    db->execSqlSync("DELETE FROM transfer_receipt "
                    "WHERE token IN ($1, $2)",
                    kAlice, kBob);
    // items (via shard or type)
    db->execSqlSync("DELETE FROM item_instance WHERE type_id IN ($1, $2)",
                    kTypeCommon, kTypeUnique);
    // unlocks
    db->execSqlSync("DELETE FROM unlock WHERE variant_id = $1", kTestVariant);
    // variant
    db->execSqlSync("DELETE FROM variant WHERE id = $1", kTestVariant);
    // economy_ledger rows written during test runs (all rows — the table is
    // append-only and small in tests)
    db->execSqlSync("DELETE FROM economy_ledger WHERE spawned = 0 AND transmute_sink = 0");
    // type_census rows for test types
    db->execSqlSync("DELETE FROM type_census WHERE type_id IN ($1, $2)",
                    kTypeCommon, kTypeUnique);
}

} // namespace

// ── Test: advisory lock singleton ─────────────────────────────────────────────

TEST_CASE("sweep advisory lock: second tryAcquireLock returns false, not error") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // Two distinct sessions — each Database is a separate connection pool.
    auto db1 = assembled_server::Database::fromEnv();
    auto db2 = assembled_server::Database::fromEnv();
    REQUIRE(db1.has_value());
    REQUIRE(db2.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db1->getClient());

    assembled_server::PgSweepWorker w1(db1->getClient(), kTestShard);
    assembled_server::PgSweepWorker w2(db2->getClient(), kTestShard);

    // w1 acquires; w2 must fail without error or block.
    REQUIRE(w1.tryAcquireLock());
    CHECK_FALSE(w2.tryAcquireLock());
    CHECK_FALSE(w2.hasLock());

    // After release, w2 can acquire.
    w1.releaseLock();
    CHECK_FALSE(w1.hasLock());
    CHECK(w2.tryAcquireLock());
    w2.releaseLock();
}

// ── Test: FOR UPDATE SKIP LOCKED ──────────────────────────────────────────────

TEST_CASE("sweep bleed: row locked by another session is skipped (SKIP LOCKED)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db1 = assembled_server::Database::fromEnv();
    auto db2 = assembled_server::Database::fromEnv();
    REQUIRE(db1.has_value());
    REQUIRE(db2.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db1->getClient());

    cleanup(db1->getClient());

    seedIdentity(db1->getClient(), kAlice);
    seedItemType(db1->getClient(), kTypeCommon, 0);
    const std::string item_id = seedExpiredHeldItem(db1->getClient(), kTypeCommon, kAlice, kTestShard);

    // db1 opens a transaction and locks the bleed row.
    auto txn = db1->getClient()->newTransaction();
    auto locked = txn->execSqlSync(
        "SELECT id FROM item_instance "
        "WHERE bleed_at < now() AND shard_id = $1 "
        "FOR UPDATE",
        kTestShard);
    REQUIRE_MESSAGE(!locked.empty(), "sanity: bleed row must exist before SKIP LOCKED test");

    // Worker B (db2) runs bleed — the locked row must be skipped, not blocked.
    assembled_server::PgSweepWorker worker_b(db2->getClient(), kTestShard);
    const auto skipped = worker_b.runBleed();
    CHECK(skipped.landed == 0);
    CHECK(skipped.unlanded == 0);

    // Release db1's lock by letting txn go out of scope → auto-rollback.
    // After rollback, the row is unlocked and worker_b can process it.
    txn.reset();

    const auto processed = worker_b.runBleed();
    CHECK(processed.landed + processed.unlanded >= 1);
}

// ── Test: bleed — common item re-anchors when recipient exists ────────────────

TEST_CASE("sweep bleed: expired common item re-anchors when a recipient exists") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    cleanup(db->getClient());

    seedIdentity(db->getClient(), kAlice);
    seedItemType(db->getClient(), kTypeCommon, 0);
    const std::string item_id =
        seedExpiredHeldItem(db->getClient(), kTypeCommon, kAlice, kTestShard);

    assembled_server::PgSweepWorker worker(db->getClient(), kTestShard);
    const auto result = worker.runBleed();

    // The item must have been re-anchored (landed) since at least one
    // identity exists as a recipient candidate.
    CHECK(result.landed >= 1);

    // Item must now be in the world (holder NULL, hosted_by set).
    auto row = db->getClient()->execSqlSync(
        "SELECT holder, hosted_by FROM item_instance WHERE id = $1::uuid", item_id);
    REQUIRE(!row.empty());
    CHECK(row[0]["holder"].isNull());
    CHECK_FALSE(row[0]["hosted_by"].isNull());
}

// ── Test: bleed — unique item always re-anchors ───────────────────────────────

TEST_CASE("sweep bleed: expired unique item always re-anchors (never deleted)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    cleanup(db->getClient());

    seedIdentity(db->getClient(), kBob);
    seedItemType(db->getClient(), kTypeUnique, 2); // rarity 2 = unique
    const std::string item_id =
        seedExpiredHeldItem(db->getClient(), kTypeUnique, kBob, kTestShard);

    assembled_server::PgSweepWorker worker(db->getClient(), kTestShard);
    const auto result = worker.runBleed();

    // Unique must never count as unlanded (never deleted).
    CHECK(result.unlanded == 0);

    // The unique item must still exist.
    auto row = db->getClient()->execSqlSync(
        "SELECT id FROM item_instance WHERE id = $1::uuid", item_id);
    CHECK(!row.empty());
}

// ── Test: collapse ────────────────────────────────────────────────────────────

TEST_CASE("sweep collapse: expired identity loses unlocks and held items get bleed_at=now()") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    cleanup(db->getClient());

    // Seed an identity whose universe has already expired.
    db->getClient()->execSqlSync(
        "INSERT INTO identity (token, collapse_expires_at) "
        "VALUES ($1, now() - INTERVAL '1 hour') "
        "ON CONFLICT (token) DO UPDATE SET collapse_expires_at = now() - INTERVAL '1 hour'",
        kAlice);

    // Seed a variant and an unlock for alice.
    seedVariant(db->getClient(), kTestVariant, 1);
    seedUnlock(db->getClient(), kAlice, kTestVariant, 1);

    // Seed a held item for alice (bleed_at is in the future — it should NOT
    // be expired already; the collapse phase sets it to now() to scatter it).
    seedItemType(db->getClient(), kTypeCommon, 0);
    const std::string item_id = [&] {
        auto r = db->getClient()->execSqlSync(
            "INSERT INTO item_instance (type_id, holder, shard_id, bleed_at) "
            "VALUES ($1, $2, $3, now() + INTERVAL '1 hour') "
            "RETURNING id::text",
            kTypeCommon, kAlice, kTestShard);
        return r[0][0].as<std::string>();
    }();

    assembled_server::PgSweepWorker worker(db->getClient(), kTestShard);
    const int32_t collapsed = worker.runCollapse();

    // At least alice's universe was collapsed.
    CHECK(collapsed >= 1);

    // Unlock must be gone.
    auto lock_row = db->getClient()->execSqlSync(
        "SELECT 1 FROM unlock WHERE token = $1 AND variant_id = $2", kAlice, kTestVariant);
    CHECK(lock_row.empty());

    // Held item must have bleed_at <= now() (queued for immediate scatter).
    auto item_row = db->getClient()->execSqlSync(
        "SELECT bleed_at <= now() AS expired FROM item_instance WHERE id = $1::uuid", item_id);
    REQUIRE(!item_row.empty());
    CHECK(item_row[0]["expired"].as<bool>());

    // Alice's collapse_expires_at must be reset to the future.
    auto id_row = db->getClient()->execSqlSync(
        "SELECT collapse_expires_at > now() AS future FROM identity WHERE token = $1", kAlice);
    REQUIRE(!id_row.empty());
    CHECK(id_row[0]["future"].as<bool>());
}

// ── Test: retention ───────────────────────────────────────────────────────────

TEST_CASE("sweep retention: transfer receipts older than 72h are purged") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Cleanup before seeding to avoid leftover state.
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE token IN ($1, $2)",
                                 kAlice, kBob);
    seedIdentity(db->getClient(), kAlice);

    // Old receipt (73 h ago) — must be purged.
    const std::string old_id = seedReceipt(db->getClient(), kAlice, 73.0);
    // Recent receipt (1 h ago) — must be retained.
    const std::string new_id = seedReceipt(db->getClient(), kAlice, 1.0);

    assembled_server::PgSweepWorker worker(db->getClient(), kTestShard);
    const int32_t purged = worker.runRetention();

    CHECK(purged >= 1);

    // Old receipt must be gone.
    auto old_row = db->getClient()->execSqlSync(
        "SELECT 1 FROM transfer_receipt WHERE transfer_id = $1::uuid", old_id);
    CHECK(old_row.empty());

    // Recent receipt must still exist.
    auto new_row = db->getClient()->execSqlSync(
        "SELECT 1 FROM transfer_receipt WHERE transfer_id = $1::uuid", new_id);
    CHECK(!new_row.empty());
}

// ── Test: census ──────────────────────────────────────────────────────────────

TEST_CASE("sweep census: type_census is upserted with live item counts") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    cleanup(db->getClient());

    seedIdentity(db->getClient(), kAlice);
    seedItemType(db->getClient(), kTypeCommon, 0);

    // Seed two items of the test type with a future bleed_at (not eligible for
    // bleed, so they won't disappear during the census test).
    for (int i = 0; i < 2; ++i) {
        db->getClient()->execSqlSync(
            "INSERT INTO item_instance (type_id, holder, shard_id, bleed_at) "
            "VALUES ($1, $2, $3, now() + INTERVAL '1 hour')",
            kTypeCommon, kAlice, kTestShard);
    }

    assembled_server::PgSweepWorker worker(db->getClient(), kTestShard);
    const int32_t updated = worker.runCensus();

    CHECK(updated >= 1);

    // type_census must reflect the live count for our test type.
    auto row = db->getClient()->execSqlSync(
        "SELECT live_count FROM type_census WHERE type_id = $1", kTypeCommon);
    REQUIRE(!row.empty());
    CHECK(row[0]["live_count"].as<int32_t>() >= 2);
}

// ── Test: runOnce honours the advisory lock ───────────────────────────────────

TEST_CASE("sweep runOnce: second worker on same shard does no work") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db1 = assembled_server::Database::fromEnv();
    auto db2 = assembled_server::Database::fromEnv();
    REQUIRE(db1.has_value());
    REQUIRE(db2.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db1->getClient());

    // w1 holds the advisory lock explicitly before w2 attempts runOnce.
    assembled_server::PgSweepWorker w1(db1->getClient(), kTestShard);
    assembled_server::PgSweepWorker w2(db2->getClient(), kTestShard);

    REQUIRE(w1.tryAcquireLock());

    // w2.runOnce() must return immediately with lock_acquired=false.
    const auto r2 = w2.runOnce();
    CHECK_FALSE(r2.lock_acquired);

    w1.releaseLock();
}
