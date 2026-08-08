#pragma once

/// @file assembled_server/NoteController.h
/// @brief HTTP handler for POST /v1/notes — note composition (T-0045).
///
/// Validates the request body against the in-memory template catalogue
/// (shared/note_templates.hpp) before touching the database:
///   - Unknown template_id               → 400 / error 2001 BAD_TEMPLATE
///   - Slot count != template.slots      → 400 / error 2002 SLOT_ARITY_MISMATCH
///   - Slot word wrong category          → 400 / error 2003 SLOT_CATEGORY_MISMATCH
///
/// Then checks the caller's vocabulary in Postgres:
///   - Any slot word absent from vocabulary → 403 / error 4002 VOCAB_TIER_LOCKED
///
/// On success inserts the note and returns 201 { "id": "<uuid>" }.

#include <drogon/HttpController.h>

namespace assembled_server {

/// POST /v1/notes — compose a note at an anchor (T-0045).
class NoteController : public drogon::HttpController<NoteController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(NoteController::createNote, "/v1/notes", drogon::Post);
    METHOD_LIST_END

    /// @param req      POST /v1/notes with JSON body and Authorization: Bearer header.
    /// @param callback invoked with:
    ///                 - 400 JSON {"error":2001} if template_id is unknown.
    ///                 - 400 JSON {"error":2002} if slot count doesn't match template.
    ///                 - 400 JSON {"error":2003} if a slot word's category is wrong.
    ///                 - 401 if the Authorization: Bearer header is missing or malformed.
    ///                 - 403 JSON {"error":4002} if any slot word is above the caller's tier.
    ///                 - 201 JSON {"id":"<uuid>"} on success.
    ///                 - 503 if no database is configured (DATABASE_URL unset).
    void createNote(const drogon::HttpRequestPtr &req,
                    std::function<void(const drogon::HttpResponsePtr &)> &&callback);
};

} // namespace assembled_server
