/// T-0206: Cross-universe delivery proof.
///
/// Two clients (A and B), one server, one item.
/// Scenario (HANDOFF §20-d1, Stream D):
///   1. A holds an item whose bleed_at is already in the past (immediately
///      sweep-eligible).
///   2. A leaves the item at an anchor in B's universe via idempotentLeave();
///      a transfer receipt is recorded for A's side.
///   3. The sweep bleed runs on the dedicated test shard — the item's bleed_at
///      is still in the past (leave() does not update it), so the worker
///      re-anchors the item in a new universe, bumping version and custody_depth.
///   4. B takes the item from its new anchor via idempotentTake(); a transfer
///      receipt is recorded for B's side.
///
/// Acceptance criteria verified:
///   - Item visibly leaves A  (holder IS NULL after leave)
///   - Item arrives in B      (holder = B after take)
///   - Transfer receipt recorded on each side (leave + take)
///   - custody_depth incremented at each transfer step (0 → 1 → 2 → 3)
///
/// Test-ID reservations (do not reuse in other test files):
///   shard_id   : 9
///   item type  : 206
///   tokens     : "test-cross-alice", "test-cross-bob"
///   transfer UUIDs: 00000000-0000-0000-0206-000000000001 / ...0002

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <cstdlib>
#include <string>

#include "assembled_server/Database.h"
#include "assembled_server/ItemRepo.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/SweepWorker.h"
#include "assembled_server/TransferReceiptRepo.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Test-scope constants ──────────────────────────────────────────────────────

namespace {

constexpr int16_t kTypeId = 206; ///< T-0206 exclusive item type ID.
constexpr int16_t kShard = 9;    ///< T-0206 exclusive shard; not used by other test files.

const std::string kAlice = "test-cross-alice"; ///< Client A identity token.
const std::string kBob = "test-cross-bob";     ///< Client B identity token.

/// Fixed transfer IDs so we can clean them up reliably between runs.
const std::string kTidLeave = "00000000-0000-0000-0206-000000000001";
const std::string kTidTake = "00000000-0000-0000-0206-000000000002";

// ── Seed helpers ──────────────────────────────────────────────────────────────

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token, collapse_expires_at) "
                    "VALUES ($1, now() + INTERVAL '21 days') "
                    "ON CONFLICT (token) DO NOTHING",
                    token);
}

void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id) {
    db->execSqlSync(
        "INSERT INTO item_type (id, rarity) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING", id);
}

/// Seed an item held by alice with bleed_at already in the past — the sweep
/// will pick it up immediately on the next runBleed() call.  Returns the UUID.
std::string seedBleedReadyItem(const drogon::orm::DbClientPtr &db) {
    auto r = db->execSqlSync("INSERT INTO item_instance (type_id, holder, shard_id, bleed_at) "
                             "VALUES ($1, $2, $3, now() - INTERVAL '1 hour') "
                             "RETURNING id::text",
                             kTypeId, kAlice, kShard);
    return r[0][0].as<std::string>();
}

void cleanup(const drogon::orm::DbClientPtr &db) {
    db->execSqlSync("DELETE FROM transfer_receipt WHERE transfer_id IN ($1, $2)", kTidLeave,
                    kTidTake);
    db->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);
    db->execSqlSync("DELETE FROM type_census WHERE type_id = $1", kTypeId);
}

} // namespace

// ── Integration: full cross-universe delivery scenario ────────────────────────

TEST_CASE("cross-universe delivery: A leaves, sweep delivers, B takes (T-0206)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    auto client = db->getClient();

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(client);

    cleanup(client);

    seedIdentity(client, kAlice);
    seedIdentity(client, kBob);
    seedItemType(client, kTypeId);

    // ── Step 0: seed – A holds an item that is immediately bleed-eligible ─────
    const std::string item_id = seedBleedReadyItem(client);

    // Sanity: initial custody_depth = 0, holder = A.
    {
        auto r = client->execSqlSync(
            "SELECT custody_depth, holder FROM item_instance WHERE id = $1::uuid", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["custody_depth"].as<int32_t>() == 0);
        CHECK(r[0]["holder"].as<std::string>() == kAlice);
    }

    assembled_server::PgItemRepo item_repo(client);
    assembled_server::PgTransferReceiptRepo receipt_repo(client);

    // ── Step 1: A leaves item at an anchor in B's universe ───────────────────
    //
    // leave() does NOT update bleed_at, so after this call the item sits at
    // anchor with bleed_at still in the past — making it eligible for the next
    // sweep bleed cycle (step 2 below).

    assembled_server::LeaveParams leave_params;
    leave_params.item_id = item_id;
    leave_params.holder_token = kAlice;
    leave_params.expected_version = 0;
    leave_params.hosted_by_token = kBob; // anchor lives in B's universe
    leave_params.anchor_arch = 1;        // HOSPITAL archetype (seeded by migration 003)
    leave_params.anchor_tag = 1;         // entrance

    const auto leave_receipt =
        receipt_repo.idempotentLeave(kTidLeave, item_repo, leave_params);

    // Leave must win (CAS matched version 0, holder = alice).
    REQUIRE(leave_receipt.outcome == assembled_server::ReceiptOutcome::Won);
    REQUIRE(leave_receipt.new_version.has_value());
    CHECK(*leave_receipt.new_version == 1);
    REQUIRE(leave_receipt.new_custody_depth.has_value());
    CHECK(*leave_receipt.new_custody_depth == 1); // INV-5: 0 → 1

    // ── Criterion: "item visibly leaves A" ───────────────────────────────────
    {
        auto r = client->execSqlSync(
            "SELECT holder, hosted_by FROM item_instance WHERE id = $1::uuid", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull());      // A no longer holds it
        CHECK(!r[0]["hosted_by"].isNull()); // anchored in some universe
    }

    // Leave receipt persisted and reflects the Win.
    {
        auto stored = receipt_repo.find(kTidLeave);
        REQUIRE(stored.has_value());
        CHECK(stored->outcome == assembled_server::ReceiptOutcome::Won);
        CHECK(stored->kind == "leave");
    }

    // ── Step 2: sweep bleed delivers the item to a new universe ──────────────
    //
    // The bleed phase selects items WHERE bleed_at < now() AND shard_id = 9.
    // Our item qualifies (bleed_at was set to -1 h at seed time and leave() did
    // not advance it).  The worker re-anchors it in a random identity's universe
    // and increments version and custody_depth.

    assembled_server::PgSweepWorker sweep(client, kShard);
    const auto bleed = sweep.runBleed();

    // At least our item must have been re-anchored.
    CHECK(bleed.landed >= 1);

    // After sweep: holder IS NULL (still anchored), version = 2, depth = 2.
    int32_t version_after_sweep{};
    {
        auto r = client->execSqlSync(
            "SELECT holder, version, custody_depth FROM item_instance WHERE id = $1::uuid",
            item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull());
        version_after_sweep = r[0]["version"].as<int32_t>();
        CHECK(version_after_sweep == 2);                        // leave→1, sweep→2
        CHECK(r[0]["custody_depth"].as<int32_t>() == 2);       // INV-5: 1 → 2
    }

    // ── Step 3: B takes the item from its new anchor ──────────────────────────
    //
    // take() only requires holder IS NULL and the correct version — it does NOT
    // restrict the taker to the hosted_by universe owner.  B can pick up the
    // item regardless of which universe the sweep placed it in.

    assembled_server::TakeParams take_params;
    take_params.item_id = item_id;
    take_params.taker_token = kBob;
    take_params.expected_version = version_after_sweep;

    const auto take_receipt = receipt_repo.idempotentTake(kTidTake, item_repo, take_params);

    // Take must win.
    REQUIRE(take_receipt.outcome == assembled_server::ReceiptOutcome::Won);
    REQUIRE(take_receipt.new_version.has_value());
    CHECK(*take_receipt.new_version == 3);
    REQUIRE(take_receipt.new_custody_depth.has_value());
    CHECK(*take_receipt.new_custody_depth == 3); // INV-5: 2 → 3

    // ── Criterion: "item arrives in B" ────────────────────────────────────────
    {
        auto r = client->execSqlSync(
            "SELECT holder, hosted_by FROM item_instance WHERE id = $1::uuid", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].as<std::string>() == kBob); // B now holds it
        CHECK(r[0]["hosted_by"].isNull());               // no longer anchored
    }

    // ── Criterion: "transfer receipt recorded on each side" ───────────────────
    {
        // A's side: leave receipt.
        auto leave_stored = receipt_repo.find(kTidLeave);
        REQUIRE(leave_stored.has_value());
        CHECK(leave_stored->outcome == assembled_server::ReceiptOutcome::Won);
        CHECK(leave_stored->kind == "leave");

        // B's side: take receipt.
        auto take_stored = receipt_repo.find(kTidTake);
        REQUIRE(take_stored.has_value());
        CHECK(take_stored->outcome == assembled_server::ReceiptOutcome::Won);
        CHECK(take_stored->kind == "take");
    }

    // ── Criterion: "custody_depth incremented" ────────────────────────────────
    //
    // Full chain: 0 (seed) → 1 (leave) → 2 (sweep bleed) → 3 (take).
    {
        auto r = client->execSqlSync(
            "SELECT custody_depth FROM item_instance WHERE id = $1::uuid", item_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["custody_depth"].as<int32_t>() == 3);
    }
}
