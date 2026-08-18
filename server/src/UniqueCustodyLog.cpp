/// T-0118: PgUniqueCustodyLog — append-only custody log for unique items.
///
/// Every public method issues only INSERT or SELECT statements against
/// `unique_custody_log`.  No UPDATE or DELETE ever touches the table from
/// this class — that is the append-only guarantee from 15-server-ops.md §9.2.
///
/// seq assignment: a single INSERT ... SELECT MAX(seq)+1 statement is atomic
/// within one SQL statement and sufficient because UniqueAuthority is a global
/// singleton; concurrent writers for the same unique_id do not occur in
/// practice.  If they ever did, the PRIMARY KEY (unique_id, seq) would reject
/// the collision rather than silently clobbering data.

#include "assembled_server/UniqueCustodyLog.h"

#include <stdexcept>

namespace assembled_server {

// ── Helpers ───────────────────────────────────────────────────────────────────

namespace {

/// Parse a SMALLINT event column value into a CustodyEvent.
CustodyEvent toCustodyEvent(int16_t v) {
    if (v >= 0 && v <= 6) {
        return static_cast<CustodyEvent>(v);
    }
    throw std::out_of_range("unique_custody_log.event out of range: " + std::to_string(v));
}

} // namespace

// ── PgUniqueCustodyLog ────────────────────────────────────────────────────────

PgUniqueCustodyLog::PgUniqueCustodyLog(drogon::orm::DbClientPtr client)
    : client_(std::move(client)) {}

/// Build a CustodyEntry from a result row.
CustodyEntry PgUniqueCustodyLog::rowToEntry(const drogon::orm::Row &row) {
    CustodyEntry e;
    e.unique_id = row["unique_id"].as<std::string>();
    e.seq = row["seq"].as<int64_t>();

    if (!row["holder"].isNull()) {
        e.holder = row["holder"].as<std::string>();
    }
    if (!row["hosted_by"].isNull()) {
        e.hosted_by = row["hosted_by"].as<std::string>();
    }
    if (!row["shard_id"].isNull()) {
        e.shard_id = row["shard_id"].as<int16_t>();
    }
    if (!row["lease_expires"].isNull()) {
        e.lease_expires = row["lease_expires"].as<std::string>();
    }
    e.event = toCustodyEvent(row["event"].as<int16_t>());
    e.at = row["at"].as<std::string>();
    return e;
}

int64_t PgUniqueCustodyLog::append(const AppendParams &params) {
    // Assign seq = MAX(seq)+1 inside the INSERT SELECT so the assignment and
    // row insertion are a single atomic statement.  COALESCE handles the first
    // row (no prior rows -> MAX is NULL -> seq = 1).
    //
    // Optional columns are mapped via NULLIF: an empty sentinel string becomes
    // NULL after NULLIF; a non-empty string is cast to the target type.  This
    // lets us use a single SQL shape regardless of which optional fields are set.
    const int16_t event_val = static_cast<int16_t>(params.event);

    const std::string holder_arg = params.holder.value_or("");
    const std::string hosted_by_arg = params.hosted_by.value_or("");
    const std::string shard_id_arg =
        params.shard_id.has_value() ? std::to_string(*params.shard_id) : "";
    const std::string lease_arg = params.lease_expires.value_or("");

    auto result = client_->execSqlSync(
        "INSERT INTO unique_custody_log "
        "    (unique_id, seq, holder, hosted_by, shard_id, lease_expires, event) "
        "SELECT $1, "
        "       COALESCE((SELECT MAX(seq) FROM unique_custody_log WHERE unique_id = $1), 0) + 1, "
        "       NULLIF($2, ''), "              // holder: '' -> NULL
        "       NULLIF($3, ''), "              // hosted_by: '' -> NULL
        "       NULLIF($4, '')::SMALLINT, "    // shard_id: '' -> NULL
        "       NULLIF($5, '')::TIMESTAMPTZ, " // lease_expires: '' -> NULL
        "       $6::SMALLINT "
        "RETURNING seq",
        params.unique_id, holder_arg, hosted_by_arg, shard_id_arg, lease_arg, event_val);

    return result[0]["seq"].as<int64_t>();
}

std::optional<CustodyEntry> PgUniqueCustodyLog::currentCustody(const std::string &unique_id) {
    auto r = client_->execSqlSync(
        "SELECT unique_id, seq, holder, hosted_by, shard_id, lease_expires, event, "
        "       at::TEXT AS at "
        "FROM unique_custody_log "
        "WHERE unique_id = $1 "
        "ORDER BY seq DESC "
        "LIMIT 1",
        unique_id);

    if (r.empty()) {
        return std::nullopt;
    }
    return rowToEntry(r[0]);
}

std::optional<CustodyEntry> PgUniqueCustodyLog::custodyAt(const std::string &unique_id,
                                                          const std::string &point_in_time) {
    auto r = client_->execSqlSync(
        "SELECT unique_id, seq, holder, hosted_by, shard_id, lease_expires, event, "
        "       at::TEXT AS at "
        "FROM unique_custody_log "
        "WHERE unique_id = $1 "
        "  AND at <= $2::TIMESTAMPTZ "
        "ORDER BY seq DESC "
        "LIMIT 1",
        unique_id, point_in_time);

    if (r.empty()) {
        return std::nullopt;
    }
    return rowToEntry(r[0]);
}

int64_t PgUniqueCustodyLog::custodyDepth(const std::string &unique_id) {
    auto r = client_->execSqlSync(
        "SELECT COUNT(*) AS depth FROM unique_custody_log WHERE unique_id = $1", unique_id);
    return r[0]["depth"].as<int64_t>();
}

int64_t PgUniqueCustodyLog::duplicateTakeCount(const std::string &unique_id) {
    // Build a subsequence containing only Take(2), Bleed(4), and Release(5)
    // events — the events that represent a custody handoff.  Two consecutive
    // Take events in this filtered view means the item was taken twice without
    // being handed back via Bleed or Release, which is an INV-2 violation
    // (15-server-ops.md §9.2: "two take events with no intervening release
    // makes an INV-2 violation visible instead of inferred").
    auto r = client_->execSqlSync(
        "WITH custody_handoffs AS ( "
        "    SELECT seq, event "
        "    FROM   unique_custody_log "
        "    WHERE  unique_id = $1 "
        "      AND  event IN (2, 4, 5) " // Take, Bleed, Release
        "), "
        "pairs AS ( "
        "    SELECT event, "
        "           LEAD(event) OVER (ORDER BY seq) AS next_event "
        "    FROM   custody_handoffs "
        ") "
        "SELECT COUNT(*) AS violations "
        "FROM   pairs "
        "WHERE  event = 2 AND next_event = 2", // Take immediately followed by Take
        unique_id);

    return r[0]["violations"].as<int64_t>();
}

} // namespace assembled_server
