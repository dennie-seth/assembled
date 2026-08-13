/// T-0097: OfferingController — POST /v1/offerings/{id}/claim.
///
/// Claim dispatches the atomic pay-and-release via PgOfferingRepo::claim().
/// All business-logic errors are surfaced as enum codes (03-net-protocol.md §3)
/// — never prose — so the client can localise them independently.
///
/// Response codes (03-net-protocol.md §3 error table):
///   200  claim succeeded; body is the transfer receipt.
///   400  3005 PAYMENT_TYPE_MISMATCH — payment item type != wants_type.
///   404  3004 OFFERING_ALREADY_CLAIMED — offering expired or already claimed.
///   409  3001 TRANSFER_LOST — CAS miss; taker should retry with fresh state.
///   422  3002 ITEM_NOT_HELD — payment item not in taker's inventory.
///   401  1001 UNKNOWN_TOKEN — missing or malformed Bearer header.
///   503       database unavailable.

#include "assembled_server/OfferingController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>

#include "assembled_server/Database.h"
#include "assembled_server/OfferingRepo.h"

namespace assembled_server {

namespace {

static drogon::HttpResponsePtr makeError(drogon::HttpStatusCode status, int code) {
    Json::Value j;
    j["error"] = code;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(j);
    resp->setStatusCode(status);
    return resp;
}

} // namespace

void OfferingController::claim(const drogon::HttpRequestPtr &req,
                               std::function<void(const drogon::HttpResponsePtr &)> &&callback,
                               const std::string &offering) {
    auto cb = std::move(callback);

    // ── 1. Extract bearer token ───────────────────────────────────────────────
    const std::string auth = req->getHeader("Authorization");
    if (auth.size() < 8 || auth.compare(0, 7, "Bearer ") != 0) {
        cb(makeError(drogon::k401Unauthorized, 1001)); // UNKNOWN_TOKEN
        return;
    }
    const std::string taker_token = auth.substr(7);

    // ── 2. Parse JSON body ────────────────────────────────────────────────────
    const auto body_json = req->getJsonObject();
    if (!body_json || !body_json->isMember("payment_item_id")) {
        cb(makeError(drogon::k400BadRequest, 2001)); // BAD_TEMPLATE (closest generic 2xxx)
        return;
    }
    const std::string payment_item_id = (*body_json)["payment_item_id"].asString();

    // ── 3. Obtain DB client (lazy init, shared across requests) ───────────────
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

    // ── 4. Execute claim in a worker thread ───────────────────────────────────
    // PgOfferingRepo::claim is blocking (synchronous Drogon DB calls).
    std::thread(
        [offering, taker_token, payment_item_id, cb](drogon::orm::DbClientPtr client) mutable {
            try {
                PgOfferingRepo repo(client);

                ClaimParams params;
                params.offering_id = offering;
                params.taker_token = taker_token;
                params.payment_item_id = payment_item_id;

                const ClaimResult result = repo.claim(params);

                // ── Map ClaimError to HTTP response ───────────────────────────
                switch (result.error) {
                case ClaimError::OfferingExpiredOrMissing:
                    cb(makeError(drogon::k404NotFound, 3004)); // OFFERING_ALREADY_CLAIMED
                    return;

                case ClaimError::PaymentNotHeld:
                    cb(makeError(drogon::k422UnprocessableEntity, 3002)); // ITEM_NOT_HELD
                    return;

                case ClaimError::PaymentTypeMismatch:
                    cb(makeError(drogon::k400BadRequest, 3005)); // PAYMENT_TYPE_MISMATCH
                    return;

                case ClaimError::CasLost:
                    cb(makeError(drogon::k409Conflict, 3001)); // TRANSFER_LOST
                    return;

                case ClaimError::None:
                    break;
                }

                // ── Success: build receipt ────────────────────────────────────
                Json::Value receipt(Json::objectValue);
                receipt["offered_item_id"] = result.offered_item_id;
                receipt["offered_version"] = result.offered_version;
                receipt["offered_depth"] = result.offered_depth;
                receipt["payment_version"] = result.payment_version;
                receipt["payment_depth"] = result.payment_depth;
                receipt["author"] = result.author_token;
                receipt["outcome"] = "won";

                auto resp = drogon::HttpResponse::newHttpJsonResponse(receipt);
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
