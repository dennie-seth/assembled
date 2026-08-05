#pragma once

#include <drogon/HttpController.h>

#include <chrono>
#include <cstddef>
#include <memory>

namespace assembled_server {

class RateLimiter;

/// POST /v1/identity — mint a new identity (T-0094).
///
/// Generates a seed phrase, derives a stable token from it (HMAC-SHA256),
/// persists only the token in the `identity` table, and returns the phrase
/// to the caller exactly once.  The phrase is discarded immediately after
/// this response; the server is unable to retrieve it later (design §1).
///
/// Rate-limited per client IP (anti-brute-force, S-5).  Exceeding the limit
/// returns 429 Too Many Requests with no phrase body.
class IdentityController : public drogon::HttpController<IdentityController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(IdentityController::mintIdentity, "/v1/identity", drogon::Post);
    METHOD_LIST_END

    /// @param req       incoming POST /v1/identity request.
    /// @param callback  invoked with one of:
    ///                  - 200 JSON `{"phrase":"<8 words>"}` on success.
    ///                  - 429 if the per-IP rate limit is exceeded.
    ///                  - 503 if no database is configured (DATABASE_URL unset).
    void mintIdentity(const drogon::HttpRequestPtr &req,
                      std::function<void(const drogon::HttpResponsePtr &)> &&callback);

    /// Replaces the per-IP rate limiter with a test-configured instance.
    /// Must be called BEFORE `drogon::app().run()` to avoid data races.
    /// Production code should never call this.
    static void setRateLimiterForTesting(size_t maxRequests, std::chrono::seconds window);

  private:
    /// Returns the active rate limiter, creating the default (10 req/min)
    /// on first access.
    static RateLimiter &rateLimiter();

    static std::unique_ptr<RateLimiter> rateLimiter_;
};

} // namespace assembled_server
