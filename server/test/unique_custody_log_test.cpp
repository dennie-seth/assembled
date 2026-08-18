/// T-0118: unique_custody_log — append-only custody history for unique items.
///
/// TDD: committed BEFORE the implementation exists.
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and integration job run
/// the live DB assertions.
///
/// Acceptance criteria (T-0118):
///   - [x] Table schema matches 15-server-ops.md §9.2
///   - [x] Every custody operation appends a row; no UPDATE ever touches existing rows
///   - [x] Current custody = latest row by seq
///   - [x] custody_depth = count(*) over the log for that unique_id, not a separate counter
///   - [x] Two take events with no intervening release/bleed = detectable (INV-2 violation)
///   - [x] Custody at any past instant reconstructible from the log alone

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/UniqueCustodyLog.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Test fixtures ─────────────────────────────────────────────────────────────

namespace {

// Fixed UUIDs for unique items under test — stable across runs.
const std::string U1 = "10000000-0000-0000-0000-000000000001";
const std::string U2 = "10000000-0000-0000-0000-000000000002";

// Identity tokens (TEXT, not UUID — matches identity.token type).
const std::string ID_A = "ucl_test_holder_a";
const std::string ID_B = "ucl_test_holder_b";
const std::string ID_C = "ucl_test_holder_c";

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
                    token);
}

/// Delete all custody log rows for a unique_id so each test starts clean.
void clearLog(const drogon::orm::DbClientPtr &db, const std::string &unique_id) {
    db->execSqlSync("DELETE FROM unique_custody_log WHERE unique_id = $1", unique_id);
}

/// Returns how many rows the DB sees for unique_id — bypasses the repo so
/// any UPDATE-based mutation would be visible as a miscount.
int64_t rawRowCount(const drogon::orm::DbClientPtr &db, const std::string &unique_id) {
    auto r = db->execSqlSync("SELECT COUNT(*) AS c FROM unique_custody_log WHERE unique_id = $1",
                             unique_id);
    return r[0]["c"].as<int64_t>();
}

} // namespace

// ── Schema ────────────────────────────────────────────────────────────────────

TEST_CASE("unique_custody_log: table exists with correct column set") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);

    auto r =
        client->execSqlSync("SELECT column_name "
                            "FROM information_schema.columns "
                            "WHERE table_schema = 'public' AND table_name = 'unique_custody_log' "
                            "ORDER BY ordinal_position");

    std::vector<std::string> cols;
    for (const auto &row : r) {
        cols.push_back(row["column_name"].as<std::string>());
    }

    // Every column from 15-server-ops.md §9.2 must be present.
    for (const char *required :
         {"unique_id", "seq", "holder", "hosted_by", "shard_id", "lease_expires", "event", "at"}) {
        CHECK_MESSAGE(std::find(cols.begin(), cols.end(), std::string(required)) != cols.end(),
                      "missing column: " << required);
    }

    // Table must be non-empty after having migrated at least this migration.
    REQUIRE_FALSE(cols.empty());
}

// ── Append-only: seq monotonically increases, no UPDATE ───────────────────────

TEST_CASE("unique_custody_log: append writes rows with strictly increasing seq") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);
    seedIdentity(client, ID_A);
    clearLog(client, U1);

    assembled_server::PgUniqueCustodyLog log(client);

    assembled_server::AppendParams p;
    p.unique_id = U1;
    p.holder = ID_A;
    p.event = assembled_server::CustodyEvent::Seed;

    const int64_t seq1 = log.append(p);
    CHECK(seq1 >= 1);

    p.event = assembled_server::CustodyEvent::Take;
    const int64_t seq2 = log.append(p);
    CHECK(seq2 == seq1 + 1);

    p.event = assembled_server::CustodyEvent::Bleed;
    const int64_t seq3 = log.append(p);
    CHECK(seq3 == seq2 + 1);

    // Raw DB count must equal the number of appends — an UPDATE-based
    // implementation would not produce new rows and this check would fail.
    CHECK(rawRowCount(client, U1) == 3);
}

// ── currentCustody: latest row by seq ─────────────────────────────────────────

TEST_CASE("unique_custody_log: currentCustody returns the row with the highest seq") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);
    seedIdentity(client, ID_A);
    seedIdentity(client, ID_B);
    clearLog(client, U2);

    assembled_server::PgUniqueCustodyLog log(client);

    // Seed -> holder A
    assembled_server::AppendParams p;
    p.unique_id = U2;
    p.holder = ID_A;
    p.event = assembled_server::CustodyEvent::Seed;
    log.append(p);

    // Take -> holder B
    p.event = assembled_server::CustodyEvent::Take;
    p.holder = ID_B;
    log.append(p);

    auto cur = log.currentCustody(U2);
    REQUIRE(cur.has_value());
    CHECK(cur->event == assembled_server::CustodyEvent::Take);
    REQUIRE(cur->holder.has_value());
    CHECK(*cur->holder == ID_B);

    // Non-existent unique_id returns nullopt.
    CHECK_FALSE(log.currentCustody("99999999-0000-0000-0000-000000000099").has_value());
}

// ── custodyDepth = COUNT(*), not a separate counter ────────────────────────────

TEST_CASE("unique_custody_log: custodyDepth is COUNT(*) over the log") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);
    clearLog(client, U1);

    assembled_server::PgUniqueCustodyLog log(client);

    // Depth before any rows.
    CHECK(log.custodyDepth(U1) == 0);

    assembled_server::AppendParams p;
    p.unique_id = U1;
    p.event = assembled_server::CustodyEvent::Seed;
    log.append(p);
    CHECK(log.custodyDepth(U1) == 1);

    p.event = assembled_server::CustodyEvent::Take;
    log.append(p);
    CHECK(log.custodyDepth(U1) == 2);

    p.event = assembled_server::CustodyEvent::Bleed;
    log.append(p);
    CHECK(log.custodyDepth(U1) == 3);

    // Verify against the raw count — the two must always agree.
    CHECK(log.custodyDepth(U1) == rawRowCount(client, U1));
}

// ── Duplicate-take detection (INV-2) ─────────────────────────────────────────

TEST_CASE("unique_custody_log: two take events with no intervening release/bleed is detectable") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);
    seedIdentity(client, ID_A);
    seedIdentity(client, ID_B);
    clearLog(client, U1);

    assembled_server::PgUniqueCustodyLog log(client);

    // Seed -> Take (A) -> Take (B) — no release/bleed between the two takes.
    assembled_server::AppendParams p;
    p.unique_id = U1;
    p.event = assembled_server::CustodyEvent::Seed;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Take;
    p.holder = ID_A;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Take; // second take — INV-2 violation
    p.holder = ID_B;
    log.append(p);

    CHECK(log.duplicateTakeCount(U1) == 1);

    // With an intervening release the chain is clean.
    clearLog(client, U2);
    p.unique_id = U2;
    p.holder = std::nullopt;
    p.event = assembled_server::CustodyEvent::Seed;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Take;
    p.holder = ID_A;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Release; // hands it back
    p.holder = std::nullopt;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Take;
    p.holder = ID_B;
    log.append(p);

    CHECK(log.duplicateTakeCount(U2) == 0);

    // Bleed also breaks the take chain.
    clearLog(client, U1);
    p.unique_id = U1;
    p.holder = std::nullopt;
    p.event = assembled_server::CustodyEvent::Seed;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Take;
    p.holder = ID_A;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Bleed; // world sweep moves it
    p.holder = std::nullopt;
    log.append(p);

    p.event = assembled_server::CustodyEvent::Take;
    p.holder = ID_B;
    log.append(p);

    CHECK(log.duplicateTakeCount(U1) == 0);
}

// ── custodyAt: reconstruct holder at a past instant ───────────────────────────

TEST_CASE("unique_custody_log: custodyAt reconstructs holder at an arbitrary past instant") {
    if (!std::getenv("DATABASE_URL")) {
        MESSAGE("DATABASE_URL not set — skipping DB assertions (build-only run)");
        return;
    }

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);
    seedIdentity(client, ID_A);
    seedIdentity(client, ID_B);
    seedIdentity(client, ID_C);
    clearLog(client, U1);

    assembled_server::PgUniqueCustodyLog log(client);

    // Epoch 1: Seed with holder = A.
    assembled_server::AppendParams p;
    p.unique_id = U1;
    p.holder = ID_A;
    p.event = assembled_server::CustodyEvent::Seed;
    log.append(p);

    // Capture a point-in-time after the seed row was written.
    auto r1 = client->execSqlSync("SELECT now()::TEXT AS t");
    const std::string after_seed = r1[0]["t"].as<std::string>();

    // Force a distinct timestamp for the next row.
    client->execSqlSync("SELECT pg_sleep(0.05)");

    // Epoch 2: Take -> holder = B.
    p.event = assembled_server::CustodyEvent::Take;
    p.holder = ID_B;
    log.append(p);

    auto r2 = client->execSqlSync("SELECT now()::TEXT AS t");
    const std::string after_take = r2[0]["t"].as<std::string>();

    client->execSqlSync("SELECT pg_sleep(0.05)");

    // Epoch 3: Bleed -> holder = C.
    p.event = assembled_server::CustodyEvent::Bleed;
    p.holder = ID_C;
    log.append(p);

    // Reconstruct at after_seed: should see the Seed row (holder = A).
    auto at_seed = log.custodyAt(U1, after_seed);
    REQUIRE(at_seed.has_value());
    CHECK(at_seed->event == assembled_server::CustodyEvent::Seed);
    REQUIRE(at_seed->holder.has_value());
    CHECK(*at_seed->holder == ID_A);

    // Reconstruct at after_take: should see the Take row (holder = B).
    auto at_take = log.custodyAt(U1, after_take);
    REQUIRE(at_take.has_value());
    CHECK(at_take->event == assembled_server::CustodyEvent::Take);
    REQUIRE(at_take->holder.has_value());
    CHECK(*at_take->holder == ID_B);

    // Reconstruct before any events: should return nullopt.
    auto before_all = log.custodyAt(U1, "1970-01-01 00:00:00+00");
    CHECK_FALSE(before_all.has_value());
}
