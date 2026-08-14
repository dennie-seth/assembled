#include "assembled_server/NoteController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <cstdlib>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "assembled_server/Database.h"
#include "assembled_server/NoteRepo.h"
#include "shared/note_templates.hpp"

namespace assembled_server {

namespace {

/// Build a JSON error response body per the protocol (03-net-protocol.md §3).
/// HTTP status carries the class; the body carries the specific error code.
static drogon::HttpResponsePtr makeError(drogon::HttpStatusCode status, int code) {
    Json::Value j;
    j["error"] = code;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(j);
    resp->setStatusCode(status);
    return resp;
}

/// Default limit when the caller omits the ?limit= parameter.
constexpr int kDefaultLimit = 20;

/// Parse a required SMALLINT query parameter.
/// @returns the parsed value, or std::nullopt if missing/invalid.
std::optional<int16_t> parseSmallInt(const drogon::HttpRequestPtr &req, const std::string &name) {
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

void NoteController::createNote(const drogon::HttpRequestPtr &req,
                                std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
    auto cb = std::move(callback);

    // ── 1. Parse body ──────────────────────────────────────────────────────
    auto body = req->getJsonObject();
    if (!body || !body->isMember("template_id") || !(*body)["template_id"].isIntegral()) {
        cb(makeError(drogon::k400BadRequest, 2001));
        return;
    }

    // ── 2. Validate template_id (in-memory) ───────────────────────────────
    const auto tid = static_cast<int16_t>((*body)["template_id"].asInt());
    const assembled::TemplateDef *tmpl = nullptr;
    for (const auto &t : assembled::kTemplates) {
        if (t.id == tid) {
            tmpl = &t;
            break;
        }
    }
    if (!tmpl) {
        cb(makeError(drogon::k400BadRequest, 2001)); // BAD_TEMPLATE
        return;
    }

    // ── 3. Parse slots and validate arity (in-memory) ─────────────────────
    std::vector<int16_t> slots;
    if (body->isMember("slots") && (*body)["slots"].isArray()) {
        for (const auto &s : (*body)["slots"]) {
            slots.push_back(static_cast<int16_t>(s.asInt()));
        }
    }
    if (static_cast<int16_t>(slots.size()) != tmpl->slots) {
        cb(makeError(drogon::k400BadRequest, 2002)); // SLOT_ARITY_MISMATCH
        return;
    }

    // ── 4. Validate slot categories (in-memory, via shared/note_templates) ─
    for (std::size_t i = 0; i < slots.size(); ++i) {
        const int16_t expected = (i == 0) ? tmpl->slot_a_category : tmpl->slot_b_category;
        int16_t actual = 0;
        for (const auto &w : assembled::kWords) {
            if (w.id == slots[i]) {
                actual = static_cast<int16_t>(w.category);
                break;
            }
        }
        if (actual == 0 || actual != expected) {
            cb(makeError(drogon::k400BadRequest, 2003)); // SLOT_CATEGORY_MISMATCH
            return;
        }
    }

    // ── 5. Extract other request fields ───────────────────────────────────
    if (!body->isMember("archetype") || !body->isMember("tag")) {
        cb(makeError(drogon::k400BadRequest, 2004)); // UNKNOWN_ANCHOR
        return;
    }
    const auto archetype_id = static_cast<int16_t>((*body)["archetype"].asInt());
    const auto anchor_tag_val = static_cast<int16_t>((*body)["tag"].asInt());

    std::optional<std::string> item_ref;
    if (body->isMember("item_ref") && (*body)["item_ref"].isString()) {
        item_ref = (*body)["item_ref"].asString();
    }

    // ── 6. Extract bearer token ───────────────────────────────────────────
    const std::string auth = req->getHeader("Authorization");
    if (auth.size() < 8 || auth.compare(0, 7, "Bearer ") != 0) {
        cb(makeError(drogon::k401Unauthorized, 1001)); // UNKNOWN_TOKEN
        return;
    }
    const std::string token = auth.substr(7);

    // ── 7. Get DB client (lazy init, shared across requests) ──────────────
    static std::once_flag createDbFlag;
    static drogon::orm::DbClientPtr createDbClient;
    std::call_once(createDbFlag, []() {
        auto db = Database::fromEnv();
        if (db)
            createDbClient = db->getClient();
    });

    if (!createDbClient) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        cb(resp);
        return;
    }

    // ── 8. Vocabulary check + note insert in a worker thread ──────────────
    //
    // PgNoteRepo::create and execSqlSync are blocking calls; running them
    // on the Drogon IO loop thread would stall all other in-flight requests.
    // A detached worker thread holds no Drogon resources and is safe to use
    // here: both DbClientPtr and the drogon callback are thread-safe.
    std::thread(
        [tid, archetype_id, anchor_tag_val, slots, item_ref, token,
         cb](drogon::orm::DbClientPtr client) mutable {
            try {
                // Vocabulary check: every slot word must appear in the
                // caller's unlocked vocabulary (4002 VOCAB_TIER_LOCKED).
                if (!slots.empty()) {
                    int unlocked = 0;
                    if (slots.size() == 1) {
                        auto r = client->execSqlSync("SELECT COUNT(*) FROM vocabulary "
                                                     "WHERE token = $1 AND word_id = $2",
                                                     token, slots[0]);
                        unlocked = r[0][0].as<int>();
                    } else {
                        auto r = client->execSqlSync("SELECT COUNT(*) FROM vocabulary "
                                                     "WHERE token = $1 AND word_id IN ($2, $3)",
                                                     token, slots[0], slots[1]);
                        unlocked = r[0][0].as<int>();
                    }
                    if (unlocked < static_cast<int>(slots.size())) {
                        cb(makeError(drogon::k403Forbidden, 4002));
                        return;
                    }
                }

                // Insert the note via PgNoteRepo.
                CreateNoteParams params;
                params.author_token = token;
                params.archetype_id = archetype_id;
                params.anchor_tag = anchor_tag_val;
                params.template_id = tid;
                if (!slots.empty())
                    params.slot_a = slots[0];
                if (slots.size() > 1)
                    params.slot_b = slots[1];
                params.item_ref = item_ref;

                PgNoteRepo repo(client);
                const std::string note_id = repo.create(params);

                Json::Value j;
                j["id"] = note_id;
                auto resp = drogon::HttpResponse::newHttpJsonResponse(j);
                resp->setStatusCode(drogon::k201Created);
                cb(resp);

            } catch (const drogon::orm::DrogonDbException &) {
                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(drogon::k500InternalServerError);
                cb(resp);
            }
        },
        createDbClient)
        .detach();
}

void NoteController::listNotes(const drogon::HttpRequestPtr &req,
                               std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
    // 1. Parse required parameters.
    const auto archetype_id = parseSmallInt(req, "archetype_id");
    const auto anchor_tag = parseSmallInt(req, "anchor_tag");

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
    static std::once_flag listDbFlag;
    static drogon::orm::DbClientPtr listDbClient;
    std::call_once(listDbFlag, []() {
        auto db = Database::fromEnv();
        if (db) {
            listDbClient = db->getClient();
        }
    });

    if (!listDbClient) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        callback(resp);
        return;
    }

    // 4. Query — fetchRanked clamps limit to kMaxNotesLimit internally.
    PgNoteRepo repo(listDbClient);
    const auto notes = repo.fetchRanked(*archetype_id, *anchor_tag, limit);

    // 5. Build JSON array response.
    Json::Value body(Json::arrayValue);
    for (const auto &n : notes) {
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
        body.append(obj);
    }

    callback(drogon::HttpResponse::newHttpJsonResponse(body));
}

void NoteController::rateNote(const drogon::HttpRequestPtr &req,
                              std::function<void(const drogon::HttpResponsePtr &)> &&callback,
                              const std::string &id) {
    auto cb = std::move(callback);

    // ── 1. Auth header ────────────────────────────────────────────────────────
    const std::string auth = req->getHeader("Authorization");
    if (auth.size() < 8 || auth.compare(0, 7, "Bearer ") != 0) {
        cb(makeError(drogon::k401Unauthorized, 1001)); // UNKNOWN_TOKEN
        return;
    }
    const std::string token = auth.substr(7);

    // ── 2. Parse JSON body ────────────────────────────────────────────────────
    auto body = req->getJsonObject();
    if (!body || !body->isMember("val") || !(*body)["val"].isIntegral()) {
        cb(makeError(drogon::k400BadRequest, 2005)); // INVALID_RATING_VAL
        return;
    }
    const int rawVal = (*body)["val"].asInt();
    if (rawVal != 1 && rawVal != -1) {
        cb(makeError(drogon::k400BadRequest, 2005)); // INVALID_RATING_VAL
        return;
    }
    const auto val = static_cast<int16_t>(rawVal);

    // ── 3. DB client (lazy init, shared across requests) ──────────────────────
    static std::once_flag rateDbFlag;
    static drogon::orm::DbClientPtr rateDbClient;
    std::call_once(rateDbFlag, []() {
        auto db = Database::fromEnv();
        if (db)
            rateDbClient = db->getClient();
    });

    if (!rateDbClient) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        cb(resp);
        return;
    }

    // ── 4. Upsert vote in a worker thread ─────────────────────────────────────
    // PgNoteRepo::rate is a blocking call; run it off the Drogon IO thread.
    std::thread(
        [id, token, val, cb](drogon::orm::DbClientPtr client) mutable {
            try {
                PgNoteRepo repo(client);
                repo.rate(id, token, val);

                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(drogon::k200OK);
                cb(resp);
            } catch (const drogon::orm::DrogonDbException &) {
                auto resp = drogon::HttpResponse::newHttpResponse();
                resp->setStatusCode(drogon::k500InternalServerError);
                cb(resp);
            }
        },
        rateDbClient)
        .detach();
}

} // namespace assembled_server
