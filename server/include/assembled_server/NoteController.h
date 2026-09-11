#pragma once

/// @file assembled_server/NoteController.h
/// @brief HTTP handler for /v1/notes — note composition and retrieval.
///
/// POST /v1/notes (T-0045): compose a note at an anchor.
///   Validates the request body against the in-memory template catalogue
///   (shared/note_templates.hpp) before touching the database:
///     - Unknown template_id               → 400 / error 2001 BAD_TEMPLATE
///     - Slot count != template.slots      → 400 / error 2002 SLOT_ARITY_MISMATCH
///     - Slot word wrong category          → 400 / error 2003 SLOT_CATEGORY_MISMATCH
///   Then checks the caller's vocabulary in Postgres:
///     - Any slot word absent from vocabulary → 403 / error 4002 VOCAB_TIER_LOCKED
///   On success inserts the note and returns 201 { "id": "<uuid>" }.
///
/// GET /v1/notes (T-0046): query notes by tag equality, ordered by score DESC.
///   Query parameters (all matched by exact equality — no radius, no geometry):
///     archetype_id  SMALLINT  required  — world archetype filter
///     anchor_tag    SMALLINT  required  — anchor within archetype
///     limit         INT       optional  — max results (default 20, clamped to
///                                        kMaxNotesLimit server-side)
///   Response:
///     200  JSON array of note objects ordered by rating (score) DESC.
///     400  if archetype_id or anchor_tag is missing or unparseable.
///     503  if no DATABASE_URL is configured.
///
/// Rate limiting (T-0049, 03-net-protocol.md §7): createNote and rateNote are
/// each rate-limited per identity token, with independently configurable
/// ceilings per route group (note creation vs. rating). Exceeding a ceiling
/// returns 429 / error 5001 RATE_LIMITED. Configurable via
/// NOTE_CREATE_RATE_LIMIT_MAX / NOTE_CREATE_RATE_LIMIT_WINDOW_SEC and
/// NOTE_RATING_RATE_LIMIT_MAX / NOTE_RATING_RATE_LIMIT_WINDOW_SEC. Petitions
/// have their own, much tighter, per-token limiter (PetitionController).

#include <chrono>
#include <cstddef>
#include <memory>

#include <drogon/HttpController.h>

namespace assembled_server {

class RateLimiter;

/// /v1/notes — note composition (POST, T-0045), retrieval (GET, T-0046),
/// and rating (POST /v1/notes/{id}/rate, T-0047).
class NoteController : public drogon::HttpController<NoteController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(NoteController::createNote, "/v1/notes", drogon::Post);
    ADD_METHOD_TO(NoteController::listNotes, "/v1/notes", drogon::Get);
    ADD_METHOD_TO(NoteController::rateNote, "/v1/notes/{1}/rate", drogon::Post);
    METHOD_LIST_END

    /// @param req      POST /v1/notes with JSON body and Authorization: Bearer header.
    /// @param callback invoked with:
    ///                 - 400 JSON {"error":2001} if template_id is unknown.
    ///                 - 400 JSON {"error":2002} if slot count doesn't match template.
    ///                 - 400 JSON {"error":2003} if a slot word's category is wrong.
    ///                 - 401 if the Authorization: Bearer header is missing or malformed.
    ///                 - 403 JSON {"error":4002} if any slot word is above the caller's tier.
    ///                 - 429 JSON {"error":5001} if the per-token note-creation rate
    ///                   limit is exceeded (T-0049).
    ///                 - 201 JSON {"id":"<uuid>"} on success.
    ///                 - 503 if no database is configured (DATABASE_URL unset).
    void createNote(const drogon::HttpRequestPtr &req,
                    std::function<void(const drogon::HttpResponsePtr &)> &&callback);

    /// @param req       Incoming GET /v1/notes request.
    /// @param callback  Invoked with one of:
    ///                  - 200 JSON array of notes ordered by rating DESC.
    ///                  - 400 if a required query parameter is absent/invalid.
    ///                  - 503 if no DATABASE_URL is configured.
    void listNotes(const drogon::HttpRequestPtr &req,
                   std::function<void(const drogon::HttpResponsePtr &)> &&callback);

    /// POST /v1/notes/{id}/rate (T-0047).
    ///
    /// Body: { "val": 1 } or { "val": -1 }.
    /// One vote per (note_id, voter): same val is idempotent, different val
    /// overwrites.  notes.rating is updated to SUM(val) over note_votes.
    ///
    /// @param req      POST with JSON body and Authorization: Bearer header.
    /// @param callback invoked with:
    ///                 - 200 on success or idempotent no-op.
    ///                 - 400 JSON {"error":2005} if val is not +1 or -1.
    ///                 - 401 JSON {"error":1001} if Authorization is absent/malformed.
    ///                 - 403 JSON {"error":4001} if the caller hasn't proven play of
    ///                   the note's archetype (T-0207 proof-of-play).
    ///                 - 429 JSON {"error":5001} if the per-token rating rate limit
    ///                   is exceeded (T-0049).
    ///                 - 503 if no DATABASE_URL is configured.
    /// @param id       Note UUID from the path segment.
    void rateNote(const drogon::HttpRequestPtr &req,
                  std::function<void(const drogon::HttpResponsePtr &)> &&callback,
                  const std::string &id);

    /// Replaces the per-token note-creation rate limiter with a test-configured
    /// instance. Thread-safe (internally mutex-guarded, T-0049 fix round) --
    /// safe to call at any time, though tests should still avoid calling it
    /// concurrently with in-flight requests they expect it to govern.
    /// Production code should never call this.
    static void setNoteRateLimiterForTesting(size_t maxRequests, std::chrono::seconds window);

    /// Replaces the per-token note-rating rate limiter with a test-configured
    /// instance. Thread-safe (internally mutex-guarded, T-0049 fix round) --
    /// safe to call at any time, though tests should still avoid calling it
    /// concurrently with in-flight requests they expect it to govern.
    /// Production code should never call this.
    static void setRatingRateLimiterForTesting(size_t maxRequests, std::chrono::seconds window);

    /// Resets the per-token note-creation rate limiter to its genuinely
    /// uninitialized (nullptr) state, WITHOUT constructing a replacement --
    /// unlike setNoteRateLimiterForTesting(). Exists so tests can exercise
    /// the lazy first-access construction path itself (e.g. concurrent
    /// first-request races). Production code should never call this.
    static void resetNoteRateLimiterForTesting();

    /// Resets the per-token note-rating rate limiter to its genuinely
    /// uninitialized (nullptr) state, WITHOUT constructing a replacement --
    /// unlike setRatingRateLimiterForTesting(). Exists so tests can exercise
    /// the lazy first-access construction path itself (e.g. concurrent
    /// first-request races). Production code should never call this.
    static void resetRatingRateLimiterForTesting();

    /// Returns a reference to the active note-creation rate limiter for
    /// white-box unit testing. Must only be called after
    /// setNoteRateLimiterForTesting() has been called.
    static RateLimiter &noteRateLimiterForTesting();

    /// Returns a reference to the active note-rating rate limiter for
    /// white-box unit testing. Must only be called after
    /// setRatingRateLimiterForTesting() has been called.
    static RateLimiter &ratingRateLimiterForTesting();

  private:
    /// Returns the active note-creation rate limiter, creating the default
    /// (configurable via NOTE_CREATE_RATE_LIMIT_MAX /
    /// NOTE_CREATE_RATE_LIMIT_WINDOW_SEC, defaulting to 20 per 60 s) on first
    /// access. Thread-safe: first-use construction is guarded by an internal
    /// mutex (T-0049 fix round), so concurrent first requests from separate
    /// HTTP worker threads cannot race on the underlying pointer.
    static RateLimiter &noteRateLimiter();

    /// Returns the active note-rating rate limiter, creating the default
    /// (configurable via NOTE_RATING_RATE_LIMIT_MAX /
    /// NOTE_RATING_RATE_LIMIT_WINDOW_SEC, defaulting to 60 per 60 s) on first
    /// access. Thread-safe: first-use construction is guarded by an internal
    /// mutex (T-0049 fix round), so concurrent first requests from separate
    /// HTTP worker threads cannot race on the underlying pointer.
    static RateLimiter &ratingRateLimiter();

    static std::unique_ptr<RateLimiter> noteRateLimiter_;
    static std::unique_ptr<RateLimiter> ratingRateLimiter_;
};

} // namespace assembled_server
