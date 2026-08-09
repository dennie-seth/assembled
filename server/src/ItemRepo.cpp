/// T-0095: PgItemRepo — custody transfer as CAS on version (INV-2).
///
/// Every public method executes a single SQL statement that atomically reads
/// and writes the affected row.  The version column is the CAS guard (INV-2);
/// an UPDATE that matches no row means another actor changed version first, so
/// TransferStatus::Lost is returned — not an exception.
///
/// INV-1 (single custody) is structurally enforced by the DB CHECK constraint:
///   CHECK (num_nonnulls(holder, hosted_by) = 1)
/// so any bug that would produce a zero-holder or dual-holder row is rejected
/// by Postgres before it can commit.
///
/// INV-5 (custody_depth monotonic) is satisfied by `custody_depth + 1` in the
/// UPDATE, which is atomic and cannot decrease.

#include "assembled_server/ItemRepo.h"

#include <drogon/orm/Exception.h>

#include <stdexcept>

namespace assembled_server {

PgItemRepo::PgItemRepo(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

std::optional<ItemRecord> PgItemRepo::find(const std::string &item_id) {
    auto result = client_->execSqlSync(
        "SELECT id, type_id, holder, hosted_by, anchor_arch, anchor_tag, "
        "       custody_depth, version "
        "FROM item_instance WHERE id = $1",
        item_id);

    if (result.empty()) {
        return std::nullopt;
    }

    const auto &row = result[0];
    ItemRecord rec;
    rec.id = row["id"].as<std::string>();
    rec.type_id = row["type_id"].as<int16_t>();

    if (!row["holder"].isNull()) {
        rec.holder = row["holder"].as<std::string>();
    }
    if (!row["hosted_by"].isNull()) {
        rec.hosted_by = row["hosted_by"].as<std::string>();
    }
    if (!row["anchor_arch"].isNull()) {
        rec.anchor_arch = row["anchor_arch"].as<int16_t>();
    }
    if (!row["anchor_tag"].isNull()) {
        rec.anchor_tag = row["anchor_tag"].as<int16_t>();
    }
    rec.custody_depth = row["custody_depth"].as<int32_t>();
    rec.version = row["version"].as<int32_t>();

    return rec;
}

int32_t PgItemRepo::countByType(int16_t type_id) {
    auto result = client_->execSqlSync(
        "SELECT COUNT(*)::int AS c FROM item_instance WHERE type_id = $1", type_id);
    return result[0]["c"].as<int32_t>();
}

TransferResult PgItemRepo::leave(const LeaveParams &params) {
    // Atomic CAS: clear holder, set hosted_by + anchor, bump version + depth.
    // Matches only when version == expected_version AND holder == holder_token.
    auto result = client_->execSqlSync(
        "UPDATE item_instance "
        "SET holder        = NULL, "
        "    hosted_by     = $1, "
        "    anchor_arch   = $2, "
        "    anchor_tag    = $3, "
        "    version       = version + 1, "
        "    custody_depth = custody_depth + 1 "
        "WHERE id      = $4 "
        "  AND version = $5 "
        "  AND holder  = $6 "
        "RETURNING version, custody_depth",
        params.hosted_by_token, params.anchor_arch, params.anchor_tag, params.item_id,
        params.expected_version, params.holder_token);

    if (result.empty()) {
        // CAS miss: version mismatch or holder mismatch.
        return TransferResult{TransferStatus::Lost, 0, 0};
    }

    return TransferResult{TransferStatus::Won, result[0]["version"].as<int32_t>(),
                          result[0]["custody_depth"].as<int32_t>()};
}

TransferResult PgItemRepo::take(const TakeParams &params) {
    // Atomic CAS: set holder, clear hosted_by + anchor, bump version + depth.
    // Matches only when version == expected_version AND holder IS NULL
    // (item is actually at an anchor, not already taken by someone else).
    auto result = client_->execSqlSync(
        "UPDATE item_instance "
        "SET holder        = $1, "
        "    hosted_by     = NULL, "
        "    anchor_arch   = NULL, "
        "    anchor_tag    = NULL, "
        "    version       = version + 1, "
        "    custody_depth = custody_depth + 1 "
        "WHERE id      = $2 "
        "  AND version = $3 "
        "  AND holder IS NULL "
        "RETURNING version, custody_depth",
        params.taker_token, params.item_id, params.expected_version);

    if (result.empty()) {
        // CAS miss: version mismatch or item already held.
        return TransferResult{TransferStatus::Lost, 0, 0};
    }

    return TransferResult{TransferStatus::Won, result[0]["version"].as<int32_t>(),
                          result[0]["custody_depth"].as<int32_t>()};
}

} // namespace assembled_server
