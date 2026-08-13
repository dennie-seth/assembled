/// T-0097: PgOfferingRepo — atomic escrow claim (INV-4).
///
/// claim() executes five steps inside one Postgres transaction:
///
///   1. SELECT offering + offered-item version, FOR UPDATE OF offering.
///      Locks the offering row so concurrent claimers are serialised by
///      Postgres rather than racing.  The loser acquires the lock only
///      after the winner has committed and deleted the offering row, so it
///      finds no row and returns OfferingExpiredOrMissing immediately.
///
///   2. Verify the payment item is held by the taker (holder = taker_token).
///      Returns PaymentNotHeld if not found.
///
///   3. Verify payment item type == offering.wants_type.
///      Returns PaymentTypeMismatch if they differ.
///
///   4. CAS-transfer offered item: world-anchor → taker hold.
///      WHERE holder IS NULL AND version = $offered_version_read_in_step_1
///      This is the same CAS guard as ItemRepo::take() (INV-2, T-0095).
///      Returns CasLost if 0 rows matched (concurrent direct modification).
///
///   5. CAS-transfer payment item: taker hold → author hold.
///      WHERE holder = $taker AND version = $payment_version_read_in_step_2
///      Returns CasLost if 0 rows matched.
///
///   6. DELETE the offering row.
///
/// On any failure (steps 1–5), txn->rollback() is called explicitly before
/// returning so neither item changes custody — INV-4 holds via the DB, not
/// application-level field tracking.
///
/// INV-1 (single custody) is enforced by the DB CHECK constraint:
///   CHECK (num_nonnulls(holder, hosted_by) = 1)
/// so neither both-hold nor neither-hold can exist even under a bug.
///
/// INV-5 (custody_depth monotonic) is satisfied by `custody_depth + 1` in
/// both UPDATE statements.

#include "assembled_server/OfferingRepo.h"

#include <drogon/orm/Exception.h>

#include <stdexcept>

namespace assembled_server {

PgOfferingRepo::PgOfferingRepo(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

ClaimResult PgOfferingRepo::claim(const ClaimParams &params) {
    auto txn = client_->newTransaction();

    // ── Step 1: Lock offering row and read offered-item version ───────────────
    //
    // FOR UPDATE OF o locks the offering row exclusively.  Any other claim
    // attempt on the same offering will wait here until this transaction
    // commits or rolls back, then find the row gone (committed) or still
    // present (rolled back), and proceed accordingly.
    //
    // The JOIN reads the offered item's current version in the same statement
    // so it is consistent with the lock acquisition (both are inside the
    // same transaction snapshot).
    const auto offer_rows = txn->execSqlSync("SELECT o.id, o.item_instance::text AS item_instance, "
                                             "       o.wants_type, o.author, "
                                             "       ii.version AS offered_version "
                                             "FROM offering o "
                                             "JOIN item_instance ii ON ii.id = o.item_instance "
                                             "WHERE o.id = $1::uuid "
                                             "  AND o.expires_at > now() "
                                             "FOR UPDATE OF o",
                                             params.offering_id);

    if (offer_rows.empty()) {
        // Offering does not exist or has already expired / been claimed.
        txn->rollback();
        return ClaimResult{ClaimError::OfferingExpiredOrMissing};
    }

    const std::string offered_item_id = offer_rows[0]["item_instance"].as<std::string>();
    const int16_t wants_type = offer_rows[0]["wants_type"].as<int16_t>();
    const std::string author_token = offer_rows[0]["author"].as<std::string>();
    const int32_t offered_version = offer_rows[0]["offered_version"].as<int32_t>();

    // ── Step 2: Verify payment item is held by the taker ─────────────────────
    const auto pay_rows = txn->execSqlSync("SELECT type_id, version "
                                           "FROM item_instance "
                                           "WHERE id = $1::uuid AND holder = $2",
                                           params.payment_item_id, params.taker_token);

    if (pay_rows.empty()) {
        txn->rollback();
        return ClaimResult{ClaimError::PaymentNotHeld};
    }

    const int16_t payment_type = pay_rows[0]["type_id"].as<int16_t>();
    const int32_t payment_version = pay_rows[0]["version"].as<int32_t>();

    // ── Step 3: Verify payment type matches offering ──────────────────────────
    if (payment_type != wants_type) {
        txn->rollback();
        return ClaimResult{ClaimError::PaymentTypeMismatch};
    }

    // ── Step 4: CAS-transfer offered item from world-anchor to taker ──────────
    //
    // Uses the same CAS pattern as ItemRepo::take() (T-0095, INV-2):
    //   WHERE holder IS NULL              — item must be at a world anchor
    //   AND version = $offered_version    — version read in step 1 must still hold
    //
    // Clears hosted_by and anchor columns; sets holder = taker.
    // Both version and custody_depth are incremented atomically (INV-2, INV-5).
    const auto release_rows =
        txn->execSqlSync("UPDATE item_instance "
                         "SET holder        = $1, "
                         "    hosted_by     = NULL, "
                         "    anchor_arch   = NULL, "
                         "    anchor_tag    = NULL, "
                         "    version       = version + 1, "
                         "    custody_depth = custody_depth + 1 "
                         "WHERE id      = $2::uuid "
                         "  AND holder  IS NULL "
                         "  AND version = $3 "
                         "RETURNING version, custody_depth",
                         params.taker_token, offered_item_id, offered_version);

    if (release_rows.empty()) {
        // CAS miss: offered item's version changed between step 1 and now.
        // Defence-in-depth against any concurrent direct modification of the
        // offered item that bypassed the offering lock.
        txn->rollback();
        return ClaimResult{ClaimError::CasLost};
    }

    const int32_t new_offered_version = release_rows[0]["version"].as<int32_t>();
    const int32_t new_offered_depth = release_rows[0]["custody_depth"].as<int32_t>();

    // ── Step 5: CAS-transfer payment item from taker to author ───────────────
    //
    // Only updates holder; hosted_by stays NULL (payment item was held, so
    // hosted_by was already NULL — the DB CHECK enforces this invariant).
    const auto pay_update_rows =
        txn->execSqlSync("UPDATE item_instance "
                         "SET holder        = $1, "
                         "    version       = version + 1, "
                         "    custody_depth = custody_depth + 1 "
                         "WHERE id      = $2::uuid "
                         "  AND holder  = $3 "
                         "  AND version = $4 "
                         "RETURNING version, custody_depth",
                         author_token, params.payment_item_id, params.taker_token, payment_version);

    if (pay_update_rows.empty()) {
        // CAS miss: payment item changed between step 2 and now (concurrent use).
        txn->rollback();
        return ClaimResult{ClaimError::CasLost};
    }

    const int32_t new_payment_version = pay_update_rows[0]["version"].as<int32_t>();
    const int32_t new_payment_depth = pay_update_rows[0]["custody_depth"].as<int32_t>();

    // ── Step 6: Delete the offering row ──────────────────────────────────────
    // The offering is no longer claimable once both transfers succeed.
    txn->execSqlSync("DELETE FROM offering WHERE id = $1::uuid", params.offering_id);

    // Transaction auto-commits when txn goes out of scope (no rollback called).
    ClaimResult result;
    result.error = ClaimError::None;
    result.offered_item_id = offered_item_id;
    result.offered_version = new_offered_version;
    result.offered_depth = new_offered_depth;
    result.payment_version = new_payment_version;
    result.payment_depth = new_payment_depth;
    result.author_token = author_token;
    return result;
}

} // namespace assembled_server
