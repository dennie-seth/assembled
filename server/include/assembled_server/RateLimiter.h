#pragma once

#include <chrono>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace assembled_server {

/// Sliding-window per-IP rate limiter (anti-brute-force, T-0094 S-5).
///
/// Tracks request timestamps per client IP in memory.  On each `allow()`
/// call old entries outside the window are pruned, then the counter for
/// that IP is checked against the configured maximum.  Thread-safe.
class RateLimiter {
  public:
    /// @param maxRequests  maximum number of requests allowed per IP per
    ///                     window before `allow()` starts returning false.
    /// @param window       sliding window duration.
    RateLimiter(size_t maxRequests, std::chrono::seconds window);

    /// Records a request attempt from @p ip and returns whether it should
    /// be allowed.
    /// @param ip  client IP address string (e.g. "127.0.0.1").
    /// @return true  if the request is within the rate limit.
    /// @return false if the request should be rejected with 429.
    bool allow(const std::string &ip);

  private:
    using Clock = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;

    size_t maxRequests_;
    std::chrono::seconds window_;
    std::mutex mu_;
    std::unordered_map<std::string, std::vector<TimePoint>> buckets_;
};

} // namespace assembled_server
