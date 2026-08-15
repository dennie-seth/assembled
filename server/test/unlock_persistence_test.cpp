/// T-0127: UnlockRepo — tier-appropriate expiry and read-path invariant.
///
/// TDD: this file is committed BEFORE the implementation exists.
/// All DB TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while dev and the ci-server integration job run
/// the live DB assertions.
///
/// Acceptance criteria from T-0127:
///   - [ ] expires_at is set according to the unlock's tier via a configurable
///         duration per tier (not one hardcoded value).
///   - [ ] An expired unlock is treated as absent by every read path —
///         isValid() returns false even when the row technically still exists.
///   - [ ] Test: tactical-tier unlock is unusable after its short window
///         even though the row has not yet been swept.
///   - [ ] Test: unique-keyed unlock persists across a session boundary
///         (new lease, same identity) until its ~1-week expiry.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <chrono>
#include <cstdlib>
#include <string>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/SessionLeaseRepo.h"
#include "assembled_server/UnlockRepo.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Helpers ───────────────────────────────────────────────────────────────────

namespace {

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT DO NOTHING", token);
}

/// Seed a variant row (archetype 1 = HOSPITAL, seeded in 003_seed_vocab).
void seedVariant(const drogon::orm::DbClientPtr &db, int16_t id) {
    db->execSqlSync(
        "INSERT INTO variant (id, archetype_id) VALUES ($1, 1) ON CONFLICT DO NOTHING", id);
}

/// Insert an unlock row with a caller-supplied expires_at expression (raw SQL
/// fragment evaluated by Postgres — caller controls only the interval, not
/// free text that becomes player-visible).
void insertUnlockRaw(const drogon::orm::DbClientPtr &db, const std::string &token,
                     int16_t variant_id, int16_t tag, const std::string &expires_sql) {
    // expires_sql is a server-side constant like "now() - interval '1 second'"
    // or "now() + interval '7 days'" — never player-supplied text.
    db->execSqlSync("INSERT INTO unlock (token, variant_id, tag, expires_at) "
                    "VALUES ($1, $2, $3, " +
                        expires_sql +
                        ") "
                        "ON CONFLICT (token, variant_id, tag) DO UPDATE "
                        "SET expires_at = EXCLUDED.expires_at",
                    token, variant_id, tag);
}

void deleteUnlock(const drogon::orm::DbClientPtr &db, const std::string &token,
                  int16_t variant_id, int16_t tag) {
    db->execSqlSync("DELETE FROM unlock WHERE token=$1 AND variant_id=$2 AND tag=$3", token,
                    variant_id, tag);
}

} // namespace

// ── Unit: UnlockConfig tier durations ─────────────────────────────────────────

TEST_CASE("UnlockConfig: default tactical TTL is shorter than session TTL") {
    assembled_server::UnlockConfig cfg;
    CHECK(cfg.ttl_for_tier(assembled_server::UnlockTier::Tactical) <
          cfg.ttl_for_tier(assembled_server::UnlockTier::Session));
}

TEST_CASE("UnlockConfig: default session TTL is shorter than unique-keyed TTL") {
    assembled_server::UnlockConfig cfg;
    CHECK(cfg.ttl_for_tier(assembled_server::UnlockTier::Session) <
          cfg.ttl_for_tier(assembled_server::UnlockTier::UniqueKeyed));
}

TEST_CASE("UnlockConfig: custom durations are honoured by ttl_for_tier") {
    using namespace std::chrono_literals;
    assembled_server::UnlockConfig cfg;
    cfg.tactical_ttl = 60s;
    cfg.session_ttl = 7200s;
    cfg.unique_keyed_ttl = 604800s;

    CHECK(cfg.ttl_for_tier(assembled_server::UnlockTier::Tactical) == 60s);
    CHECK(cfg.ttl_for_tier(assembled_server::UnlockTier::Session) == 7200s);
    CHECK(cfg.ttl_for_tier(assembled_server::UnlockTier::UniqueKeyed) == 604800s);
}

// ── Integration: isValid() treats expired rows as absent ──────────────────────

TEST_CASE("isValid: live unlock row returns true") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-unlock-valid-live";
    constexpr int16_t kVariant = 901;
    constexpr int16_t kTag = 1;
    seedIdentity(db->getClient(), token);
    seedVariant(db->getClient(), kVariant);
    deleteUnlock(db->getClient(), token, kVariant, kTag);

    // Insert a row that expires one hour from now (clearly in the future).
    insertUnlockRaw(db->getClient(), token, kVariant, kTag, "now() + interval '1 hour'");

    assembled_server::PgUnlockRepo repo(db->getClient());
    CHECK(repo.isValid(token, kVariant, kTag));
}

TEST_CASE("isValid: missing unlock row returns false") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-unlock-valid-missing";
    constexpr int16_t kVariant = 902;
    constexpr int16_t kTag = 2;
    seedIdentity(db->getClient(), token);
    seedVariant(db->getClient(), kVariant);
    deleteUnlock(db->getClient(), token, kVariant, kTag);

    assembled_server::PgUnlockRepo repo(db->getClient());
    CHECK(!repo.isValid(token, kVariant, kTag));
}

/// Acceptance: "Test: tactical-tier unlock is unusable after its short window
/// even though the row technically still exists until swept."
///
/// We inject a row with expires_at in the past (simulating a swept tactical
/// window) without waiting for real wall-clock time to pass.
TEST_CASE("isValid: expired row (past expires_at) is treated as absent — tactical-tier scenario") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-unlock-tactical-expired";
    constexpr int16_t kVariant = 903;
    constexpr int16_t kTag = 3;
    seedIdentity(db->getClient(), token);
    seedVariant(db->getClient(), kVariant);
    deleteUnlock(db->getClient(), token, kVariant, kTag);

    // Row exists but expires_at is in the past — the row has not been swept yet
    // (mimicking the real scenario where the sweeper hasn't run).
    insertUnlockRaw(db->getClient(), token, kVariant, kTag, "now() - interval '1 second'");

    assembled_server::PgUnlockRepo repo(db->getClient());

    // Even though the row is physically present, isValid() must treat it as absent.
    CHECK(!repo.isValid(token, kVariant, kTag));
}

/// Acceptance: "Test: unique-keyed unlock persists across a session boundary
/// (new lease, same identity) until its ~1-week expiry."
///
/// A new lease acquisition for the same identity token does NOT invalidate the
/// unlock row — identity continuity is the token, not the lease.
TEST_CASE("isValid: unique-keyed unlock survives session boundary (new lease, same identity)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-unlock-unique-keyed-session";
    constexpr int16_t kVariant = 904;
    constexpr int16_t kTag = 4;
    seedIdentity(db->getClient(), token);
    seedVariant(db->getClient(), kVariant);
    deleteUnlock(db->getClient(), token, kVariant, kTag);

    // Insert a unique-keyed unlock (default ~7 days TTL).
    assembled_server::UnlockConfig cfg;
    const auto ttl = cfg.ttl_for_tier(assembled_server::UnlockTier::UniqueKeyed);
    const std::string expires_expr =
        "now() + interval '" + std::to_string(ttl.count()) + " seconds'";
    insertUnlockRaw(db->getClient(), token, kVariant, kTag, expires_expr);

    // Simulate session boundary: new client acquires a fresh session for the
    // same identity, evicting any existing lease.
    assembled_server::SessionLeaseRepo leaseRepo(db->getClient());
    const auto newLease = leaseRepo.acquire(token, std::chrono::seconds(30));
    CHECK(!newLease.lease_id.empty()); // sanity: lease was granted

    // Unlock must still be valid after the session boundary.
    assembled_server::PgUnlockRepo repo(db->getClient());
    CHECK(repo.isValid(token, kVariant, kTag));
}

/// Verify the unlock table has no free-text player column (UGC invariant).
TEST_CASE("unlock table has no free-text player column") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    auto result = db->getClient()->execSqlSync(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'unlock' "
        "AND column_name IN ('phrase','text','content','message','body','note')");
    CHECK(result.size() == 0);
}
