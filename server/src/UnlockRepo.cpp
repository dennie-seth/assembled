/// T-0127: PgUnlockRepo — tier-appropriate expiry and expired-row-as-absent
/// read invariant.
///
/// isValid() executes a single SQL SELECT that filters on expires_at > now(),
/// so an expired row is never returned to callers — it is indistinguishable
/// from an absent row.  The physical sweep of stale rows is a separate,
/// future maintenance job; this read path does not depend on it.
///
/// UnlockConfig::ttl_for_tier() maps UnlockTier → std::chrono::seconds.
/// Callers convert the result to an integer second count and pass it as
/// UseUnlockData::ttl_seconds into ItemRepo::use(), which writes:
///   expires_at = now() + ($n::int * INTERVAL '1 second')
/// Exact tier durations are tuning parameters (T-1/T-2, docs/HANDOFF.md §6).

#include "assembled_server/UnlockRepo.h"

namespace assembled_server {

// ── UnlockConfig ──────────────────────────────────────────────────────────────

std::chrono::seconds UnlockConfig::ttl_for_tier(UnlockTier tier) const {
    switch (tier) {
    case UnlockTier::Tactical:
        return tactical_ttl;
    case UnlockTier::Session:
        return session_ttl;
    case UnlockTier::UniqueKeyed:
        return unique_keyed_ttl;
    }
    // All enum values are covered; unreachable, but satisfies -Wreturn-type.
    return unique_keyed_ttl;
}

// ── PgUnlockRepo ──────────────────────────────────────────────────────────────

PgUnlockRepo::PgUnlockRepo(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

bool PgUnlockRepo::isValid(const std::string &token, int16_t variant_id, int16_t tag) {
    // Filter expires_at > now() so an expired row is treated as absent.
    // LIMIT 1 is safe: the PK (token, variant_id, tag) guarantees at most one row.
    auto result = client_->execSqlSync("SELECT 1 FROM unlock "
                                       "WHERE token = $1 AND variant_id = $2 AND tag = $3 "
                                       "  AND expires_at > now() "
                                       "LIMIT 1",
                                       token, variant_id, tag);
    return !result.empty();
}

} // namespace assembled_server
