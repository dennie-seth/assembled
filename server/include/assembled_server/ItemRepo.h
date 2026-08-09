#pragma once

/// @file assembled_server/ItemRepo.h
/// @brief IItemRepo interface and PgItemRepo Postgres implementation (T-0095).
///
/// Every custody transfer is a compare-and-swap on `item_instance.version`
/// (INV-2, docs/design/08-invariants.md §1).  The loser of a concurrent race
/// receives TransferStatus::Lost and must NOT partially apply any change.
///
/// INV-1 (single custody) is enforced at the schema level by:
///   CHECK (num_nonnulls(holder, hosted_by) = 1)
/// so a handler bug that produces a zero-holder or two-holder row is rejected
/// by Postgres before it can commit.
///
/// INV-5 (custody_depth strictly increases) is satisfied by the UPDATE:
///   custody_depth = custody_depth + 1
/// which is atomic and irreversible in a single statement.

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <optional>
#include <string>

namespace assembled_server {

/// Outcome of a custody transfer attempt.
enum class TransferStatus {
    Won,  ///< CAS matched — transfer committed.
    Lost, ///< CAS missed — another actor changed `version` first.
};

/// Result returned by leave() and take().
struct TransferResult {
    TransferStatus status{TransferStatus::Lost};
    int32_t new_version{};       ///< Updated version after a Won transfer.
    int32_t new_custody_depth{}; ///< Updated depth after a Won transfer.
};

/// Snapshot of a single item_instance row (read model).
struct ItemRecord {
    std::string id;
    int16_t type_id{};
    std::optional<std::string> holder;    ///< Token of the identity holding it.
    std::optional<std::string> hosted_by; ///< Universe (identity token) that anchors it.
    std::optional<int16_t> anchor_arch;
    std::optional<int16_t> anchor_tag;
    int32_t custody_depth{};
    int32_t version{};
};

/// Parameters for IItemRepo::leave — held → world anchor.
struct LeaveParams {
    std::string item_id;
    std::string holder_token;    ///< Must match item_instance.holder (identity A).
    int32_t expected_version{};  ///< CAS guard: must equal item_instance.version.
    std::string hosted_by_token; ///< Universe that will host the anchored item.
    int16_t anchor_arch{};
    int16_t anchor_tag{};
};

/// Parameters for IItemRepo::take — world anchor → held.
struct TakeParams {
    std::string item_id;
    std::string taker_token;    ///< Identity that wants to pick up the item (B or C).
    int32_t expected_version{}; ///< CAS guard: must equal item_instance.version.
};

/// Abstract repository interface for item custody transfers.
///
/// All methods are synchronous; implementations throw
/// drogon::orm::DrogonDbException on unrecoverable DB errors.
/// A CAS miss returns TransferStatus::Lost — it is NOT an exception.
class IItemRepo {
  public:
    virtual ~IItemRepo() = default;

    /// Returns the current state of one item, or std::nullopt if not found.
    virtual std::optional<ItemRecord> find(const std::string &item_id) = 0;

    /// Total count of item_instance rows for a given type_id (INV-3 probe).
    virtual int32_t countByType(int16_t type_id) = 0;

    /// Moves an item from a holder's inventory to a world anchor.
    ///
    /// CAS semantics: succeeds only if item_instance.version == expected_version
    /// and item_instance.holder == holder_token.  On success, atomically:
    ///   - clears holder, sets hosted_by + anchor
    ///   - increments version (INV-2)
    ///   - increments custody_depth (INV-5)
    ///
    /// @return Won with new_version/new_custody_depth, or Lost if the CAS failed.
    virtual TransferResult leave(const LeaveParams &params) = 0;

    /// Moves an item from a world anchor to a taker's inventory.
    ///
    /// CAS semantics: succeeds only if item_instance.version == expected_version
    /// and holder IS NULL (item is actually at an anchor, not already held).
    /// On success, atomically:
    ///   - sets holder = taker_token, clears hosted_by + anchor
    ///   - increments version (INV-2)
    ///   - increments custody_depth (INV-5)
    ///
    /// @return Won with new_version/new_custody_depth, or Lost if the CAS failed.
    virtual TransferResult take(const TakeParams &params) = 0;
};

/// Postgres implementation of IItemRepo backed by a synchronous Drogon DbClient.
class PgItemRepo : public IItemRepo {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgItemRepo(drogon::orm::DbClientPtr client);

    std::optional<ItemRecord> find(const std::string &item_id) override;
    int32_t countByType(int16_t type_id) override;
    TransferResult leave(const LeaveParams &params) override;
    TransferResult take(const TakeParams &params) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
