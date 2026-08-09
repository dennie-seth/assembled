/// T-0093: SessionLeaseRepo tests — heartbeat, TTL, evict-on-takeover (INV-11).
/// TDD: this file is committed BEFORE the implementation exists.
///
/// All integration TEST_CASEs gate on DATABASE_URL so CI without a Postgres
/// container stays green (build-only) while dev and the ci-server integration
/// job run the live DB assertions.
///
/// Acceptance criteria:
///   - Acquiring a session issues a fresh lease_id + short TTL, evicting any
///     existing live lease for that identity.
///   - Lease expiry makes the session reclaimable.
///   - Takeover evicts the prior session (its next heartbeat fails).
///   - Crash recovery: a client that stops heartbeating is not permanently
///     locked out once the TTL elapses.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/SessionLeaseRepo.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Helpers ──────────────────────────────────────────────────────────────────

namespace {

/// Short TTL used across tests that need expiry: 1 second.
constexpr std::chrono::seconds kShortTtl{1};

/// Margin added on top of kShortTtl when sleeping to ensure the row has
/// expired by the time the assertion runs.
constexpr std::chrono::milliseconds kExpiryMargin{500};

/// Seed a bare identity row so FK constraints on session_lease are satisfied.
void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
                    token);
}

} // namespace

// ── Integration: SessionLeaseRepo ────────────────────────────────────────────

TEST_CASE("acquire returns a non-empty lease_id and a future expires_at") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-lease-acquire-basic";
    seedIdentity(db->getClient(), token);

    assembled_server::SessionLeaseRepo repo(db->getClient());
    const auto result = repo.acquire(token, std::chrono::seconds(30));

    CHECK(!result.lease_id.empty());
    CHECK(result.expires_at > std::chrono::system_clock::now());
}

TEST_CASE("acquire evicts any existing live lease") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-lease-evict";
    seedIdentity(db->getClient(), token);

    assembled_server::SessionLeaseRepo repo(db->getClient());

    const auto first = repo.acquire(token, std::chrono::seconds(30));
    const auto second = repo.acquire(token, std::chrono::seconds(30));

    // A new lease_id is issued on every acquire.
    CHECK(first.lease_id != second.lease_id);

    // The first lease is no longer alive after takeover.
    CHECK(!repo.isAlive(token, first.lease_id));

    // The second lease is live.
    CHECK(repo.isAlive(token, second.lease_id));
}

TEST_CASE("takeover: prior session heartbeat fails after eviction") {
    // Acceptance: "Test: takeover evicts the prior session (its next heartbeat fails)"
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-lease-takeover";
    seedIdentity(db->getClient(), token);

    assembled_server::SessionLeaseRepo repo(db->getClient());

    const auto old_lease = repo.acquire(token, std::chrono::seconds(30));

    // Takeover: a new client acquires the session.
    repo.acquire(token, std::chrono::seconds(30));

    // The evicted client's heartbeat must return false.
    const bool hb = repo.heartbeat(token, old_lease.lease_id, std::chrono::seconds(30));
    CHECK(!hb);
}

TEST_CASE("heartbeat extends the TTL for the current lease") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-lease-heartbeat-extend";
    seedIdentity(db->getClient(), token);

    assembled_server::SessionLeaseRepo repo(db->getClient());
    const auto result = repo.acquire(token, std::chrono::seconds(30));

    // Heartbeat with the same lease_id must succeed.
    const bool hb = repo.heartbeat(token, result.lease_id, std::chrono::seconds(30));
    CHECK(hb);

    // And the lease remains alive.
    CHECK(repo.isAlive(token, result.lease_id));
}

TEST_CASE("isAlive returns false after TTL expires") {
    // Acceptance: "Test: lease expiry makes the session reclaimable"
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-lease-expiry-alive";
    seedIdentity(db->getClient(), token);

    assembled_server::SessionLeaseRepo repo(db->getClient());
    const auto result = repo.acquire(token, kShortTtl);

    // Wait for the lease to expire.
    std::this_thread::sleep_for(kShortTtl + kExpiryMargin);

    CHECK(!repo.isAlive(token, result.lease_id));
}

TEST_CASE("heartbeat fails after TTL expires") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-lease-heartbeat-after-expiry";
    seedIdentity(db->getClient(), token);

    assembled_server::SessionLeaseRepo repo(db->getClient());
    const auto result = repo.acquire(token, kShortTtl);

    std::this_thread::sleep_for(kShortTtl + kExpiryMargin);

    const bool hb = repo.heartbeat(token, result.lease_id, std::chrono::seconds(30));
    CHECK(!hb);
}

TEST_CASE("crash recovery: expired lease is reclaimable") {
    // Acceptance: "Test: crash recovery — a client that stops heartbeating is
    // not permanently locked out once the TTL elapses."
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token = "test-lease-crash-recovery";
    seedIdentity(db->getClient(), token);

    assembled_server::SessionLeaseRepo repo(db->getClient());

    // First session: client crashes without heartbeating.
    const auto crashed = repo.acquire(token, kShortTtl);
    (void)crashed; // no heartbeats sent

    // Wait for the TTL to elapse.
    std::this_thread::sleep_for(kShortTtl + kExpiryMargin);

    // The same identity can now acquire a new session without being locked out.
    const auto recovered = repo.acquire(token, std::chrono::seconds(30));
    CHECK(!recovered.lease_id.empty());
    CHECK(repo.isAlive(token, recovered.lease_id));
}

TEST_CASE("session_lease table has no free-text player column") {
    // UGC invariant: no column a player controls must accept arbitrary text.
    // lease_id is server-generated (UUID v4); token is derived from a phrase
    // the server discards.  Verify the table structure via information_schema.
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // The only TEXT columns are token and lease_id -- both server-minted.
    // There must be no column named anything like "phrase", "text", "content",
    // or "message" -- those would indicate a UGC surface.
    auto result = db->getClient()->execSqlSync(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'session_lease' "
        "AND column_name IN ('phrase','text','content','message','body','note')");
    CHECK(result.size() == 0);
}
