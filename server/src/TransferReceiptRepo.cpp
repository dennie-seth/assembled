/// T-0126: PgTransferReceiptRepo — idempotent transfer receipts.
///
/// Each public method executes against the transfer_receipt table.
///
/// tryClaimSlot() is the concurrent-safety primitive: it runs a transaction
/// that (1) removes any expired receipt for the transfer_id and (2) attempts
/// INSERT ... ON CONFLICT DO NOTHING.  The caller that wins the INSERT owns
/// the slot and must run the CAS; all other callers find the stored receipt
/// via find().
///
/// The idempotent* methods combine receipt-table access with IItemRepo so that
/// exactly one CAS runs per transfer_id within the 72 h bleed window.

#include "assembled_server/TransferReceiptRepo.h"

#include <drogon/orm/Exception.h>

namespace assembled_server {

// ── Helpers ───────────────────────────────────────────────────────────────────

namespace {

/// Parse the `outcome` TEXT column into a ReceiptOutcome enum.
ReceiptOutcome parseOutcome(const std::string &s) {
    if (s == "won") {
        return ReceiptOutcome::Won;
    }
    if (s == "lost") {
        return ReceiptOutcome::Lost;
    }
    return ReceiptOutcome::Pending;
}

/// Build a ReceiptRecord from a single DB result row.
ReceiptRecord rowToRecord(const drogon::orm::Row &row) {
    ReceiptRecord rec;
    rec.transfer_id = row["transfer_id"].as<std::string>();
    rec.kind = row["kind"].as<std::string>();
    rec.item_id = row["item_id"].as<std::string>();
    rec.outcome = parseOutcome(row["outcome"].as<std::string>());

    if (!row["new_version"].isNull()) {
        rec.new_version = row["new_version"].as<int32_t>();
    }
    if (!row["new_custody_depth"].isNull()) {
        rec.new_custody_depth = row["new_custody_depth"].as<int32_t>();
    }
    if (!row["new_item_id"].isNull()) {
        rec.new_item_id = row["new_item_id"].as<std::string>();
    }
    rec.created_at = row["created_at"].as<std::string>();
    return rec;
}

} // namespace

// ── PgTransferReceiptRepo ─────────────────────────────────────────────────────

PgTransferReceiptRepo::PgTransferReceiptRepo(drogon::orm::DbClientPtr client)
    : client_(std::move(client)) {}

std::optional<ReceiptRecord> PgTransferReceiptRepo::find(const std::string &transfer_id) {
    auto result = client_->execSqlSync(
        "SELECT transfer_id, kind, item_id, outcome, "
        "       new_version, new_custody_depth, new_item_id, created_at "
        "FROM transfer_receipt "
        "WHERE transfer_id = $1 AND bleed_at > now()",
        transfer_id);

    if (result.empty()) {
        return std::nullopt;
    }
    return rowToRecord(result[0]);
}

bool PgTransferReceiptRepo::tryClaimSlot(const std::string &transfer_id, const std::string &kind,
                                          const std::string &item_id) {
    auto txn = client_->newTransaction();

    // Remove any expired receipt for this transfer_id so it does not block
    // the INSERT that follows.  Idempotent: no-op if there is nothing expired.
    txn->execSqlSync(
        "DELETE FROM transfer_receipt WHERE transfer_id = $1 AND bleed_at < now()",
        transfer_id);

    // Atomically claim the slot.  ON CONFLICT DO NOTHING leaves a live receipt
    // untouched — the RETURNING clause is empty iff a live receipt already exists.
    auto result = txn->execSqlSync(
        "INSERT INTO transfer_receipt (transfer_id, kind, item_id, outcome) "
        "VALUES ($1, $2, $3, 'pending') "
        "ON CONFLICT (transfer_id) DO NOTHING "
        "RETURNING transfer_id",
        transfer_id, kind, item_id);

    // Transaction auto-commits when txn goes out of scope.
    return !result.empty(); // true = we own the slot
}

void PgTransferReceiptRepo::recordWon(const std::string &transfer_id,
                                       std::optional<int32_t> new_version,
                                       std::optional<int32_t> new_custody_depth,
                                       std::optional<std::string> new_item_id) {
    // Four-way dispatch based on which optional fields are present.
    // transmute: new_item_id set, version/depth null.
    // leave/use/take: version+depth set, new_item_id null.
    if (new_item_id.has_value() && new_version.has_value()) {
        // Unusual: all three present.
        client_->execSqlSync(
            "UPDATE transfer_receipt "
            "SET outcome = 'won', new_version = $2, new_custody_depth = $3, new_item_id = $4 "
            "WHERE transfer_id = $1",
            transfer_id, *new_version, *new_custody_depth, *new_item_id);
    } else if (new_item_id.has_value()) {
        // Transmute: only new_item_id is meaningful.
        client_->execSqlSync(
            "UPDATE transfer_receipt "
            "SET outcome = 'won', new_item_id = $2 "
            "WHERE transfer_id = $1",
            transfer_id, *new_item_id);
    } else if (new_version.has_value()) {
        // leave/use/take: version and depth, no new_item_id.
        client_->execSqlSync(
            "UPDATE transfer_receipt "
            "SET outcome = 'won', new_version = $2, new_custody_depth = $3 "
            "WHERE transfer_id = $1",
            transfer_id, *new_version, *new_custody_depth);
    } else {
        // Won with no fields (shouldn't happen in practice; record outcome only).
        client_->execSqlSync(
            "UPDATE transfer_receipt SET outcome = 'won' WHERE transfer_id = $1",
            transfer_id);
    }
}

void PgTransferReceiptRepo::recordLost(const std::string &transfer_id) {
    client_->execSqlSync(
        "UPDATE transfer_receipt SET outcome = 'lost' WHERE transfer_id = $1",
        transfer_id);
}

// ── Idempotent transfer wrappers ──────────────────────────────────────────────

ReceiptRecord PgTransferReceiptRepo::idempotentLeave(const std::string &transfer_id,
                                                      IItemRepo &item_repo,
                                                      const LeaveParams &params) {
    // Fast path: live final receipt already exists — replay it.
    auto existing = find(transfer_id);
    if (existing && existing->outcome != ReceiptOutcome::Pending) {
        return *existing;
    }

    // Claim slot.  On conflict (live receipt exists) return whatever is stored.
    const bool claimed = tryClaimSlot(transfer_id, "leave", params.item_id);
    if (!claimed) {
        return find(transfer_id).value_or(
            ReceiptRecord{transfer_id, "leave", params.item_id, ReceiptOutcome::Pending, {}, {}, {}});
    }

    // Execute CAS.
    const auto result = item_repo.leave(params);
    if (result.status == TransferStatus::Won) {
        recordWon(transfer_id, std::optional<int32_t>{result.new_version},
                  std::optional<int32_t>{result.new_custody_depth});
        return ReceiptRecord{transfer_id, "leave", params.item_id, ReceiptOutcome::Won,
                             result.new_version, result.new_custody_depth};
    }
    recordLost(transfer_id);
    return ReceiptRecord{transfer_id, "leave", params.item_id, ReceiptOutcome::Lost, {}, {}};
}

ReceiptRecord PgTransferReceiptRepo::idempotentTake(const std::string &transfer_id,
                                                     IItemRepo &item_repo,
                                                     const TakeParams &params) {
    auto existing = find(transfer_id);
    if (existing && existing->outcome != ReceiptOutcome::Pending) {
        return *existing;
    }

    const bool claimed = tryClaimSlot(transfer_id, "take", params.item_id);
    if (!claimed) {
        return find(transfer_id).value_or(
            ReceiptRecord{transfer_id, "take", params.item_id, ReceiptOutcome::Pending, {}, {}, {}});
    }

    const auto result = item_repo.take(params);
    if (result.status == TransferStatus::Won) {
        recordWon(transfer_id, std::optional<int32_t>{result.new_version},
                  std::optional<int32_t>{result.new_custody_depth});
        return ReceiptRecord{transfer_id, "take", params.item_id, ReceiptOutcome::Won,
                             result.new_version, result.new_custody_depth};
    }
    recordLost(transfer_id);
    return ReceiptRecord{transfer_id, "take", params.item_id, ReceiptOutcome::Lost, {}, {}};
}

ReceiptRecord PgTransferReceiptRepo::idempotentUse(const std::string &transfer_id,
                                                    IItemRepo &item_repo,
                                                    const UseParams &params) {
    auto existing = find(transfer_id);
    if (existing && existing->outcome != ReceiptOutcome::Pending) {
        return *existing;
    }

    const bool claimed = tryClaimSlot(transfer_id, "use", params.item_id);
    if (!claimed) {
        return find(transfer_id).value_or(
            ReceiptRecord{transfer_id, "use", params.item_id, ReceiptOutcome::Pending, {}, {}, {}});
    }

    const auto result = item_repo.use(params);
    if (result.status == TransferStatus::Won) {
        recordWon(transfer_id, std::optional<int32_t>{result.new_version},
                  std::optional<int32_t>{result.new_custody_depth});
        return ReceiptRecord{transfer_id, "use", params.item_id, ReceiptOutcome::Won,
                             result.new_version, result.new_custody_depth};
    }
    recordLost(transfer_id);
    return ReceiptRecord{transfer_id, "use", params.item_id, ReceiptOutcome::Lost, {}, {}};
}

ReceiptRecord PgTransferReceiptRepo::idempotentTransmute(const std::string &transfer_id,
                                                          IItemRepo &item_repo,
                                                          const TransmuteParams &params) {
    auto existing = find(transfer_id);
    if (existing && existing->outcome != ReceiptOutcome::Pending) {
        return *existing;
    }

    const bool claimed = tryClaimSlot(transfer_id, "transmute", params.item_id_a);
    if (!claimed) {
        return find(transfer_id).value_or(ReceiptRecord{transfer_id, "transmute", params.item_id_a,
                                                         ReceiptOutcome::Pending, {}, {}, {}});
    }

    const auto result = item_repo.transmute(params);
    if (result.status == TransferStatus::Won) {
        // Transmute has no version/depth in the receipt (both source items are deleted);
        // only the new item UUID is meaningful.  Pass nullopt for version/depth.
        recordWon(transfer_id, std::nullopt, std::nullopt,
                  std::optional<std::string>{result.new_item_id});
        return ReceiptRecord{transfer_id, "transmute", params.item_id_a, ReceiptOutcome::Won, {},
                             {}, result.new_item_id};
    }
    recordLost(transfer_id);
    return ReceiptRecord{transfer_id, "transmute", params.item_id_a, ReceiptOutcome::Lost, {}, {}};
}

} // namespace assembled_server
