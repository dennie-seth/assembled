/// T-0128: Spontaneous item spawner tests — rarity-cap enforcement (INV-6, INV-7).
///
/// TDD: This file is committed BEFORE the real ItemSpawner implementation.
/// DB-dependent TEST_CASEs gate on DATABASE_URL so CI without a Postgres
/// container stays green (build-only) while dev-machine and ci-server integration
/// jobs run the live assertions.
///
/// Coverage:
///   INV-6: spawner never creates instances beyond cap(type, P) for any tier.
///   INV-6 (rapid growth): cap is respected even when P grows across ticks.
///   INV-7: gating-set types are topped up to at least floor after each tick.
///   Unique independence: unique cap is population-independent (never k_c/k_r scaled).
///   Pluggable rate model: ISpawnRateModel is the E-7 hook; spawner delegates to it.
///   FloorTopUpModel unit: pure-function tests, no DB required.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <cstdlib>
#include <memory>
#include <set>
#include <string>
#include <unistd.h> // ::getpid()
#include <vector>

#include "assembled_server/Database.h"
#include "assembled_server/ItemSpawner.h"
#include "assembled_server/MigrationRunner.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Test rate models ──────────────────────────────────────────────────────────

namespace {

/// Stress-tests the spawner's cap clamp: always asks for as many as possible.
class MaxSpawnModel : public assembled_server::ISpawnRateModel {
  public:
    int32_t spawnsNeeded(int16_t /*rarity*/, int32_t current_count, int32_t cap, int32_t /*floor*/,
                         bool /*is_gating*/) const override {
        return cap - current_count;
    }
};

/// Returns a fixed count regardless of state — verifies the spawner delegates
/// to the rate model rather than using its own arbitrary count.
class FixedSpawnModel : public assembled_server::ISpawnRateModel {
    int32_t n_;

  public:
    explicit FixedSpawnModel(int32_t n) : n_(n) {}
    int32_t spawnsNeeded(int16_t, int32_t, int32_t, int32_t, bool) const override { return n_; }
};

// ── DB helpers ────────────────────────────────────────────────────────────────

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
                    token);
}

void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id, int16_t rarity) {
    db->execSqlSync(
        "INSERT INTO item_type (id, rarity) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", id,
        rarity);
}

/// Like countInstances but scoped to a specific universe (hosted_by). Use this in integration
/// tests to avoid counting instances belonging to concurrent ctest processes that share the DB.
int32_t countInstancesAt(const drogon::orm::DbClientPtr &db, int16_t type_id,
                         const std::string &hosted_by) {
    auto r = db->execSqlSync(
        "SELECT COUNT(*)::int AS c FROM item_instance WHERE type_id = $1 AND hosted_by = $2",
        type_id, hosted_by);
    return r[0]["c"].as<int32_t>();
}

/// Delete item_types (and their instances) that belong to OTHER test files — i.e. any type_id
/// outside the 201–206 range reserved for this file.  Limiting the spawner to only 201–206
/// prevents it from processing leftover types from item_economy_test (97–99),
/// item_use_transmute_test (71–83), anchor_snapshot_test (91–96), etc., which would otherwise
/// make aggregate spawned_count unpredictable and inflate per-tick insert counts dramatically
/// (the root cause of test #84 running for 282 s in the first review pass).
///
/// FK order: offering → item_instance → item_type.
void deleteNonTestItemTypes(const drogon::orm::DbClientPtr &db) {
    db->execSqlSync("DELETE FROM offering WHERE item_instance IN "
                    "(SELECT id FROM item_instance WHERE type_id < 201 OR type_id > 206)");
    db->execSqlSync("DELETE FROM item_instance WHERE type_id < 201 OR type_id > 206");
    db->execSqlSync("DELETE FROM item_type WHERE id < 201 OR id > 206");
}

/// Shared test anchor — seeded by migration 003: archetype=HOSPITAL(1), tag=entrance(1).
assembled_server::SpawnLocation testLocation(const std::string &hosted_by) {
    return assembled_server::SpawnLocation{hosted_by, 1, 1};
}

} // namespace

// ── Unit tests: FloorTopUpModel (no DB, purely functional) ───────────────────

TEST_CASE("FloorTopUpModel: returns 0 when at or above cap") {
    assembled_server::FloorTopUpModel model;

    // At cap — non-gating type.
    CHECK(model.spawnsNeeded(0, 10, 10, 0, false) == 0);
    // Above cap (defensive: spawner should never call with current > cap, but model handles it).
    CHECK(model.spawnsNeeded(0, 12, 10, 0, false) == 0);
    // At cap — gating type, even with a floor.
    CHECK(model.spawnsNeeded(0, 10, 10, 5, true) == 0);
}

TEST_CASE("FloorTopUpModel: spawns to floor for gating type below floor") {
    assembled_server::FloorTopUpModel model;

    // floor=5, current=1 → top up by 4.
    CHECK(model.spawnsNeeded(0, 1, 20, 5, true) == 4);
    // Exactly at floor — no spawn needed.
    CHECK(model.spawnsNeeded(0, 5, 20, 5, true) == 0);
    // Above floor, below cap — no spawn (floor already satisfied).
    CHECK(model.spawnsNeeded(0, 8, 20, 5, true) == 0);
}

TEST_CASE("FloorTopUpModel: spawns 0 for non-gating type below floor") {
    assembled_server::FloorTopUpModel model;

    // Non-gating: floor is irrelevant, no spontaneous spawn from floor logic.
    CHECK(model.spawnsNeeded(0, 0, 20, 0, false) == 0);
    CHECK(model.spawnsNeeded(0, 3, 20, 10, false) == 0); // floor ignored for non-gating
}

// ── Integration tests: ItemSpawner against real Postgres ─────────────────────
//
// Type IDs 201-206 are reserved for this test file to avoid conflicts with
// item_economy_test.cpp (97-99) and item_use_transmute_test.cpp.

TEST_CASE("spawner respects hard cap for common tier — INV-6") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Unique universe per process: prevents parallel ctest invocations sharing the same
    // hosted_by value and contaminating each other's item_instance counts.
    const std::string universe = "test-spawner-cap-common-" + std::to_string(::getpid());
    seedIdentity(db->getClient(), universe);

    // Restrict spawner to this test file's reserved type IDs (201–206) so it doesn't process
    // leftover types from other test binaries and inflate spawned_count unpredictably.
    deleteNonTestItemTypes(db->getClient());

    constexpr int16_t kTypeId = 201; // common
    seedItemType(db->getClient(), kTypeId, 0);
    // Scope DELETE to this process's universe so parallel runs don't stomp each other.
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1 AND hosted_by = $2",
                                 kTypeId, universe);

    assembled_server::SpawnerConfig cfg;
    cfg.k_c = 5.0f;

    // MaxSpawnModel fills to cap every tick; spawner must clamp.
    assembled_server::ItemSpawner spawner(db->getClient(), cfg, std::make_shared<MaxSpawnModel>());

    assembled_server::SpawnTickParams params;
    params.population = 2; // cap = k_c * P = 10
    params.locations = {testLocation(universe)};

    spawner.runTick(params);
    const int32_t cap = static_cast<int32_t>(cfg.k_c * static_cast<float>(params.population));

    // INV-6: per-type count at this universe must equal cap (MaxSpawnModel filled to cap).
    // Use countInstancesAt to scope to this process's universe — avoids double-counting
    // instances inserted by a concurrent ctest invocation of the same test case.
    CHECK(countInstancesAt(db->getClient(), kTypeId, universe) == cap);

    // Second tick: already at cap for this type — no new instances added.
    spawner.runTick(params);
    CHECK(countInstancesAt(db->getClient(), kTypeId, universe) == cap); // unchanged
}

TEST_CASE("spawner cap is respected under rapid population growth — INV-6") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string universe = "test-spawner-growth-" + std::to_string(::getpid());
    seedIdentity(db->getClient(), universe);

    deleteNonTestItemTypes(db->getClient());

    constexpr int16_t kTypeId = 202; // common
    seedItemType(db->getClient(), kTypeId, 0);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1 AND hosted_by = $2",
                                 kTypeId, universe);

    assembled_server::SpawnerConfig cfg;
    cfg.k_c = 5.0f;

    assembled_server::ItemSpawner spawner(db->getClient(), cfg, std::make_shared<MaxSpawnModel>());

    // Simulate population doubling across three ticks.
    for (int32_t pop : {1, 2, 3}) {
        assembled_server::SpawnTickParams p;
        p.population = pop;
        p.locations = {testLocation(universe)};
        spawner.runTick(p);

        const int32_t count = countInstancesAt(db->getClient(), kTypeId, universe);
        const int32_t expected_cap = static_cast<int32_t>(cfg.k_c * static_cast<float>(pop));

        // INV-6: never exceeds the cap for the current population.
        CHECK_MESSAGE(count <= expected_cap, "cap violated at P=" << pop << ": count=" << count
                                                                  << " cap=" << expected_cap);
    }
}

TEST_CASE("spawner tops up floor for gating-set types — INV-7") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string universe = "test-spawner-floor-" + std::to_string(::getpid());
    seedIdentity(db->getClient(), universe);

    deleteNonTestItemTypes(db->getClient());

    constexpr int16_t kTypeId = 203; // common, gating
    seedItemType(db->getClient(), kTypeId, 0);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1 AND hosted_by = $2",
                                 kTypeId, universe);

    assembled_server::SpawnerConfig cfg;
    cfg.k_c = 10.0f;
    cfg.floor_fraction = 0.5f; // floor = 0.5 * cap

    // FloorTopUpModel: tops up gating types to floor.
    assembled_server::ItemSpawner spawner(db->getClient(), cfg,
                                          std::make_shared<assembled_server::FloorTopUpModel>());

    assembled_server::SpawnTickParams params;
    params.population = 2; // cap = 20, floor = 10
    params.locations = {testLocation(universe)};
    params.gating_types = {kTypeId}; // mark as progression-critical

    spawner.runTick(params);

    const int32_t count = countInstancesAt(db->getClient(), kTypeId, universe);
    const float cap_f = cfg.k_c * static_cast<float>(params.population);
    const int32_t expected_floor = static_cast<int32_t>(cfg.floor_fraction * cap_f);
    const int32_t expected_cap = static_cast<int32_t>(cap_f);

    // INV-7: gating type must be at or above floor after the tick.
    CHECK(count >= expected_floor);
    // INV-6: must not exceed cap.
    CHECK(count <= expected_cap);
}

TEST_CASE("unique tier cap is population-independent — INV-6") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string universe = "test-spawner-unique-" + std::to_string(::getpid());
    seedIdentity(db->getClient(), universe);

    deleteNonTestItemTypes(db->getClient());

    constexpr int16_t kTypeId = 204; // unique
    seedItemType(db->getClient(), kTypeId, 2);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1 AND hosted_by = $2",
                                 kTypeId, universe);

    assembled_server::SpawnerConfig cfg;
    cfg.k_c = 10.0f;
    cfg.k_r = 1.0f;
    cfg.unique_cap = 2; // fixed count regardless of population

    assembled_server::ItemSpawner spawner(db->getClient(), cfg, std::make_shared<MaxSpawnModel>());

    // Tick 1: small population. Unique cap fills to 2.
    {
        assembled_server::SpawnTickParams p;
        p.population = 1;
        p.locations = {testLocation(universe)};
        spawner.runTick(p);
        CHECK(countInstancesAt(db->getClient(), kTypeId, universe) <= cfg.unique_cap);
    }

    // Tick 2: large population. Cap must remain unique_cap, never k_c * P.
    {
        assembled_server::SpawnTickParams p;
        p.population = 1000;
        p.locations = {testLocation(universe)};
        spawner.runTick(p);
        const int32_t count = countInstancesAt(db->getClient(), kTypeId, universe);
        CHECK(count <= cfg.unique_cap); // INV-6: fixed count, not k_c*1000
    }
}

TEST_CASE("spawner uses the pluggable rate model — not a hardcoded count") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Unique universe per process to isolate from parallel ctest invocations of this test case.
    const std::string universe = "test-spawner-ratemodel-" + std::to_string(::getpid());
    seedIdentity(db->getClient(), universe);

    // Remove types from other test files so the spawner only processes 201–206, keeping
    // spawned_count predictable and avoiding the 282-s overrun seen for other test cases.
    deleteNonTestItemTypes(db->getClient());

    constexpr int16_t kTypeId = 205; // common
    seedItemType(db->getClient(), kTypeId, 0);
    // Scope to this universe so a concurrent ctest process doesn't delete our rows.
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1 AND hosted_by = $2",
                                 kTypeId, universe);

    assembled_server::SpawnerConfig cfg;
    cfg.k_c = 20.0f; // cap = 40 at P=2 — well above the fixed 3

    constexpr int32_t kFixed = 3;
    assembled_server::ItemSpawner spawner(db->getClient(), cfg,
                                          std::make_shared<FixedSpawnModel>(kFixed));

    assembled_server::SpawnTickParams params;
    params.population = 2;
    params.locations = {testLocation(universe)};

    spawner.runTick(params);

    // The spawner must use the rate model's answer — exactly kFixed instances at this universe.
    // countInstancesAt scopes to this process's universe, preventing the 9-vs-3 failure
    // caused by three parallel ctest processes each inserting 3 type-205 rows.
    CHECK(countInstancesAt(db->getClient(), kTypeId, universe) == kFixed);
}
