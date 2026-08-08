#pragma once

/// @file assembled_server/NoteController.h
/// @brief GET /v1/notes — tag-equality note query ordered by score DESC (T-0046).
///
/// Query parameters (all matched by exact equality — no radius, no geometry):
///   archetype_id  SMALLINT  required  — world archetype filter
///   anchor_tag    SMALLINT  required  — anchor within archetype
///   limit         INT       optional  — max results (default 20, clamped to
///                                       kMaxNotesLimit server-side)
///
/// Response:
///   200  JSON array of note objects ordered by rating (score) DESC.
///   400  if archetype_id or anchor_tag is missing or unparseable.
///   503  if no DATABASE_URL is configured.

#include <drogon/HttpController.h>

namespace assembled_server {

/// GET /v1/notes?archetype_id=&anchor_tag=&limit=
class NoteController : public drogon::HttpController<NoteController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(NoteController::listNotes, "/v1/notes", drogon::Get);
    METHOD_LIST_END

    /// @param req       Incoming GET /v1/notes request.
    /// @param callback  Invoked with one of:
    ///                  - 200 JSON array of notes ordered by rating DESC.
    ///                  - 400 if a required query parameter is absent/invalid.
    ///                  - 503 if no DATABASE_URL is configured.
    void listNotes(const drogon::HttpRequestPtr &req,
                   std::function<void(const drogon::HttpResponsePtr &)> &&callback);
};

} // namespace assembled_server
