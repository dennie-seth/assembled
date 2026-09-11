#include "assembled_server/VocabularyController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <mutex>
#include <string>

#include "assembled_server/Database.h"

namespace assembled_server {

namespace {

/// Build a JSON error response body per the protocol (03-net-protocol.md §3).
/// HTTP status carries the class; the body carries the specific error code.
drogon::HttpResponsePtr makeError(drogon::HttpStatusCode status, int code) {
    Json::Value j;
    j["error"] = code;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(j);
    resp->setStatusCode(status);
    return resp;
}

} // namespace

void VocabularyController::listVocabulary(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
    // ── 1. Extract bearer token (same rule as NoteController) ─────────────
    const std::string auth = req->getHeader("Authorization");
    if (auth.size() < 8 || auth.compare(0, 7, "Bearer ") != 0) {
        callback(makeError(drogon::k401Unauthorized, 1001)); // UNKNOWN_TOKEN
        return;
    }
    const std::string token = auth.substr(7);

    // ── 2. DB client (lazy init, shared across requests) ───────────────────
    static std::once_flag dbFlag;
    static drogon::orm::DbClientPtr dbClient;
    std::call_once(dbFlag, []() {
        auto db = Database::fromEnv();
        if (db)
            dbClient = db->getClient();
    });

    if (!dbClient) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        callback(resp);
        return;
    }

    // ── 3. Query the caller's unlocked words ───────────────────────────────
    // This is exactly the table NoteController::createNote checks before
    // accepting a slot word — no fallback tier, no full-catalogue default.
    const auto rows = dbClient->execSqlSync(
        "SELECT word_id FROM vocabulary WHERE token = $1 ORDER BY word_id", token);

    Json::Value body(Json::arrayValue);
    for (const auto &row : rows) {
        body.append(row["word_id"].as<int>());
    }

    callback(drogon::HttpResponse::newHttpJsonResponse(body));
}

} // namespace assembled_server
