#pragma once

/// @file assembled_server/UnlockRepo.h
/// @brief Unlock persistence: tier-appropriate expiry and expired-row-as-absent
///        read invariant (T-0127).
///
/// Unlocks are per-(token, variant_id, tag) rows in the `unlock` table, written
/// as a side effect of a successful use() transfer (ItemRepo::use + UseUnlockData).
/// Their `expires_at` is determined by the caller using UnlockConfig::ttl_for_tier()
/// to map a UnlockTier to a configurable duration — never a hardcoded constant.
///
/// Every read path goes through PgUnlockRepo::isValid(), which filters
/// `expires_at > now()`.  An expired row is indistinguishable from no row —
/// there is no "expired but present" observable state.
///
/// Reference: docs/design/10-time-and-progression.md §3.

#include <drogon/orm/DbClient.h>

#include <chrono>
#include <cstdint>
#include <string>

namespace assembled_server {

/// Decay tier for an unlock row (10-time-and-progression.md §3).
enum class UnlockTier {
    Tactical,    ///< Minutes — a shortcut used now; not progression at all.
    Session,     ///< Hours–days — cross-session convenience.
    UniqueKeyed, ///< ~1 week — the only tier that meaningfully accumulates.
};

/// Configurable TTL durations, one per tier.
///
/// Defaults match the tier descriptions in 10-time-and-progression.md §3.
/// Exact values are open tuning (T-1/T-2 from docs/HANDOFF.md §6); callers
/// should inject a UnlockConfig rather than relying on defaults in production.
struct UnlockConfig {
    std::chrono::seconds tactical_ttl{300};        ///< Default: 5 minutes.
    std::chrono::seconds session_ttl{86400};       ///< Default: 24 hours.
    std::chrono::seconds unique_keyed_ttl{604800}; ///< Default: 7 days.

    /// @return The TTL for @p tier according to this config.
    std::chrono::seconds ttl_for_tier(UnlockTier tier) const;
};

/// Abstract read interface for unlock rows.
class IUnlockRepo {
  public:
    virtual ~IUnlockRepo() = default;

    /// @return true iff an unlock row for (@p token, @p variant_id, @p tag)
    ///         exists and has not yet expired (expires_at > now()).
    ///         An expired row is treated as absent — no "expired but present"
    ///         state is exposed to callers.
    virtual bool isValid(const std::string &token, int16_t variant_id, int16_t tag) = 0;
};

/// Postgres implementation of IUnlockRepo backed by a synchronous Drogon DbClient.
class PgUnlockRepo : public IUnlockRepo {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgUnlockRepo(drogon::orm::DbClientPtr client);

    bool isValid(const std::string &token, int16_t variant_id, int16_t tag) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
