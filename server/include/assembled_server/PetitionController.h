#pragma once

/// @file assembled_server/PetitionController.h
/// @brief HTTP handler for /v1/petitions — broadcast petition creation and retrieval (T-0117).
///
/// POST /v1/petitions (T-0117):
///   Creates an anchorless broadcast note (is_broadcast = true, 02-notes-system.md §6).
///   Requires the caller to hold the unique vocabulary tier (petition_tier table).
///   Optional body field `item_type` (FK → item_type.id) records the gating item
///   being requested (N-5 / 02-notes-system.md §6); if absent a general-plea note
///   is created instead.  Rate-limited with a ceiling tighter than the general
///   per-token limit (03-net-protocol.md §7, 15-server-ops.md §7).
///
///   Error codes:
///     1001  UNKNOWN_TOKEN         — Authorization header missing or malformed.
///     4002  VOCAB_TIER_LOCKED     — Token not in petition_tier (unique tier ungated).
///     5001  RATE_LIMITED          — Per-token petition rate limit exceeded.
///
/// GET /v1/petitions (T-0117):
///   Returns active broadcast notes across the network, ordered by rating DESC.
///   Optional ?limit= parameter (default 20, clamped to kMaxNotesLimit).
///   No auth required — petitions are globally visible (03-net-protocol.md §5).

#include <chrono>
#include <cstddef>
#include <memory>

#include <drogon/HttpController.h>

namespace assembled_server {

class RateLimiter;

/// /v1/petitions — broadcast petition create (POST) and list (GET).
class PetitionController : public drogon::HttpController<PetitionController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(PetitionController::createPetition, "/v1/petitions", drogon::Post);
    ADD_METHOD_TO(PetitionController::listPetitions, "/v1/petitions", drogon::Get);
    METHOD_LIST_END

    /// POST /v1/petitions.
    ///
    /// Body (all fields optional):
    ///   { "item_type": <int> }   — gating item type ID (N-5); omit for a general plea.
    ///
    /// @param req       POST /v1/petitions with optional JSON body and
    ///                  Authorization: Bearer header.
    /// @param callback  Invoked with:
    ///                  - 201 JSON {"id":"<uuid>"} on success.
    ///                  - 400 JSON {"error":2001} if item_type is present but invalid.
    ///                  - 401 JSON {"error":1001} if Authorization is absent/malformed.
    ///                  - 403 JSON {"error":4002} if the token lacks the unique tier.
    ///                  - 429 JSON {"error":5001} if the petition rate limit is exceeded.
    ///                  - 503 if DATABASE_URL is not configured.
    void createPetition(const drogon::HttpRequestPtr &req,
                        std::function<void(const drogon::HttpResponsePtr &)> &&callback);

    /// GET /v1/petitions.
    ///
    /// Query parameters:
    ///   limit  INT  optional — max results (default 20, clamped to kMaxNotesLimit).
    ///
    /// @param req       GET /v1/petitions request.
    /// @param callback  Invoked with:
    ///                  - 200 JSON array of broadcast note objects ordered by rating DESC.
    ///                  - 503 if DATABASE_URL is not configured.
    void listPetitions(const drogon::HttpRequestPtr &req,
                       std::function<void(const drogon::HttpResponsePtr &)> &&callback);

    /// Replaces the per-token petition rate limiter with a test-configured instance.
    /// Must be called BEFORE drogon::app().run() to avoid data races.
    /// Production code should never call this.
    static void setRateLimiterForTesting(size_t maxRequests, std::chrono::seconds window);

    /// Returns a reference to the active rate limiter for white-box unit testing.
    /// Must only be called after setRateLimiterForTesting() has been called.
    static RateLimiter &rateLimiterForTesting();

  private:
    /// Returns the active rate limiter, creating the default (configurable via
    /// PETITION_RATE_LIMIT_MAX / PETITION_RATE_LIMIT_WINDOW_SEC env vars,
    /// defaulting to 2 per 3600 s) on first access.
    static RateLimiter &rateLimiter();

    static std::unique_ptr<RateLimiter> rateLimiter_;
};

} // namespace assembled_server
