#pragma once

#include <drogon/orm/DbClient.h>

#include <chrono>
#include <string>

namespace assembled_server {

/// Result of a successful session lease acquisition.
struct LeaseResult {
    std::string lease_id;                             ///< opaque UUID v4 handle
    std::chrono::system_clock::time_point expires_at; ///< wall-clock expiry
};

/// Repository for session_lease rows — implements INV-11 (one live session per
/// identity) via a lease model instead of a boolean flag.
///
/// A crashed client is not permanently locked out: it simply waits out the TTL
/// and calls acquire() again.  A new acquire() always evicts the existing lease
/// for that identity — the evicted client's next heartbeat() call returns false,
/// which is its signal that its universe continued elsewhere.
///
/// All methods are synchronous and may throw drogon::orm::DrogonDbException on
/// DB error.
class SessionLeaseRepo {
  public:
    /// @param client  active Postgres client (owned by the caller).
    explicit SessionLeaseRepo(drogon::orm::DbClientPtr client);

    /// Acquires a new lease for @p token, atomically evicting any existing live
    /// lease for the same identity.  Always succeeds if @p token exists in the
    /// `identity` table.
    ///
    /// @param token  identity token (must exist in `identity`).
    /// @param ttl    how long until the new lease expires.
    /// @return       {lease_id, expires_at} for the freshly issued lease.
    LeaseResult acquire(const std::string &token, std::chrono::seconds ttl);

    /// Extends the lease TTL by @p ttl from now, but only when @p lease_id
    /// still matches the live lease *and* that lease has not yet expired.
    ///
    /// @param token     identity token.
    /// @param lease_id  the lease handle this client holds.
    /// @param ttl       new TTL measured from now.
    /// @return true if the heartbeat was accepted; false if the lease was
    ///         evicted by a takeover or has already expired.
    bool heartbeat(const std::string &token, const std::string &lease_id,
                   std::chrono::seconds ttl);

    /// @return true if @p lease_id is still the live lease for @p token and
    ///         has not expired; false otherwise.
    bool isAlive(const std::string &token, const std::string &lease_id);

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
