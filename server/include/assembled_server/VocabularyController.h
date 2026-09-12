#pragma once

/// @file assembled_server/VocabularyController.h
/// @brief HTTP handler for /v1/vocabulary — caller's unlocked word ids (T-0364).
///
/// GET /v1/vocabulary:
///   Authenticated by the same bearer identity token as the note routes
///   (03-net-protocol.md §2). Returns exactly the word ids POST /v1/notes
///   would accept for that token: the contents of the `vocabulary` table
///   for the caller (server/migrations/005_vocabulary.sql, T-0045) — the
///   very table NoteController::createNote checks before accepting a
///   compose request. There is no fallback tier and no full-catalogue
///   default: a token with no unlocked words gets an empty array, matching
///   what POST /v1/notes would reject for every word (403 / 4002
///   VOCAB_TIER_LOCKED).
///
///   Error codes:
///     1001  UNKNOWN_TOKEN — Authorization header missing or malformed.
///
///   Response shape: 03-net-protocol.md §5 Progression — 200 [ word_id ... ].
///
///   The query runs via execSqlAsync (never execSqlSync/a worker thread) so
///   it can't stall the Drogon HTTP event loop, and the underlying DbClient
///   carries a real deadline (Drogon's DbClient::setTimeout) so a request
///   against an unreachable database still gets a bounded 503 instead of
///   hanging for the life of the outage (Codex re-review, 2026-09-11).

#include <drogon/HttpController.h>

#include <chrono>
#include <cstddef>

namespace assembled_server {

/// /v1/vocabulary — caller's unlocked word ids (GET, T-0364).
class VocabularyController : public drogon::HttpController<VocabularyController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(VocabularyController::listVocabulary, "/v1/vocabulary", drogon::Get);
    METHOD_LIST_END

    /// @param req      GET /v1/vocabulary with Authorization: Bearer header.
    /// @param callback invoked with:
    ///                 - 200 JSON array of word ids unlocked for the caller
    ///                   (empty array if none are unlocked).
    ///                 - 401 JSON {"error":1001} if Authorization is absent/malformed.
    ///                 - 503 if no DATABASE_URL is configured, the query fails, or
    ///                   the query's deadline (see setQueryTimeoutForTesting) elapses.
    void listVocabulary(const drogon::HttpRequestPtr &req,
                        std::function<void(const drogon::HttpResponsePtr &)> &&callback);

    /// Test-only hook (Codex re-review, 2026-09-11): overrides the query
    /// deadline that would otherwise come from VOCABULARY_QUERY_TIMEOUT_MS /
    /// the built-in default, so an outage test doesn't have to wait out the
    /// production timeout. Must be called before the first request in the
    /// process -- the deadline is applied to the DbClient once, the first
    /// time it's constructed.
    static void setQueryTimeoutForTesting(std::chrono::milliseconds timeout);

    /// @return the number of GET /v1/vocabulary requests whose async query
    /// is still outstanding (queued on the DB, or awaiting its deadline).
    /// Test-only: proves the per-request state is released promptly once
    /// the deadline elapses rather than retained for the life of a DB
    /// outage (Codex re-review, 2026-09-11).
    static std::size_t pendingQueryCountForTests();
};

} // namespace assembled_server
