#include "assembled_server/PetitionController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <cstdlib>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "assembled_server/Database.h"
#include "assembled_server/NoteRepo.h"
#include "assembled_server/RateLimiter.h"

namespace assembled_server {

namespace {

/// Template IDs used for petition notes (02-notes-system.md §6).
constexpr int16_t kTemplateIamNeed = 13;  ///< "I need {ITEM_REF}" — named-item petition.
constexpr int16_t kTemplateSomethingWrong = 14; ///< "something is wrong" — general plea.

/// Default petition rate limit: 2 per hour per token.  Strictly tighter than
/// the general API limit (03-net-protocol.md §7; 15-server-ops.md §7).
/// Override via PETITION_RATE_LIMIT_MAX and PETITION_RATE_LIMIT_WINDOW_SEC.
constexpr size_t kDefaultPetitionMax = 2;
constexpr long kDefaultPetitionWindowSec = 3600;

/// Default list limit when ?limit= is omitted.
constexpr int kDefaultListLimit = 20;

static drogon::HttpResponsePtr makeError(drogon::HttpStatusCode status, int code) {
    Json::Value j;
    j["error"] = code;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(j);
    resp->setStatusCode(status);
    return resp;
}

} // namespace

// ── Static rate limiter ────────────────────────────────────────────────────────

std::unique_ptr<RateLimiter> PetitionController::rateLimiter_;

RateLimiter &PetitionController::rateLimiter() {
    if (!rateLimiter_) {
        // Read configurable ceiling from environment; fall back to tight defaults.
        size_t maxReq = kDefaultPetitionMax;
        long windowSec = kDefaultPetitionWindowSec;

        const char *maxEnv = std::getenv("PETITION_RATE_LIMIT_MAX");
        if (maxEnv && *maxEnv) {
            try {
                maxReq = static_cast<size_t>(std::stoul(maxEnv));
            } catch (...) {
            }
        }
        const char *winEnv = std::getenv("PETITION_RATE_LIMIT_WINDOW_SEC");
        if (winEnv && *winEnv) {
            try {
                windowSec = std::stol(winEnv);
            } catch (...) {
            }
        }
        rateLimiter_ = std::make_unique<RateLimiter>(maxReq, std::chrono::seconds(windowSec));
    }
    return *rateLimiter_;
}

void PetitionController::setRateLimiterForTesting(size_t maxRequests,
                                                   std::chrono::seconds window) {
    rateLimiter_ = std::make_unique<RateLimiter>(maxRequests, window);
}

RateLimiter &PetitionController::rateLimiterForTesting() {
    return rateLimiter();
}

// ── POST /v1/petitions ────────────────────────────────────────────────────────

void PetitionController::createPetition(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
    auto cb = std::move(callback);

    // ── 1. Extract bearer token (401 if absent/malformed) ─────────────────
    const std::string auth = req->getHeader("Authorization");
    if (auth.size() < 8 || auth.compare(0, 7, "Bearer ") != 0) {
        cb(makeError(drogon::k401Unauthorized, 1001)); // UNKNOWN_TOKEN
        return;
    }
    const std::string token = auth.substr(7);

    // ── 2. Petition rate-limit check (per token, tighter than general) ────
    if (!rateLimiter().allow(token)) {
        cb(makeError(drogon::k429TooManyRequests, 5001)); // RATE_LIMITED
        return;
    }

    // ── 3. Parse optional body ────────────────────────────────────────────
    std::optional<int16_t> item_type;
    auto body = req->getJsonObject();
    if (body && body->isMember("item_type")) {
        const auto &itv = (*body)["item_type"];
        if (!itv.isIntegral() || itv.asInt() <= 0) {
            cb(makeError(drogon::k400BadRequest, 2001)); // BAD_TEMPLATE (invalid item_type)
            return;
        }
        item_type = static_cast<int16_t>(itv.asInt());
    }

    // ── 4. DB client (lazy init) ──────────────────────────────────────────
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

    // ── 5. Unique-tier check + note insert in a worker thread ─────────────
    //
    // PgNoteRepo::createBroadcast and execSqlSync are blocking; detach a
    // worker to keep the Drogon IO loop free (same pattern as NoteController).
    std::thread(
        [token, item_type, cb](drogon::orm::DbClientPtr client) mutable {
            try {
                // Unique-tier guard: token must exist in petition_tier.
                const auto tierRows = client->execSqlSync(
                    "SELECT EXISTS(SELECT 1 FROM petition_tier WHERE token = $1)", token);
                if (!tierRows[0][0].as<bool>()) {
                    cb(makeError(drogon::k403Forbidden, 4002)); // VOCAB_TIER_LOCKED
                    return;
                }

                // If item_type provided, validate it references a known item type.
                std::optional<std::string> item_ref;
                int16_t template_id = kTemplateSomethingWrong;
                if (item_type.has_value()) {
                    const auto typeRows = client->execSqlSync(
                        "SELECT EXISTS(SELECT 1 FROM item_type WHERE id = $1)", item_type.value());
                    if (!typeRows[0][0].as<bool>()) {
                        cb(makeError(drogon::k400BadRequest, 2001)); // BAD_TEMPLATE (unknown type)
                        return;
                    }
                    item_ref = std::to_string(item_type.value());
                    template_id = kTemplateIamNeed;
                }

                // Insert broadcast note (no anchor).
                CreateBroadcastParams params;
                params.author_token = token;
                params.template_id = template_id;
                params.item_ref = item_ref;

                PgNoteRepo repo(client);
                const std::string note_id = repo.createBroadcast(params);

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
        dbClient)
        .detach();
}

// ── GET /v1/petitions ─────────────────────────────────────────────────────────

void PetitionController::listPetitions(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
    // Parse optional ?limit= (default kDefaultListLimit, clamped inside fetchBroadcast).
    int limit = kDefaultListLimit;
    const auto &limitParam = req->getParameter("limit");
    if (!limitParam.empty()) {
        try {
            limit = std::stoi(limitParam);
        } catch (const std::exception &) {
            limit = kDefaultListLimit;
        }
    }

    // DB client (lazy init, shared with createPetition via the same once_flag).
    static std::once_flag listDbFlag;
    static drogon::orm::DbClientPtr listDbClient;
    std::call_once(listDbFlag, []() {
        auto db = Database::fromEnv();
        if (db)
            listDbClient = db->getClient();
    });

    if (!listDbClient) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        callback(resp);
        return;
    }

    PgNoteRepo repo(listDbClient);
    const auto notes = repo.fetchBroadcast(limit);

    Json::Value body(Json::arrayValue);
    for (const auto &n : notes) {
        Json::Value obj;
        obj["id"] = n.id;
        obj["template_id"] = n.template_id;
        obj["is_broadcast"] = n.is_broadcast;

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
