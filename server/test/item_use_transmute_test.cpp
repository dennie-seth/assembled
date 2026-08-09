/// T-0095: use() and transmute() integration tests.
///
/// TDD: committed BEFORE the use/transmute implementation exists.
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and ci-server integration
/// job run the live DB assertions.
///
/// use() semantics (07-items-economy.md §3):
///   held → world anchor, plus an optional atomic unlock row write
///   (10-time-and-progression.md §3).  The unlock write is conditional on the
///   caller providing UseUnlockData; when omitted, use() is identical to leave()
///   in its item-movement effect.
///
/// transmute() semantics (07-items-economy.md §6):
///   input:  A (pattern) + B (fuel), both held by the same identity
///   output: one new instance of type_id(A), holder = same identity
///   effect: A and B are destroyed; net count −1
///   all three operations (delete A, delete B, insert new) are one transaction.
///
/// Acceptance criteria from T-0095:
///   - [ ] use() moves item held→anchor AND writes unlock row atomically
///   - [ ] transmute() consumes both input instances, mints exactly one new
///         instance of the pattern's type_id, atomically (INV-3 net −1)
///   - [ ] transmute() CAS miss on A → neither A nor B deleted, no mint
///   - [ ] transmute() CAS miss on B → A not deleted, B not deleted, no mint

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
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT DO NOTHING", token);
}

void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id, int16_t rarity = 0) {
    db->execSqlSync(
        "INSERT INTO item_type (id, rarity) VALUES ($1, $2) ON CONFLICT DO NOTHING", id, rarity);
}

/// Seed a variant row (archetype 1 = HOSPITAL, seeded in 003).
void seedVariant(const drogon::orm::DbClientPtr &db, int16_t id) {
    db->execSqlSync("INSERT INTO variant (id, archetype_id) VALUES ($1, 1) ON CONFLICT DO NOTHING",
                    id);
}

std::string seedHeldItem(const drogon::orm::DbClientPtr &db, int16_t type_id,
                         const std::string &holder_token) {
    auto result = db->execSqlSync("INSERT INTO item_instance (type_id, holder, bleed_at) "
                                  "VALUES ($1, $2, now() + INTERVAL '1 hour') "
                                  "RETURNING id",
                                  type_id, holder_token);
    return result[0][0].as<std::string>();
}

int32_t countByType(const drogon::orm::DbClientPtr &db, int16_t type_id) {
    auto r = db->execSqlSync("SELECT COUNT(*)::int AS c FROM item_instance WHERE type_id = $1",
                             type_id);
    return r[0]["c"].as<int32_t>();
}

bool unlockExists(const drogon::orm::DbClientPtr &db, const std::string &token,
                  int16_t variant_id, int16_t tag) {
    auto r = db->execSqlSync(
        "SELECT 1 FROM unlock WHERE token=$1 AND variant_id=$2 AND tag=$3 LIMIT 1", token,
        variant_id, tag);
    return !r.empty();
}

bool itemExists(const drogon::orm::DbClientPtr &db, const std::string &item_id) {
    auto r =
        db->execSqlSync("SELECT 1 FROM item_instance WHERE id=$1 LIMIT 1", item_id);
    return !r.empty();
}

} // namespace

// ── use() with unlock side-effect ────────────────────────────────────────────

TEST_CASE("use: item moves held→anchor and unlock row is written atomically") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_holder = "test-use-holder-a";
    const std::string token_universe = "test-use-universe-a";
    seedIdentity(db->getClient(), token_holder);
    seedIdentity(db->getClient(), token_universe);

    constexpr int16_t kTypeId = 81;
    constexpr int16_t kVariantId = 801;
    constexpr int16_t kTag = 3;
    seedItemType(db->getClient(), kTypeId);
    seedVariant(db->getClient(), kVariantId);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);
    db->getClient()->execSqlSync(
        "DELETE FROM unlock WHERE token = $1 AND variant_id = $2 AND tag = $3", token_holder,
        kVariantId, kTag);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_holder);

    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::UseParams params;
    params.item_id = item_id;
    params.holder_token = token_holder;
    params.expected_version = 0;
    params.hosted_by_token = token_universe;
    params.anchor_arch = 1; // HOSPITAL
    params.anchor_tag = 1;  // entrance
    params.unlock = assembled_server::UseUnlockData{kVariantId, kTag, 3600};

    const auto result = repo.use(params);

    CHECK(result.status == assembled_server::TransferStatus::Won);
    CHECK(result.new_version == 1);
    CHECK(result.new_custody_depth == 1); // INV-5
    CHECK(result.unlock_written == true);

    // Item is now at the anchor, not held.
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder, hosted_by FROM item_instance WHERE id=$1", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull());
        CHECK(r[0]["hosted_by"].as<std::string>() == token_universe);
    }

    // Unlock row must exist.
    CHECK(unlockExists(db->getClient(), token_holder, kVariantId, kTag));
}

// ── use() without unlock (no rule matches) ────────────────────────────────────

TEST_CASE("use: item moves held→anchor without writing an unlock row when no rule") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_holder = "test-use-holder-b";
    const std::string token_universe = "test-use-universe-b";
    seedIdentity(db->getClient(), token_holder);
    seedIdentity(db->getClient(), token_universe);

    constexpr int16_t kTypeId = 82;
    seedItemType(db->getClient(), kTypeId);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_holder);

    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::UseParams params;
    params.item_id = item_id;
    params.holder_token = token_holder;
    params.expected_version = 0;
    params.hosted_by_token = token_universe;
    params.anchor_arch = 1;
    params.anchor_tag = 2; // ward_north
    // params.unlock is std::nullopt — no unlock side-effect

    const auto result = repo.use(params);

    CHECK(result.status == assembled_server::TransferStatus::Won);
    CHECK(result.new_version == 1);
    CHECK(result.new_custody_depth == 1);
    CHECK(result.unlock_written == false);

    // Item moved to anchor.
    {
        auto r = db->getClient()->execSqlSync("SELECT holder FROM item_instance WHERE id=$1",
                                              item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull());
    }
}

// ── use() CAS miss ─────────────────────────────────────────────────────────────

TEST_CASE("use: stale expected_version returns Lost and does not move item") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_holder = "test-use-holder-c";
    const std::string token_universe = "test-use-universe-c";
    seedIdentity(db->getClient(), token_holder);
    seedIdentity(db->getClient(), token_universe);

    constexpr int16_t kTypeId = 83;
    seedItemType(db->getClient(), kTypeId);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_holder);

    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::UseParams params;
    params.item_id = item_id;
    params.holder_token = token_holder;
    params.expected_version = 99; // stale
    params.hosted_by_token = token_universe;
    params.anchor_arch = 1;
    params.anchor_tag = 1;

    const auto result = repo.use(params);

    CHECK(result.status == assembled_server::TransferStatus::Lost);

    // Item still held by holder.
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder FROM item_instance WHERE id=$1", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].as<std::string>() == token_holder);
    }
}

// ── transmute(): atomically consumes A and B, mints new item ─────────────────

TEST_CASE("transmute: A and B consumed, one new item of type_id(A) minted, net -1 (INV-3)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_holder = "test-xmute-holder-a";
    seedIdentity(db->getClient(), token_holder);

    constexpr int16_t kTypeA = 71;
    constexpr int16_t kTypeB = 72;
    seedItemType(db->getClient(), kTypeA);
    seedItemType(db->getClient(), kTypeB);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id IN ($1, $2)", kTypeA,
                                 kTypeB);

    const std::string item_a = seedHeldItem(db->getClient(), kTypeA, token_holder);
    const std::string item_b = seedHeldItem(db->getClient(), kTypeB, token_holder);

    // INV-3 baseline: 1 of kTypeA, 1 of kTypeB.
    CHECK(countByType(db->getClient(), kTypeA) == 1);
    CHECK(countByType(db->getClient(), kTypeB) == 1);

    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::TransmuteParams params;
    params.item_id_a = item_a;
    params.expected_version_a = 0;
    params.item_id_b = item_b;
    params.expected_version_b = 0;
    params.holder_token = token_holder;

    const auto result = repo.transmute(params);

    CHECK(result.status == assembled_server::TransferStatus::Won);
    REQUIRE(!result.new_item_id.empty());

    // A and B are destroyed.
    CHECK(!itemExists(db->getClient(), item_a));
    CHECK(!itemExists(db->getClient(), item_b));

    // New item exists with type_id == kTypeA (the pattern).
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT type_id, holder FROM item_instance WHERE id=$1", result.new_item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["type_id"].as<int16_t>() == kTypeA);
        CHECK(r[0]["holder"].as<std::string>() == token_holder);
    }

    // INV-3 net -1: kTypeA count 1→1 (consumed one, minted one), kTypeB count 1→0.
    CHECK(countByType(db->getClient(), kTypeA) == 1);
    CHECK(countByType(db->getClient(), kTypeB) == 0);
}

// ── transmute(): CAS miss on A ────────────────────────────────────────────────

TEST_CASE("transmute: stale version_a → Lost, A and B untouched, no new item") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_holder = "test-xmute-holder-b";
    seedIdentity(db->getClient(), token_holder);

    constexpr int16_t kTypeA = 73;
    constexpr int16_t kTypeB = 74;
    seedItemType(db->getClient(), kTypeA);
    seedItemType(db->getClient(), kTypeB);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id IN ($1, $2)", kTypeA,
                                 kTypeB);

    const std::string item_a = seedHeldItem(db->getClient(), kTypeA, token_holder);
    const std::string item_b = seedHeldItem(db->getClient(), kTypeB, token_holder);

    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::TransmuteParams params;
    params.item_id_a = item_a;
    params.expected_version_a = 99; // stale
    params.item_id_b = item_b;
    params.expected_version_b = 0;
    params.holder_token = token_holder;

    const auto result = repo.transmute(params);

    CHECK(result.status == assembled_server::TransferStatus::Lost);
    CHECK(result.new_item_id.empty());

    // Both items still exist and are untouched.
    CHECK(itemExists(db->getClient(), item_a));
    CHECK(itemExists(db->getClient(), item_b));
    CHECK(countByType(db->getClient(), kTypeA) == 1);
    CHECK(countByType(db->getClient(), kTypeB) == 1);
}

// ── transmute(): CAS miss on B ────────────────────────────────────────────────

TEST_CASE("transmute: stale version_b → Lost, A and B untouched, no new item") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string token_holder = "test-xmute-holder-c";
    seedIdentity(db->getClient(), token_holder);

    constexpr int16_t kTypeA = 75;
    constexpr int16_t kTypeB = 76;
    seedItemType(db->getClient(), kTypeA);
    seedItemType(db->getClient(), kTypeB);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id IN ($1, $2)", kTypeA,
                                 kTypeB);

    const std::string item_a = seedHeldItem(db->getClient(), kTypeA, token_holder);
    const std::string item_b = seedHeldItem(db->getClient(), kTypeB, token_holder);

    assembled_server::PgItemRepo repo(db->getClient());

    assembled_server::TransmuteParams params;
    params.item_id_a = item_a;
    params.expected_version_a = 0; // correct
    params.item_id_b = item_b;
    params.expected_version_b = 99; // stale
    params.holder_token = token_holder;

    const auto result = repo.transmute(params);

    CHECK(result.status == assembled_server::TransferStatus::Lost);
    CHECK(result.new_item_id.empty());

    // Both items still exist — the transaction was rolled back.
    CHECK(itemExists(db->getClient(), item_a));
    CHECK(itemExists(db->getClient(), item_b));
    CHECK(countByType(db->getClient(), kTypeA) == 1);
    CHECK(countByType(db->getClient(), kTypeB) == 1);
}
