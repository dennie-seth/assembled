#pragma once

/// @file assembled_server/AnchorController.h
/// @brief HTTP handler for GET /v1/anchors/{archetype}/{tag} (T-0124).
///
/// Returns a single-transaction room-entry snapshot containing:
///   - items[]     — loose item_instance rows hosted in the caller's universe.
///   - offerings[] — open offering rows at this anchor (globally visible).
///   - notes[]     — anchor-scoped notes (is_broadcast = false).
///
/// All three arrays come from one database transaction — the snapshot is
/// consistent even under concurrent POST /v1/offerings traffic.
///
/// Responses:
///   200  JSON { "items": [...], "offerings": [...], "notes": [...] }
///   400  if archetype or tag path parameters are not valid integers.
///   401  if the Authorization: Bearer header is missing or malformed.
///   503  if no DATABASE_URL is configured.

#include <drogon/HttpController.h>

#include <string>

namespace assembled_server {

/// GET /v1/anchors/{archetype}/{tag} — room-entry snapshot (T-0124).
class AnchorController : public drogon::HttpController<AnchorController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(AnchorController::getSnapshot, "/v1/anchors/{1}/{2}", drogon::Get);
    METHOD_LIST_END

    /// @param req        GET /v1/anchors/{arch}/{tag} with Authorization: Bearer header.
    /// @param callback   invoked with:
    ///                   - 200 JSON snapshot on success.
    ///                   - 400 if path params are not valid integers.
    ///                   - 401 if the bearer token is missing or malformed.
    ///                   - 503 if no DATABASE_URL is configured.
    /// @param archetype  archetype_id path segment (e.g. "2").
    /// @param tag        anchor_tag path segment (e.g. "1").
    void getSnapshot(const drogon::HttpRequestPtr &req,
                     std::function<void(const drogon::HttpResponsePtr &)> &&callback,
                     const std::string &archetype, const std::string &tag);
};

} // namespace assembled_server
