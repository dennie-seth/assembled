#pragma once

/// @file assembled_server/OfferingRepo.h
/// @brief IOfferingRepo interface and PgOfferingRepo Postgres implementation (T-0097).
///
/// Implements the escrow claim transaction (INV-4, 08-invariants.md §1):
/// payment and release are one atomic Postgres transaction.  No observable
/// state exists where both parties hold, or neither holds.
///
/// **Claim transaction (03-net-protocol.md §5):**
///   1. `SELECT … FROM offering JOIN item_instance FOR UPDATE OF offering` —
///      locks the offering row to serialise concurrent claimers.
///   2. Verify payment item is held by the taker and matches `wants_type`.
///   3. CAS-transfer offered item: anchor → taker's hold
///      (`WHERE holder IS NULL AND version = $read_version` — same guard
///      as T-0095's ItemRepo::take()).
///   4. CAS-transfer payment item: taker's hold → author's hold.
///   5. DELETE the offering row.
///
/// If any step fails (expired offering, type mismatch, payment not held,
/// or CAS miss), the entire transaction is rolled back and neither item
/// changes custody — INV-4 is preserved by the DB, not by application logic.
///
/// **Expiry** (`07-items-economy.md §5`): `offering.expires_at` is checked
/// in the initial SELECT (`WHERE expires_at > now()`).  Unclaimed offerings
/// expire via the standard bleed path; there is no bespoke escrow-expiry
/// handler.
///
/// **INV-1** is enforced at the schema level by:
///   CHECK (num_nonnulls(holder, hosted_by) = 1)
/// so both-hold and neither-hold states are structurally impossible.

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <string>

namespace assembled_server {

/// Outcome of a claim attempt.
enum class ClaimError {
    None,                    ///< Claim succeeded; both transfers committed.
    OfferingExpiredOrMissing, ///< Offering not found or past expires_at (3004/3003).
    PaymentNotHeld,          ///< payment_item_id not in taker's inventory (3002).
    PaymentTypeMismatch,     ///< Payment item type != offering.wants_type (3005).
    CasLost,                 ///< CAS miss on offered or payment item (3001).
};

/// Parameters for IOfferingRepo::claim.
struct ClaimParams {
    std::string offering_id;     ///< UUID of the offering to claim.
    std::string taker_token;     ///< Identity claiming the offering.
    std::string payment_item_id; ///< UUID of the item the taker offers in exchange.
};

/// Result returned by claim() on success or failure.
///
/// On success (error == None), the offered item is now held by taker_token
/// and the payment item is now held by author_token.
struct ClaimResult {
    ClaimError error{ClaimError::None};

    // ── Populated only on error == None ──────────────────────────────────────

    std::string offered_item_id; ///< UUID of the item transferred to the taker.
    int32_t offered_version{};   ///< New version of the offered item (version + 1).
    int32_t offered_depth{};     ///< New custody_depth of the offered item.
    int32_t payment_version{};   ///< New version of the payment item (version + 1).
    int32_t payment_depth{};     ///< New custody_depth of the payment item.
    std::string author_token;    ///< Token of the identity that created the offering.
};

/// Abstract repository interface for offering operations.
///
/// All methods are synchronous; implementations throw
/// drogon::orm::DrogonDbException on unrecoverable DB errors.
/// A business-logic failure returns a ClaimError — it is NOT an exception.
class IOfferingRepo {
  public:
    virtual ~IOfferingRepo() = default;

    /// Atomically claims an offering: releases the offered item to the taker
    /// and transfers the payment item to the offering's author.
    ///
    /// Both custody changes happen in one Postgres transaction (INV-4).
    /// The offering row is deleted on success.
    ///
    /// CAS semantics on the offered item:
    ///   UPDATE item_instance … WHERE id = $offered_id AND holder IS NULL
    ///   AND version = $read_version
    /// (same guard as T-0095 ItemRepo::take; read_version is taken from the
    /// JOIN in the initial offering SELECT within the same transaction).
    ///
    /// @param params  Offering ID, taker identity token, and payment item ID.
    /// @return ClaimResult with error == None on success, or a specific
    ///         ClaimError indicating why the claim was rejected.
    virtual ClaimResult claim(const ClaimParams &params) = 0;
};

/// Postgres implementation of IOfferingRepo backed by a synchronous Drogon DbClient.
class PgOfferingRepo : public IOfferingRepo {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgOfferingRepo(drogon::orm::DbClientPtr client);

    ClaimResult claim(const ClaimParams &params) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
