#pragma once

#include <chrono>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace assembled_server {

/// Sliding-window rate limiter keyed by an arbitrary string (anti-brute-force,
/// T-0094 S-5; per-identity-token route-group limiting, T-0049
/// 03-net-protocol.md §7).
///
/// Tracks request timestamps per key in memory.  On each `allow()` call old
/// entries outside the window are pruned, then the counter for that key is
/// checked against the configured maximum.  Thread-safe.  Callers key by
/// client IP (identity minting) or by derived identity token (notes,
/// ratings, petitions) depending on what the route group is meant to bound.
class RateLimiter {
  public:
    /// @param maxRequests  maximum number of requests allowed per key per
    ///                     window before `allow()` starts returning false.
    /// @param window       sliding window duration.
    RateLimiter(size_t maxRequests, std::chrono::seconds window);

    /// Records a request attempt from @p key and returns whether it should
    /// be allowed.
    /// @param key  client IP address or identity token, depending on caller.
    /// @return true  if the request is within the rate limit.
    /// @return false if the request should be rejected with 429.
    bool allow(const std::string &key);

  private:
    using Clock = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;

    size_t maxRequests_;
    std::chrono::seconds window_;
    std::mutex mu_;
    std::unordered_map<std::string, std::vector<TimePoint>> buckets_;
};

} // namespace assembled_server
