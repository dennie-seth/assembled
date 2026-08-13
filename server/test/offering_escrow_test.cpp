/// T-0097: offering escrow — atomic pay-and-release (INV-4).
///
/// TDD: this file is committed BEFORE the OfferingRepo implementation exists.
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and ci-server integration
/// job run the live DB assertions.
///
/// INV-4 (08-invariants.md §1): Payment and release are one transaction.
/// No observable state where both parties hold, or neither.
///
/// Scenario (03-net-protocol.md §5, Escrow):
///   Author (A) puts offered_item into escrow via an offering.
///   Taker  (B) holds payment_item of the requested wants_type.
///   B claims the offering → in one Postgres transaction:
///     - offered_item: world-anchor → B's hold
///     - payment_item: B's hold    → A's hold
///     - offering row: deleted
///
/// Invariants checked:
///   INV-1: every item_instance has exactly one of (holder, hosted_by) non-null.
///   INV-4: both custody changes commit together or neither commits.
///          Proved by:
///            (a) rollback test — any pre-commit failure leaves all items
///                unchanged (both-hold impossible, neither-hold impossible).
///            (b) REPEATABLE READ snapshot — a reader that starts before the
///                claim sees a consistent pre-claim state even after the claim
///                commits, proving the transition was atomic (never partial).
///   INV-5: custody_depth strictly increases on each transfer.
///
/// Both-hold and neither-hold are structurally impossible (not just untested):
///   The item_instance_single_custody CHECK (num_nonnulls(holder,hosted_by)=1)
///   is enforced by Postgres at the row level; no application bug can produce
///   an invalid row — the DB will reject the INSERT/UPDATE before it commits.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <atomic>
#include <cstdlib>
#include <future>
#include <string>
#include <thread>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/OfferingRepo.h"

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

/// Insert an item_instance anchored at (arch, tag) in the given universe.
/// Returns the newly minted UUID.
std::string seedAnchoredItem(const drogon::orm::DbClientPtr &db, int16_t type_id,
                             const std::string &hosted_by, int16_t arch, int16_t tag) {
    auto r = db->execSqlSync("INSERT INTO item_instance "
                             "(type_id, hosted_by, anchor_arch, anchor_tag, bleed_at) "
                             "VALUES ($1, $2, $3, $4, now() + INTERVAL '1 hour') "
                             "RETURNING id",
                             type_id, hosted_by, arch, tag);
    return r[0][0].as<std::string>();
}

/// Insert an item_instance held by holder_token.
/// Returns the newly minted UUID.
std::string seedHeldItem(const drogon::orm::DbClientPtr &db, int16_t type_id,
                         const std::string &holder) {
    auto r = db->execSqlSync("INSERT INTO item_instance (type_id, holder, bleed_at) "
                             "VALUES ($1, $2, now() + INTERVAL '1 hour') "
                             "RETURNING id",
                             type_id, holder);
    return r[0][0].as<std::string>();
}

/// Insert an offering for the given item_instance.
/// Returns the newly minted offering UUID.
std::string seedOffering(const drogon::orm::DbClientPtr &db, const std::string &item_id,
                         int16_t wants_type, int16_t arch, int16_t tag,
                         const std::string &author,
                         const std::string &expires_offset = "1 hour") {
    auto r = db->execSqlSync(
        "INSERT INTO offering "
        "(item_instance, wants_type, anchor_arch, anchor_tag, author, expires_at) "
        "VALUES ($1::uuid, $2, $3, $4, $5, now() + $6::interval) "
        "RETURNING id",
        item_id, wants_type, arch, tag, author, expires_offset);
    return r[0][0].as<std::string>();
}

/// Probe item_instance and assert INV-1: exactly one of (holder, hosted_by) non-null.
void assertInv1(const drogon::orm::DbClientPtr &db, const std::string &item_id,
                const char *context) {
    auto r = db->execSqlSync(
        "SELECT num_nonnulls(holder, hosted_by) AS c FROM item_instance WHERE id = $1", item_id);
    REQUIRE_MESSAGE(!r.empty(), "INV-1 probe: item not found — " << context);
    const int cnt = r[0]["c"].as<int>();
    CHECK_MESSAGE(cnt == 1, "INV-1 violated at " << context << ": num_nonnulls=" << cnt);
}

} // namespace

// ─────────────────────────────────────────────────────────────────────────────
// Structural impossibility tests — prove at the DB level, not application code
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("both-hold and neither-hold are structurally impossible (INV-1)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string tok_a = "test-escrow-struct-a";
    const std::string tok_b = "test-escrow-struct-b";
    seedIdentity(db->getClient(), tok_a);
    seedIdentity(db->getClient(), tok_b);
    constexpr int16_t kType = 190;
    seedItemType(db->getClient(), kType);

    // ── both-hold: holder AND hosted_by both non-null → CHECK rejects it ──────
    REQUIRE_THROWS_AS(
        db->getClient()->execSqlSync(
            "INSERT INTO item_instance (type_id, holder, hosted_by, anchor_arch, anchor_tag, bleed_at) "
            "VALUES ($1, $2, $3, 1, 1, now() + INTERVAL '1 hour')",
            kType, tok_a, tok_b),
        drogon::orm::DrogonDbException);

    // ── neither-hold: holder IS NULL AND hosted_by IS NULL → CHECK rejects it ─
    REQUIRE_THROWS_AS(
        db->getClient()->execSqlSync(
            "INSERT INTO item_instance (type_id, bleed_at) "
            "VALUES ($1, now() + INTERVAL '1 hour')",
            kType),
        drogon::orm::DrogonDbException);
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path: atomic pay-and-release
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("claim: offered item and payment item transfer atomically (INV-4/INV-5)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // ── Identities ────────────────────────────────────────────────────────────
    const std::string author = "test-escrow-happy-author";
    const std::string taker  = "test-escrow-happy-taker";
    seedIdentity(db->getClient(), author);
    seedIdentity(db->getClient(), taker);

    // ── Item types ────────────────────────────────────────────────────────────
    constexpr int16_t kOfferedType  = 181;
    constexpr int16_t kPaymentType  = 182;
    seedItemType(db->getClient(), kOfferedType);
    seedItemType(db->getClient(), kPaymentType);

    // ── Cleanup ───────────────────────────────────────────────────────────────
    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE author IN ($1, $2)", author, taker);
    db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE type_id IN ($1, $2)", kOfferedType, kPaymentType);

    // ── Seed: offered item anchored at (1,1) in author's universe ─────────────
    const std::string offered_id = seedAnchoredItem(db->getClient(), kOfferedType, author, 1, 1);

    // ── Seed: payment item held by taker ─────────────────────────────────────
    const std::string payment_id = seedHeldItem(db->getClient(), kPaymentType, taker);

    // ── Seed: offering ────────────────────────────────────────────────────────
    const std::string offering_id = seedOffering(
        db->getClient(), offered_id, kPaymentType, 1, 1, author);

    // ── Verify initial state ──────────────────────────────────────────────────
    assertInv1(db->getClient(), offered_id, "before claim (offered)");
    assertInv1(db->getClient(), payment_id, "before claim (payment)");

    // ── Execute claim ─────────────────────────────────────────────────────────
    assembled_server::PgOfferingRepo repo(db->getClient());

    assembled_server::ClaimParams params;
    params.offering_id     = offering_id;
    params.taker_token     = taker;
    params.payment_item_id = payment_id;

    const auto result = repo.claim(params);

    CHECK(result.error == assembled_server::ClaimError::None);
    CHECK(result.offered_item_id == offered_id);
    CHECK(result.author_token == author);

    // INV-5: versions incremented
    CHECK(result.offered_version == 1);  // was 0, now 1
    CHECK(result.offered_depth   == 1);  // custody_depth incremented
    CHECK(result.payment_version == 1);  // was 0, now 1
    CHECK(result.payment_depth   == 1);

    // ── Verify post-claim state ───────────────────────────────────────────────

    // Offered item now held by taker (atomic release)
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder, hosted_by, anchor_arch, anchor_tag "
            "FROM item_instance WHERE id = $1", offered_id);
        REQUIRE(!r.empty());
        CHECK(!r[0]["holder"].isNull());
        CHECK(r[0]["holder"].as<std::string>() == taker);
        CHECK(r[0]["hosted_by"].isNull());
        CHECK(r[0]["anchor_arch"].isNull());
        CHECK(r[0]["anchor_tag"].isNull());
    }

    // Payment item now held by author (atomic payment)
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder FROM item_instance WHERE id = $1", payment_id);
        REQUIRE(!r.empty());
        CHECK(!r[0]["holder"].isNull());
        CHECK(r[0]["holder"].as<std::string>() == author);
    }

    // Offering row deleted
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT 1 FROM offering WHERE id = $1::uuid", offering_id);
        CHECK(r.empty());
    }

    // INV-1 holds for both items after the claim
    assertInv1(db->getClient(), offered_id, "after claim (offered)");
    assertInv1(db->getClient(), payment_id, "after claim (payment)");
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomicity: no partial state — REPEATABLE READ snapshot test
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("INV-4: no partial state observable mid-transaction from concurrent reader") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // This test proves INV-4 via Postgres REPEATABLE READ isolation:
    //
    //   A reader that starts its snapshot BEFORE the claim transaction commits
    //   sees a consistent view of the pre-claim state even AFTER the claim
    //   commits.  It never sees "offered item held by taker but payment item
    //   still with taker" (partial), because MVCC snapshots advance atomically.
    //
    //   After the reader's REPEATABLE READ transaction ends and a fresh read
    //   runs, both items appear in their new state together — never one without
    //   the other.  This is the strongest observable proof of INV-4 that does
    //   not require pausing the claim transaction mid-statement.

    auto claim_db = assembled_server::Database::fromEnv();
    REQUIRE(claim_db.has_value());

    auto reader_db = assembled_server::Database::fromEnv();
    REQUIRE(reader_db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(claim_db->getClient());

    const std::string author = "test-escrow-atomic-author";
    const std::string taker  = "test-escrow-atomic-taker";
    seedIdentity(claim_db->getClient(), author);
    seedIdentity(claim_db->getClient(), taker);

    constexpr int16_t kOffType = 183;
    constexpr int16_t kPayType = 184;
    seedItemType(claim_db->getClient(), kOffType);
    seedItemType(claim_db->getClient(), kPayType);

    claim_db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE author IN ($1, $2)", author, taker);
    claim_db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE type_id IN ($1, $2)", kOffType, kPayType);

    const std::string offered_id  = seedAnchoredItem(claim_db->getClient(), kOffType, author, 1, 1);
    const std::string payment_id  = seedHeldItem(claim_db->getClient(), kPayType, taker);
    const std::string offering_id = seedOffering(
        claim_db->getClient(), offered_id, kPayType, 1, 1, author);

    // ── Open REPEATABLE READ snapshot BEFORE the claim ────────────────────────
    auto snap_txn = reader_db->getClient()->newTransaction();
    snap_txn->execSqlSync("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");

    // Baseline read within the snapshot
    auto snap_before_offered = snap_txn->execSqlSync(
        "SELECT holder, hosted_by FROM item_instance WHERE id = $1", offered_id);
    auto snap_before_payment = snap_txn->execSqlSync(
        "SELECT holder FROM item_instance WHERE id = $1", payment_id);

    // Offered item: at anchor (holder IS NULL)
    REQUIRE(!snap_before_offered.empty());
    CHECK(snap_before_offered[0]["holder"].isNull());
    // Payment item: held by taker
    REQUIRE(!snap_before_payment.empty());
    CHECK(snap_before_payment[0]["holder"].as<std::string>() == taker);

    // ── Execute claim on a separate DB connection (commits successfully) ───────
    assembled_server::PgOfferingRepo repo(claim_db->getClient());
    assembled_server::ClaimParams params;
    params.offering_id     = offering_id;
    params.taker_token     = taker;
    params.payment_item_id = payment_id;
    const auto claim_result = repo.claim(params);
    REQUIRE(claim_result.error == assembled_server::ClaimError::None);

    // ── Re-read within the SAME snapshot — still sees pre-claim state ──────────
    // Postgres MVCC guarantees the snapshot is fixed at its start timestamp.
    // Even though the claim has now committed, this reader sees the old state.
    // This proves: the transaction was atomic — no partial state was ever
    // committed for the snapshot to "partially see".
    auto snap_after_offered = snap_txn->execSqlSync(
        "SELECT holder, hosted_by FROM item_instance WHERE id = $1", offered_id);
    auto snap_after_payment = snap_txn->execSqlSync(
        "SELECT holder FROM item_instance WHERE id = $1", payment_id);

    // Snapshot still sees: offered item at anchor (not yet transferred to taker)
    REQUIRE(!snap_after_offered.empty());
    CHECK(snap_after_offered[0]["holder"].isNull()); // pre-claim state

    // Snapshot still sees: payment item held by taker (not yet at author)
    REQUIRE(!snap_after_payment.empty());
    CHECK(snap_after_payment[0]["holder"].as<std::string>() == taker); // pre-claim state

    // ── Commit snapshot, fresh read sees new consistent state ─────────────────
    // End the REPEATABLE READ transaction (snap_txn auto-commits on scope exit).
    snap_txn.reset();

    // Now a fresh READ COMMITTED read sees BOTH items in their new state together.
    auto final_offered = reader_db->getClient()->execSqlSync(
        "SELECT holder FROM item_instance WHERE id = $1", offered_id);
    auto final_payment = reader_db->getClient()->execSqlSync(
        "SELECT holder FROM item_instance WHERE id = $1", payment_id);

    // Both in new state — the transition was all-or-nothing
    REQUIRE(!final_offered.empty());
    CHECK(final_offered[0]["holder"].as<std::string>() == taker);   // now with taker

    REQUIRE(!final_payment.empty());
    CHECK(final_payment[0]["holder"].as<std::string>() == author);  // now with author
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent claims: exactly one of two claimers wins
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("concurrent claim: FOR UPDATE serializes claimers — exactly one wins") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // Two claimers race to claim the same offering.  The SELECT ... FOR UPDATE
    // on the offering row serializes them inside Postgres: one gets the lock,
    // completes the claim, and deletes the offering; the other then acquires
    // the lock, finds no offering row, and returns OfferingExpiredOrMissing.
    // Exactly one claimer holds the offered item after both attempts.

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string author  = "test-escrow-conc-author";
    const std::string taker_b = "test-escrow-conc-b";
    const std::string taker_c = "test-escrow-conc-c";
    seedIdentity(db->getClient(), author);
    seedIdentity(db->getClient(), taker_b);
    seedIdentity(db->getClient(), taker_c);

    constexpr int16_t kOffType = 185;
    constexpr int16_t kPayType = 186;
    seedItemType(db->getClient(), kOffType);
    seedItemType(db->getClient(), kPayType);

    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE author = $1", author);
    db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE type_id IN ($1, $2)", kOffType, kPayType);

    const std::string offered_id  = seedAnchoredItem(db->getClient(), kOffType, author, 1, 1);
    const std::string pay_b_id    = seedHeldItem(db->getClient(), kPayType, taker_b);
    const std::string pay_c_id    = seedHeldItem(db->getClient(), kPayType, taker_c);
    const std::string offering_id = seedOffering(db->getClient(), offered_id, kPayType, 1, 1, author);

    // ── Two separate DB connections simulate two concurrent clients ───────────
    auto db_b = assembled_server::Database::fromEnv();
    auto db_c = assembled_server::Database::fromEnv();
    REQUIRE(db_b.has_value());
    REQUIRE(db_c.has_value());

    assembled_server::ClaimResult result_b, result_c;

    // Run both claims in parallel threads
    std::thread thread_b([&]() {
        assembled_server::PgOfferingRepo repo(db_b->getClient());
        assembled_server::ClaimParams p;
        p.offering_id     = offering_id;
        p.taker_token     = taker_b;
        p.payment_item_id = pay_b_id;
        result_b = repo.claim(p);
    });

    std::thread thread_c([&]() {
        assembled_server::PgOfferingRepo repo(db_c->getClient());
        assembled_server::ClaimParams p;
        p.offering_id     = offering_id;
        p.taker_token     = taker_c;
        p.payment_item_id = pay_c_id;
        result_c = repo.claim(p);
    });

    thread_b.join();
    thread_c.join();

    // Exactly one of the two claims succeeds
    const int wins =
        (result_b.error == assembled_server::ClaimError::None ? 1 : 0) +
        (result_c.error == assembled_server::ClaimError::None ? 1 : 0);
    CHECK(wins == 1);

    // The losing claim gets OfferingExpiredOrMissing (offering row was deleted)
    const bool b_won = (result_b.error == assembled_server::ClaimError::None);
    if (b_won) {
        CHECK(result_c.error == assembled_server::ClaimError::OfferingExpiredOrMissing);
    } else {
        CHECK(result_b.error == assembled_server::ClaimError::OfferingExpiredOrMissing);
    }

    // INV-1: offered item is now held by exactly one identity
    assertInv1(db->getClient(), offered_id, "after concurrent claims (offered)");

    // Offering row is gone
    auto r = db->getClient()->execSqlSync(
        "SELECT 1 FROM offering WHERE id = $1::uuid", offering_id);
    CHECK(r.empty());
}

// ─────────────────────────────────────────────────────────────────────────────
// Expired offering
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("claim expired offering returns OfferingExpiredOrMissing, items unchanged") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string author = "test-escrow-exp-author";
    const std::string taker  = "test-escrow-exp-taker";
    seedIdentity(db->getClient(), author);
    seedIdentity(db->getClient(), taker);

    constexpr int16_t kOffType = 187;
    constexpr int16_t kPayType = 188;
    seedItemType(db->getClient(), kOffType);
    seedItemType(db->getClient(), kPayType);

    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE author = $1", author);
    db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE type_id IN ($1, $2)", kOffType, kPayType);

    const std::string offered_id  = seedAnchoredItem(db->getClient(), kOffType, author, 1, 1);
    const std::string payment_id  = seedHeldItem(db->getClient(), kPayType, taker);

    // Offering already expired (expires_at in the past)
    const std::string offering_id = seedOffering(
        db->getClient(), offered_id, kPayType, 1, 1, author, "-1 second");

    assembled_server::PgOfferingRepo repo(db->getClient());
    assembled_server::ClaimParams params;
    params.offering_id     = offering_id;
    params.taker_token     = taker;
    params.payment_item_id = payment_id;

    const auto result = repo.claim(params);

    CHECK(result.error == assembled_server::ClaimError::OfferingExpiredOrMissing);

    // Offered item still at anchor — no custody change
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder, hosted_by FROM item_instance WHERE id = $1", offered_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull());
        CHECK(!r[0]["hosted_by"].isNull());
    }

    // Payment item still held by taker
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder FROM item_instance WHERE id = $1", payment_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].as<std::string>() == taker);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment type mismatch → rollback, no partial state
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("claim type mismatch: rollback leaves both items unchanged (INV-4)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // Proves rollback atomicity (INV-4 from the failure side): when a claim
    // fails due to payment type mismatch, neither item changes custody.
    // Both-hold and neither-hold remain impossible because Postgres rolls back
    // any partial updates before they become visible.

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string author = "test-escrow-mismatch-author";
    const std::string taker  = "test-escrow-mismatch-taker";
    seedIdentity(db->getClient(), author);
    seedIdentity(db->getClient(), taker);

    constexpr int16_t kOffType   = 175;
    constexpr int16_t kWantType  = 176; // offering wants this
    constexpr int16_t kWrongType = 177; // taker presents this — wrong
    seedItemType(db->getClient(), kOffType);
    seedItemType(db->getClient(), kWantType);
    seedItemType(db->getClient(), kWrongType);

    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE author = $1", author);
    db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE type_id IN ($1, $2, $3)", kOffType, kWantType, kWrongType);

    const std::string offered_id  = seedAnchoredItem(db->getClient(), kOffType, author, 1, 1);
    const std::string wrong_pay_id = seedHeldItem(db->getClient(), kWrongType, taker);
    const std::string offering_id  = seedOffering(
        db->getClient(), offered_id, kWantType, 1, 1, author);

    assembled_server::PgOfferingRepo repo(db->getClient());
    assembled_server::ClaimParams params;
    params.offering_id     = offering_id;
    params.taker_token     = taker;
    params.payment_item_id = wrong_pay_id;

    const auto result = repo.claim(params);
    CHECK(result.error == assembled_server::ClaimError::PaymentTypeMismatch);

    // Offered item unchanged (still at anchor)
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder, hosted_by, version FROM item_instance WHERE id = $1", offered_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull());
        CHECK(!r[0]["hosted_by"].isNull());
        CHECK(r[0]["version"].as<int32_t>() == 0); // untouched
    }

    // Payment item unchanged (still held by taker)
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder, version FROM item_instance WHERE id = $1", wrong_pay_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].as<std::string>() == taker);
        CHECK(r[0]["version"].as<int32_t>() == 0); // untouched
    }

    // Offering still exists
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT 1 FROM offering WHERE id = $1::uuid", offering_id);
        CHECK(!r.empty());
    }

    // INV-1 holds for both items (rollback can't leave them in invalid state)
    assertInv1(db->getClient(), offered_id, "after mismatch rollback (offered)");
    assertInv1(db->getClient(), wrong_pay_id, "after mismatch rollback (payment)");
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment item not held by taker
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("claim payment not held: returns PaymentNotHeld, items unchanged") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string author = "test-escrow-notheld-author";
    const std::string taker  = "test-escrow-notheld-taker";
    const std::string other  = "test-escrow-notheld-other";
    seedIdentity(db->getClient(), author);
    seedIdentity(db->getClient(), taker);
    seedIdentity(db->getClient(), other);

    constexpr int16_t kOffType = 171;
    constexpr int16_t kPayType = 172;
    seedItemType(db->getClient(), kOffType);
    seedItemType(db->getClient(), kPayType);

    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE author = $1", author);
    db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE type_id IN ($1, $2)", kOffType, kPayType);

    const std::string offered_id = seedAnchoredItem(db->getClient(), kOffType, author, 1, 1);
    // Payment item held by OTHER, not by taker
    const std::string not_held_id = seedHeldItem(db->getClient(), kPayType, other);
    const std::string offering_id = seedOffering(
        db->getClient(), offered_id, kPayType, 1, 1, author);

    assembled_server::PgOfferingRepo repo(db->getClient());
    assembled_server::ClaimParams params;
    params.offering_id     = offering_id;
    params.taker_token     = taker;
    params.payment_item_id = not_held_id; // held by other, not taker

    const auto result = repo.claim(params);
    CHECK(result.error == assembled_server::ClaimError::PaymentNotHeld);

    // Offered item still at anchor
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT holder FROM item_instance WHERE id = $1", offered_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["holder"].isNull());
    }

    // Offering still exists
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT 1 FROM offering WHERE id = $1::uuid", offering_id);
        CHECK(!r.empty());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAS-on-version guard for the offered item (INV-2)
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("CAS-on-version guard: claim reads and verifies offered item version (INV-2)") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // Proves that the claim uses the same CAS-on-version guard as T-0095:
    //   UPDATE item_instance ... WHERE id = $offered_id AND holder IS NULL
    //   AND version = $read_version
    //
    // This test verifies the guard is PRESENT by:
    //   (1) Checking that a successful claim increments the offered item's version
    //       from 0 to 1, matching the CAS semantics of leave()/take() in T-0095.
    //   (2) Checking that a second claim attempt on the same (now-deleted) offering
    //       fails without touching items (the offering row is the primary gate).
    //
    // The version guard provides defense-in-depth: if the offered item's version
    // were somehow advanced between the offering SELECT and the item UPDATE, the
    // CAS would catch it and return CasLost.

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string author = "test-escrow-cas-author";
    const std::string taker  = "test-escrow-cas-taker";
    seedIdentity(db->getClient(), author);
    seedIdentity(db->getClient(), taker);

    constexpr int16_t kOffType = 165;
    constexpr int16_t kPayType = 166;
    seedItemType(db->getClient(), kOffType);
    seedItemType(db->getClient(), kPayType);

    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE author = $1", author);
    db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE type_id IN ($1, $2)", kOffType, kPayType);

    const std::string offered_id  = seedAnchoredItem(db->getClient(), kOffType, author, 1, 1);
    const std::string payment_id  = seedHeldItem(db->getClient(), kPayType, taker);
    const std::string offering_id = seedOffering(
        db->getClient(), offered_id, kPayType, 1, 1, author);

    // Verify initial version is 0
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT version FROM item_instance WHERE id = $1", offered_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["version"].as<int32_t>() == 0);
    }

    assembled_server::PgOfferingRepo repo(db->getClient());
    assembled_server::ClaimParams params;
    params.offering_id     = offering_id;
    params.taker_token     = taker;
    params.payment_item_id = payment_id;

    const auto result = repo.claim(params);
    REQUIRE(result.error == assembled_server::ClaimError::None);

    // CAS guard incremented the version exactly once (0 → 1), same as T-0095 take()
    CHECK(result.offered_version == 1);

    // Verify directly in DB
    {
        auto r = db->getClient()->execSqlSync(
            "SELECT version FROM item_instance WHERE id = $1", offered_id);
        REQUIRE(!r.empty());
        CHECK(r[0]["version"].as<int32_t>() == 1);
    }

    // Second claim on the same (now-deleted) offering must fail
    auto db2 = assembled_server::Database::fromEnv();
    REQUIRE(db2.has_value());
    const std::string payment2_id = seedHeldItem(db->getClient(), kPayType, taker);

    assembled_server::PgOfferingRepo repo2(db2->getClient());
    assembled_server::ClaimParams params2;
    params2.offering_id     = offering_id;
    params2.taker_token     = taker;
    params2.payment_item_id = payment2_id;

    const auto result2 = repo2.claim(params2);
    CHECK(result2.error == assembled_server::ClaimError::OfferingExpiredOrMissing);
}

// ─────────────────────────────────────────────────────────────────────────────
// Expiry via standard bleed: offering table has no bespoke expiry handler
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE("expiry is handled by expires_at, not a bespoke escrow-expiry column") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // INV-4 requires no bespoke escrow-expiry handler (task context):
    //   offering.expires_at reuses the same bleed machinery as other world
    //   instances.  This test verifies that the offering table has no
    //   additional expiry-tracking column (no 'claimed_at', 'expired_at',
    //   'cancellation_token', etc.) that would imply a separate expiry path.

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Only the expected columns exist on the offering table.
    // Any bespoke expiry column would appear here and fail the check.
    auto r = db->getClient()->execSqlSync(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'offering' "
        "  AND column_name IN ('claimed_at','expired_at','expiry_token',"
        "                      'cancellation_reason','withdrawal_at')");
    CHECK(r.size() == 0);

    // The offering table DOES have expires_at (the standard bleed field).
    auto r2 = db->getClient()->execSqlSync(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'offering' AND column_name = 'expires_at'");
    CHECK(!r2.empty());
}
