#pragma once

/// @file assembled_server/TransferReceiptRepo.h
/// @brief ITransferReceiptRepo interface and PgTransferReceiptRepo implementation (T-0126).
///
/// Every custody-change request (leave/use/take/transmute) carries a client-minted
/// transfer_id UUID. The receipt table stores the outcome of each transfer keyed on
/// that UUID (03-net-protocol.md §4).
///
/// Idempotency contract:
///   1. A request with a fresh transfer_id executes the CAS and records its outcome.
///   2. A repeat request with the same transfer_id (within 72 h) returns the stored
///      outcome without re-running the CAS — even if the item's version has since moved.
///   3. A repeat request against an expired receipt (> 72 h old) is treated as a
///      fresh transfer: the expired row is removed and a new receipt is created.
///
/// Concurrent safety: tryClaimSlot() uses INSERT ... ON CONFLICT DO NOTHING, so
/// exactly one concurrent caller can claim each transfer_id slot.  The other caller
/// observes the stored receipt via find() once the winner has settled it.

#include "assembled_server/ItemRepo.h"

#include <drogon/orm/DbClient.h>

#include <optional>
#include <string>

namespace assembled_server {

/// Outcome states for a receipt row.
enum class ReceiptOutcome {
    Pending, ///< CAS is in flight (transient; normally invisible to HTTP callers).
    Won,     ///< CAS succeeded — transfer committed.
    Lost,    ///< CAS failed — version mismatch or custody conflict.
};

/// Stored record from the transfer_receipt table.
struct ReceiptRecord {
    std::string transfer_id;
    std::string kind;            ///< "leave" | "use" | "take" | "transmute"
    std::string item_id;
    ReceiptOutcome outcome{ReceiptOutcome::Pending};
    std::optional<int32_t> new_version;       ///< Set on Won leave/use/take.
    std::optional<int32_t> new_custody_depth; ///< Set on Won leave/use/take.
    std::optional<std::string> new_item_id;   ///< Set on Won transmute only.
    std::string created_at;
};

/// Abstract repository for transfer receipts.
///
/// The idempotent* methods combine receipt-table access with an IItemRepo reference
/// so that each operation performs exactly one CAS for a given transfer_id.
class ITransferReceiptRepo {
  public:
    virtual ~ITransferReceiptRepo() = default;

    /// Returns the stored receipt if it exists and has not expired (bleed_at > now()).
    /// Returns nullopt if no live (non-expired) receipt exists for this transfer_id.
    virtual std::optional<ReceiptRecord> find(const std::string &transfer_id) = 0;

    /// Atomically attempts to claim the slot for a new transfer.
    ///
    /// If an expired receipt exists for this transfer_id it is removed first.
    /// Inserts a 'pending' row via INSERT ... ON CONFLICT DO NOTHING.
    ///
    /// @return true  — this caller owns the slot; must call recordWon() or recordLost().
    /// @return false — a live receipt already exists; caller must use find() for the outcome.
    virtual bool tryClaimSlot(const std::string &transfer_id, const std::string &kind,
                              const std::string &item_id) = 0;

    /// Records a successful CAS outcome.
    ///
    /// @param new_version       Set for leave/use/take; nullopt for transmute.
    /// @param new_custody_depth Set for leave/use/take; nullopt for transmute.
    /// @param new_item_id       Set for Won transmute only; nullopt otherwise.
    virtual void recordWon(const std::string &transfer_id,
                           std::optional<int32_t> new_version,
                           std::optional<int32_t> new_custody_depth,
                           std::optional<std::string> new_item_id = std::nullopt) = 0;

    /// Records a failed CAS outcome.
    virtual void recordLost(const std::string &transfer_id) = 0;

    /// Idempotent leave: executes item_repo.leave() the first time, replays the
    /// stored receipt on any subsequent call with the same transfer_id.
    virtual ReceiptRecord idempotentLeave(const std::string &transfer_id, IItemRepo &item_repo,
                                          const LeaveParams &params) = 0;

    /// Idempotent take: executes item_repo.take() the first time, replays stored receipt.
    virtual ReceiptRecord idempotentTake(const std::string &transfer_id, IItemRepo &item_repo,
                                         const TakeParams &params) = 0;

    /// Idempotent use: executes item_repo.use() the first time, replays stored receipt.
    virtual ReceiptRecord idempotentUse(const std::string &transfer_id, IItemRepo &item_repo,
                                        const UseParams &params) = 0;

    /// Idempotent transmute: executes item_repo.transmute() the first time, replays stored receipt.
    virtual ReceiptRecord idempotentTransmute(const std::string &transfer_id, IItemRepo &item_repo,
                                              const TransmuteParams &params) = 0;
};

/// Postgres implementation of ITransferReceiptRepo backed by a synchronous Drogon DbClient.
class PgTransferReceiptRepo : public ITransferReceiptRepo {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgTransferReceiptRepo(drogon::orm::DbClientPtr client);

    std::optional<ReceiptRecord> find(const std::string &transfer_id) override;

    bool tryClaimSlot(const std::string &transfer_id, const std::string &kind,
                      const std::string &item_id) override;

    void recordWon(const std::string &transfer_id,
                   std::optional<int32_t> new_version,
                   std::optional<int32_t> new_custody_depth,
                   std::optional<std::string> new_item_id = std::nullopt) override;

    void recordLost(const std::string &transfer_id) override;

    ReceiptRecord idempotentLeave(const std::string &transfer_id, IItemRepo &item_repo,
                                  const LeaveParams &params) override;

    ReceiptRecord idempotentTake(const std::string &transfer_id, IItemRepo &item_repo,
                                  const TakeParams &params) override;

    ReceiptRecord idempotentUse(const std::string &transfer_id, IItemRepo &item_repo,
                                 const UseParams &params) override;

    ReceiptRecord idempotentTransmute(const std::string &transfer_id, IItemRepo &item_repo,
                                      const TransmuteParams &params) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
