#include "assembled_server/RateLimiter.h"

#include <algorithm>

namespace assembled_server {

RateLimiter::RateLimiter(size_t maxRequests, std::chrono::seconds window)
    : maxRequests_(maxRequests), window_(window) {}

bool RateLimiter::allow(const std::string &ip) {
    const auto now = Clock::now();
    const auto cutoff = now - window_;

    std::lock_guard<std::mutex> lock(mu_);

    auto &timestamps = buckets_[ip];

    // Prune timestamps outside the sliding window.
    timestamps.erase(std::remove_if(timestamps.begin(), timestamps.end(),
                                    [&cutoff](const TimePoint &tp) { return tp < cutoff; }),
                     timestamps.end());

    if (timestamps.size() >= maxRequests_) {
        return false;
    }
    timestamps.push_back(now);
    return true;
}

} // namespace assembled_server
