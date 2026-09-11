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

#include <drogon/HttpController.h>

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
    ///                 - 503 if no DATABASE_URL is configured.
    void listVocabulary(const drogon::HttpRequestPtr &req,
                        std::function<void(const drogon::HttpResponsePtr &)> &&callback);
};

} // namespace assembled_server
