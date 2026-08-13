/// T-0126: Transfer receipts — idempotent leave/use/take/transmute.
///
/// TDD: committed BEFORE the implementation exists.
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and CI integration job run
/// the live DB assertions.
///
/// Acceptance criteria (T-0126):
///   - A fresh transfer_id runs the CAS and records the outcome as a receipt.
///   - A repeated transfer_id (within 72 h) returns the stored receipt without
///     re-running the CAS — even if the underlying item's version has since moved.
///   - Concurrent callers with the same transfer_id: tryClaimSlot() lets exactly
///     one caller execute the CAS; the other finds the stored receipt.
///   - A receipt older than 72 h is treated as expired: find() returns nullopt and
///     tryClaimSlot() reclaims the slot, running a fresh CAS.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <cstdlib>
#include <string>

#include "assembled_server/Database.h"
#include "assembled_server/ItemRepo.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/TransferReceiptRepo.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Helpers ──────────────────────────────────────────────────────────────────

namespace {

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
                    token);
}

void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id) {
    db->execSqlSync("INSERT INTO item_type (id, rarity) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING",
                    id);
}

std::string seedHeldItem(const drogon::orm::DbClientPtr &db, int16_t type_id,
                         const std::string &holder_token) {
    auto r = db->execSqlSync("INSERT INTO item_instance (type_id, holder, bleed_at) "
                             "VALUES ($1, $2, now() + INTERVAL '1 hour') "
                             "RETURNING id",
                             type_id, holder_token);
    return r[0][0].as<std::string>();
}

/// Build a unique fixed-format UUID-like string for each test to avoid
/// cross-test interference without pulling in a UUID generator.
std::string testUuid(const char *suffix) {
    return std::string("00000000-0000-0000-0000-") + suffix;
}

} // namespace

// ── Unit: find(), tryClaimSlot(), recordWon(), recordLost() ──────────────────

TEST_CASE("receipt: find returns nullopt for unknown transfer_id") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    assembled_server::PgTransferReceiptRepo repo(db->getClient());

    auto result = repo.find("ffffffff-ffff-ffff-ffff-000000000001");
    CHECK(!result.has_value());
}

TEST_CASE("receipt: tryClaimSlot returns true for new transfer_id, false on repeat") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string tid = testUuid("000000000002");
    const std::string fake_item = "ffffffff-ffff-ffff-ffff-000000000002";

    // Cleanup any leftovers.
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgTransferReceiptRepo repo(db->getClient());

    // First call: slot is fresh → returns true.
    CHECK(repo.tryClaimSlot(tid, "leave", fake_item) == true);

    // Second call: live receipt exists → returns false.
    CHECK(repo.tryClaimSlot(tid, "leave", fake_item) == false);

    // Cleanup.
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);
}

TEST_CASE("receipt: recordWon is reflected in find with Won outcome") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string tid = testUuid("000000000003");
    const std::string fake_item = "ffffffff-ffff-ffff-ffff-000000000003";

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgTransferReceiptRepo repo(db->getClient());

    REQUIRE(repo.tryClaimSlot(tid, "take", fake_item));
    repo.recordWon(tid, std::optional<int32_t>{5}, std::optional<int32_t>{10});

    auto r = repo.find(tid);
    REQUIRE(r.has_value());
    CHECK(r->outcome == assembled_server::ReceiptOutcome::Won);
    CHECK(r->new_version.value_or(-1) == 5);
    CHECK(r->new_custody_depth.value_or(-1) == 10);

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);
}

TEST_CASE("receipt: recordLost is reflected in find with Lost outcome") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string tid = testUuid("000000000004");
    const std::string fake_item = "ffffffff-ffff-ffff-ffff-000000000004";

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgTransferReceiptRepo repo(db->getClient());

    REQUIRE(repo.tryClaimSlot(tid, "leave", fake_item));
    repo.recordLost(tid);

    auto r = repo.find(tid);
    REQUIRE(r.has_value());
    CHECK(r->outcome == assembled_server::ReceiptOutcome::Lost);
    CHECK(!r->new_version.has_value());
    CHECK(!r->new_custody_depth.has_value());

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);
}

TEST_CASE("receipt: find returns nullopt for expired receipt") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string tid = testUuid("000000000005");
    const std::string fake_item = "ffffffff-ffff-ffff-ffff-000000000005";

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    // Insert an already-expired receipt directly.
    db->getClient()->execSqlSync(
        "INSERT INTO transfer_receipt (transfer_id, kind, item_id, outcome, bleed_at) "
        "VALUES ($1, 'leave', $2, 'won', now() - INTERVAL '1 second')",
        tid, fake_item);

    assembled_server::PgTransferReceiptRepo repo(db->getClient());

    // Expired receipt must be invisible.
    CHECK(!repo.find(tid).has_value());

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);
}

TEST_CASE("receipt: tryClaimSlot reclaims after expired receipt") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string tid = testUuid("000000000006");
    const std::string fake_item = "ffffffff-ffff-ffff-ffff-000000000006";

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    // Insert an expired receipt.
    db->getClient()->execSqlSync(
        "INSERT INTO transfer_receipt (transfer_id, kind, item_id, outcome, bleed_at) "
        "VALUES ($1, 'leave', $2, 'won', now() - INTERVAL '1 second')",
        tid, fake_item);

    assembled_server::PgTransferReceiptRepo repo(db->getClient());

    // tryClaimSlot must treat the expired receipt as non-existent.
    CHECK(repo.tryClaimSlot(tid, "leave", fake_item) == true);

    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);
}

// ── Integration: idempotentLeave ─────────────────────────────────────────────

TEST_CASE("idempotent leave: Won path records receipt") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string token_a = "test-receipt-leave-a";
    const std::string token_b = "test-receipt-leave-b";
    seedIdentity(db->getClient(), token_a);
    seedIdentity(db->getClient(), token_b);

    constexpr int16_t kTypeId = 61;
    seedItemType(db->getClient(), kTypeId);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_a);
    const std::string tid = testUuid("000000000010");
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgItemRepo item_repo(db->getClient());
    assembled_server::PgTransferReceiptRepo receipt_repo(db->getClient());

    assembled_server::LeaveParams params;
    params.item_id = item_id;
    params.holder_token = token_a;
    params.expected_version = 0;
    params.hosted_by_token = token_b;
    params.anchor_arch = 1;
    params.anchor_tag = 1;

    const auto rec = receipt_repo.idempotentLeave(tid, item_repo, params);

    CHECK(rec.outcome == assembled_server::ReceiptOutcome::Won);
    REQUIRE(rec.new_version.has_value());
    CHECK(*rec.new_version == 1);
    REQUIRE(rec.new_custody_depth.has_value());
    CHECK(*rec.new_custody_depth == 1);

    // Receipt must be persisted.
    auto stored = receipt_repo.find(tid);
    REQUIRE(stored.has_value());
    CHECK(stored->outcome == assembled_server::ReceiptOutcome::Won);

    // Item version in DB must be 1.
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT version FROM item_instance WHERE id = $1", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["version"].as<int32_t>() == 1);
    }
}

TEST_CASE("idempotent leave: repeat transfer_id returns stored Won without re-running CAS") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string token_a = "test-receipt-idem-a";
    const std::string token_b = "test-receipt-idem-b";
    seedIdentity(db->getClient(), token_a);
    seedIdentity(db->getClient(), token_b);

    constexpr int16_t kTypeId = 62;
    seedItemType(db->getClient(), kTypeId);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_a);
    const std::string tid = testUuid("000000000011");
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgItemRepo item_repo(db->getClient());
    assembled_server::PgTransferReceiptRepo receipt_repo(db->getClient());

    assembled_server::LeaveParams params;
    params.item_id = item_id;
    params.holder_token = token_a;
    params.expected_version = 0;
    params.hosted_by_token = token_b;
    params.anchor_arch = 1;
    params.anchor_tag = 1;

    // First call — CAS executes, version advances to 1.
    const auto rec1 = receipt_repo.idempotentLeave(tid, item_repo, params);
    REQUIRE(rec1.outcome == assembled_server::ReceiptOutcome::Won);

    // Second call with the same transfer_id — must NOT re-run the CAS.
    const auto rec2 = receipt_repo.idempotentLeave(tid, item_repo, params);

    CHECK(rec2.outcome == assembled_server::ReceiptOutcome::Won);
    CHECK(rec2.new_version.value_or(-1) == rec1.new_version.value_or(-2));

    // Item version must still be 1, not 2 — CAS ran exactly once.
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT version FROM item_instance WHERE id = $1", item_id);
        REQUIRE(!r.empty());
        CHECK_MESSAGE(r[0]["version"].as<int32_t>() == 1,
                      "CAS ran more than once: version should be 1 but is "
                          << r[0]["version"].as<int32_t>());
    }
}

// ── Integration: concurrent simulation (sequential model) ────────────────────

TEST_CASE("concurrent simulation: exactly one tryClaimSlot wins; other gets stored receipt") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string token_a = "test-receipt-conc-a";
    const std::string token_b = "test-receipt-conc-b";
    seedIdentity(db->getClient(), token_a);
    seedIdentity(db->getClient(), token_b);

    constexpr int16_t kTypeId = 63;
    seedItemType(db->getClient(), kTypeId);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_a);
    const std::string tid = testUuid("000000000012");
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgItemRepo item_repo(db->getClient());
    assembled_server::PgTransferReceiptRepo receipt_repo(db->getClient());

    assembled_server::LeaveParams params;
    params.item_id = item_id;
    params.holder_token = token_a;
    params.expected_version = 0;
    params.hosted_by_token = token_b;
    params.anchor_arch = 1;
    params.anchor_tag = 1;

    // Simulate concurrent callers by issuing two idempotentLeave calls
    // sequentially with the same transfer_id.  The second must not re-run the CAS.
    const auto rec1 = receipt_repo.idempotentLeave(tid, item_repo, params);
    const auto rec2 = receipt_repo.idempotentLeave(tid, item_repo, params);

    // Both must see a Won receipt.
    CHECK(rec1.outcome == assembled_server::ReceiptOutcome::Won);
    CHECK(rec2.outcome == assembled_server::ReceiptOutcome::Won);

    // Exactly one CAS — item version must be 1, not 2.
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT version FROM item_instance WHERE id = $1", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["version"].as<int32_t>() == 1);
    }

    // Exactly one receipt row.
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT COUNT(*)::int AS c FROM transfer_receipt WHERE transfer_id = $1", tid);
        CHECK(r[0]["c"].as<int32_t>() == 1);
    }
}

// ── Integration: idempotentTake ──────────────────────────────────────────────

TEST_CASE("idempotent take: Won path records receipt") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string token_owner = "test-receipt-take-owner";
    const std::string token_taker = "test-receipt-take-taker";
    seedIdentity(db->getClient(), token_owner);
    seedIdentity(db->getClient(), token_taker);

    constexpr int16_t kTypeId = 64;
    seedItemType(db->getClient(), kTypeId);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_id = seedHeldItem(db->getClient(), kTypeId, token_owner);

    // Leave first so item is at anchor.
    assembled_server::PgItemRepo item_repo(db->getClient());

    assembled_server::LeaveParams lp;
    lp.item_id = item_id;
    lp.holder_token = token_owner;
    lp.expected_version = 0;
    lp.hosted_by_token = token_taker;
    lp.anchor_arch = 1;
    lp.anchor_tag = 1;
    const auto lr = item_repo.leave(lp);
    REQUIRE(lr.status == assembled_server::TransferStatus::Won);

    const std::string tid = testUuid("000000000013");
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgTransferReceiptRepo receipt_repo(db->getClient());

    assembled_server::TakeParams tp;
    tp.item_id = item_id;
    tp.taker_token = token_taker;
    tp.expected_version = lr.new_version;

    const auto rec = receipt_repo.idempotentTake(tid, item_repo, tp);

    CHECK(rec.outcome == assembled_server::ReceiptOutcome::Won);
    REQUIRE(rec.new_version.has_value());
    CHECK(*rec.new_version == 2);

    // Receipt persisted.
    auto stored = receipt_repo.find(tid);
    REQUIRE(stored.has_value());
    CHECK(stored->outcome == assembled_server::ReceiptOutcome::Won);
}

// ── Integration: idempotentTransmute ─────────────────────────────────────────

TEST_CASE("idempotent transmute: Won path records receipt with new_item_id") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string token_holder = "test-receipt-xmute-holder";
    seedIdentity(db->getClient(), token_holder);

    constexpr int16_t kTypeA = 65;
    constexpr int16_t kTypeB = 66;
    seedItemType(db->getClient(), kTypeA);
    seedItemType(db->getClient(), kTypeB);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id IN ($1, $2)", kTypeA,
                                 kTypeB);

    const std::string item_a = seedHeldItem(db->getClient(), kTypeA, token_holder);
    const std::string item_b = seedHeldItem(db->getClient(), kTypeB, token_holder);

    const std::string tid = testUuid("000000000014");
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgItemRepo item_repo(db->getClient());
    assembled_server::PgTransferReceiptRepo receipt_repo(db->getClient());

    assembled_server::TransmuteParams params;
    params.item_id_a = item_a;
    params.expected_version_a = 0;
    params.item_id_b = item_b;
    params.expected_version_b = 0;
    params.holder_token = token_holder;

    const auto rec = receipt_repo.idempotentTransmute(tid, item_repo, params);

    CHECK(rec.outcome == assembled_server::ReceiptOutcome::Won);
    // new_item_id must be populated on a Won transmute.
    REQUIRE(rec.new_item_id.has_value());
    CHECK(!rec.new_item_id->empty());

    // Receipt persisted with new_item_id.
    auto stored = receipt_repo.find(tid);
    REQUIRE(stored.has_value());
    CHECK(stored->outcome == assembled_server::ReceiptOutcome::Won);
    REQUIRE(stored->new_item_id.has_value());
    CHECK(stored->new_item_id == rec.new_item_id);
}

// ── Integration: expired receipt → fresh transfer ────────────────────────────

TEST_CASE("idempotent leave: expired receipt (>72h) is treated as fresh transfer") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner(ASSEMBLED_MIGRATIONS_DIR).applyPending(db->getClient());

    const std::string token_a = "test-receipt-exp-a";
    const std::string token_b = "test-receipt-exp-b";
    seedIdentity(db->getClient(), token_a);
    seedIdentity(db->getClient(), token_b);

    constexpr int16_t kTypeId = 67;
    seedItemType(db->getClient(), kTypeId);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_a = seedHeldItem(db->getClient(), kTypeId, token_a);
    const std::string item_b = seedHeldItem(db->getClient(), kTypeId, token_b);

    const std::string tid = testUuid("000000000015");
    db->getClient()->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id = $1", tid);

    assembled_server::PgItemRepo item_repo(db->getClient());
    assembled_server::PgTransferReceiptRepo receipt_repo(db->getClient());

    // ── First transfer: A leaves item_a ──────────────────────────────────────
    assembled_server::LeaveParams params_a;
    params_a.item_id = item_a;
    params_a.holder_token = token_a;
    params_a.expected_version = 0;
    params_a.hosted_by_token = token_b;
    params_a.anchor_arch = 1;
    params_a.anchor_tag = 1;

    const auto rec1 = receipt_repo.idempotentLeave(tid, item_repo, params_a);
    REQUIRE(rec1.outcome == assembled_server::ReceiptOutcome::Won);

    // Artificially expire the receipt.
    db->getClient()->execSqlSync(
        "UPDATE transfer_receipt SET bleed_at = now() - INTERVAL '1 second' "
        "WHERE transfer_id = $1",
        tid);

    // find() must now return nullopt.
    CHECK(!receipt_repo.find(tid).has_value());

    // ── Second transfer (same tid, but expired): B leaves item_b ─────────────
    // A fresh CAS should execute, advancing item_b from version 0 to 1.
    assembled_server::LeaveParams params_b;
    params_b.item_id = item_b;
    params_b.holder_token = token_b;
    params_b.expected_version = 0;
    params_b.hosted_by_token = token_a;
    params_b.anchor_arch = 1;
    params_b.anchor_tag = 2;

    const auto rec2 = receipt_repo.idempotentLeave(tid, item_repo, params_b);
    CHECK(rec2.outcome == assembled_server::ReceiptOutcome::Won);

    // item_b version must be 1 (fresh CAS ran).
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT version FROM item_instance WHERE id = $1", item_b);
        REQUIRE(!r.empty());
        CHECK(r[0]["version"].as<int32_t>() == 1);
    }
}
