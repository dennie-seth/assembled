#include "assembled_server/NoteController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <string>

#include "assembled_server/Database.h"
#include "assembled_server/NoteRepo.h"

namespace assembled_server {

namespace {
/// Default limit when the caller omits the ?limit= parameter.
constexpr int kDefaultLimit = 20;

/// Parse a required SMALLINT query parameter.
/// @returns the parsed value, or std::nullopt if missing/invalid.
std::optional<int16_t> parseSmallInt(const drogon::HttpRequestPtr &req,
                                     const std::string &name) {
    const auto &param = req->getParameter(name);
    if (param.empty())
        return std::nullopt;
    try {
        const int v = std::stoi(param);
        return static_cast<int16_t>(v);
    } catch (const std::exception &) {
        return std::nullopt;
    }
}
} // namespace

void NoteController::listNotes(const drogon::HttpRequestPtr &req,
                               std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
    // 1. Parse required parameters.
    const auto archetype_id = parseSmallInt(req, "archetype_id");
    const auto anchor_tag   = parseSmallInt(req, "anchor_tag");

    if (!archetype_id || !anchor_tag) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    // 2. Parse optional limit (default kDefaultLimit, clamped inside fetchRanked).
    int limit = kDefaultLimit;
    const auto &limitParam = req->getParameter("limit");
    if (!limitParam.empty()) {
        try {
            limit = std::stoi(limitParam);
        } catch (const std::exception &) {
            limit = kDefaultLimit;
        }
    }

    // 3. Obtain DB client (lazy init from DATABASE_URL, thread-safe).
    static std::once_flag dbFlag;
    static drogon::orm::DbClientPtr dbClient;
    std::call_once(dbFlag, []() {
        auto db = Database::fromEnv();
        if (db) {
            dbClient = db->getClient();
        }
    });

    if (!dbClient) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        callback(resp);
        return;
    }

    // 4. Query — fetchRanked clamps limit to kMaxNotesLimit internally.
    PgNoteRepo repo(dbClient);
    const auto notes = repo.fetchRanked(*archetype_id, *anchor_tag, limit);

    // 5. Build JSON array response.
    Json::Value body(Json::arrayValue);
    for (const auto &n : notes) {
        Json::Value obj;
        obj["id"]           = n.id;
        obj["archetype_id"] = n.archetype_id;
        obj["anchor_tag"]   = n.anchor_tag;
        obj["template_id"]  = n.template_id;

        if (n.slot_a.has_value())
            obj["slot_a"] = n.slot_a.value();
        else
            obj["slot_a"] = Json::Value(Json::nullValue);

        if (n.slot_b.has_value())
            obj["slot_b"] = n.slot_b.value();
        else
            obj["slot_b"] = Json::Value(Json::nullValue);

        if (n.item_ref.has_value())
            obj["item_ref"] = n.item_ref.value();
        else
            obj["item_ref"] = Json::Value(Json::nullValue);

        obj["rating"] = n.rating;
        body.append(obj);
    }

    callback(drogon::HttpResponse::newHttpJsonResponse(body));
}

} // namespace assembled_server
