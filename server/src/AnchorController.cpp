/// T-0124: AnchorController — GET /v1/anchors/{archetype}/{tag}.
///
/// Returns a single-transaction room-entry snapshot (03-net-protocol.md §5):
///   { "items": [...], "offerings": [...], "notes": [...] }
///
/// The bearer token identifies the caller's universe; items[] is filtered to
/// those hosted in that universe.  Offerings and notes are global/anchor-scoped.

#include "assembled_server/AnchorController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

#include "assembled_server/AnchorRepo.h"
#include "assembled_server/Database.h"

namespace assembled_server {

namespace {

/// Build a JSON error response body per the protocol (03-net-protocol.md §3).
static drogon::HttpResponsePtr makeError(drogon::HttpStatusCode status, int code) {
    Json::Value j;
    j["error"] = code;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(j);
    resp->setStatusCode(status);
    return resp;
}

} // namespace

void AnchorController::getSnapshot(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback,
    const std::string &archetype, const std::string &tag) {
    auto cb = std::move(callback);

    // ── 1. Parse path parameters ──────────────────────────────────────────────
    int16_t archetype_id{};
    int16_t anchor_tag{};
    try {
        const int a = std::stoi(archetype);
        const int t = std::stoi(tag);
        archetype_id = static_cast<int16_t>(a);
        anchor_tag = static_cast<int16_t>(t);
    } catch (const std::exception &) {
        cb(makeError(drogon::k400BadRequest, 2004)); // UNKNOWN_ANCHOR
        return;
    }

    // ── 2. Extract bearer token ───────────────────────────────────────────────
    const std::string auth = req->getHeader("Authorization");
    if (auth.size() < 8 || auth.compare(0, 7, "Bearer ") != 0) {
        cb(makeError(drogon::k401Unauthorized, 1001)); // UNKNOWN_TOKEN
        return;
    }
    const std::string caller_token = auth.substr(7);

    // ── 3. Obtain DB client (lazy init, shared across requests) ──────────────
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
        cb(resp);
        return;
    }

    // ── 4. Execute snapshot in a worker thread ────────────────────────────────
    // PgAnchorRepo::snapshot is blocking (synchronous Drogon DB calls);
    // running it on the Drogon IO loop thread would stall other in-flight
    // requests.  A detached worker holds no Drogon resources and is safe.
    std::thread(
        [archetype_id, anchor_tag, caller_token,
         cb](drogon::orm::DbClientPtr client) mutable {
            try {
                PgAnchorRepo repo(client);
                const auto snap = repo.snapshot(caller_token, archetype_id, anchor_tag);

                // ── Build response JSON ───────────────────────────────────────
                Json::Value body(Json::objectValue);

                // items[]
                Json::Value items(Json::arrayValue);
                for (const auto &it : snap.items) {
                    Json::Value obj;
                    obj["id"] = it.id;
                    obj["type_id"] = it.type_id;
                    obj["custody_depth"] = it.custody_depth;
                    obj["version"] = it.version;
                    obj["bleed_at"] = it.bleed_at;
                    items.append(obj);
                }
                body["items"] = std::move(items);

                // offerings[]
                Json::Value offerings(Json::arrayValue);
                for (const auto &o : snap.offerings) {
                    Json::Value obj;
                    obj["id"] = o.id;
                    obj["item_instance"] = o.item_instance_id;
                    obj["wants_type"] = o.wants_type;
                    obj["anchor_arch"] = o.anchor_arch;
                    obj["anchor_tag"] = o.anchor_tag;
                    obj["author"] = o.author;
                    obj["expires_at"] = o.expires_at;
                    offerings.append(obj);
                }
                body["offerings"] = std::move(offerings);

                // notes[]
                Json::Value notes(Json::arrayValue);
                for (const auto &n : snap.notes) {
                    Json::Value obj;
                    obj["id"] = n.id;
                    obj["archetype_id"] = n.archetype_id;
                    obj["anchor_tag"] = n.anchor_tag;
                    obj["template_id"] = n.template_id;
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
                    notes.append(obj);
                }
                body["notes"] = std::move(notes);

                auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
                resp->setStatusCode(drogon::k200OK);
                cb(resp);

            } catch (const drogon::orm::DrogonDbException &) {
                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(drogon::k500InternalServerError);
                cb(resp);
            }
        },
        dbClient)
        .detach();
}

} // namespace assembled_server
