#include "assembled_server/HealthzController.h"

#include <drogon/HttpResponse.h>
#include <drogon/orm/DbClient.h>
#include <json/value.h>

#include <mutex>
#include <thread>

#include "assembled_server/Database.h"

namespace assembled_server {

namespace {

drogon::HttpResponsePtr makeHealthzResponse(drogon::HttpStatusCode status,
                                            const std::string &statusField) {
    Json::Value body;
    body["status"] = statusField;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
    resp->setStatusCode(status);
    return resp;
}

} // namespace

void HealthzController::getHealthz(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback) const {
    (void)req;
    auto cb = std::move(callback);

    // Cached for the process lifetime (see Database.cpp's keepAliveRegistry
    // comment for why a fresh Database per request is unsafe), and resolved
    // exactly once: DATABASE_URL is fixed for the life of the process, so
    // there is nothing to gain by re-reading the environment on every call.
    static std::once_flag dbFlag;
    static drogon::orm::DbClientPtr dbClient;
    std::call_once(dbFlag, []() {
        auto db = Database::fromEnv();
        if (db)
            dbClient = db->getClient();
    });

    if (!dbClient) {
        cb(makeHealthzResponse(drogon::k503ServiceUnavailable, "error"));
        return;
    }

    // execSqlSync blocks, so run it off the event loop thread (same pattern
    // as OfferingController::claim).
    std::thread(
        [cb](drogon::orm::DbClientPtr client) mutable {
            try {
                client->execSqlSync("SELECT 1");
                cb(makeHealthzResponse(drogon::k200OK, "ok"));
            } catch (const drogon::orm::DrogonDbException &) {
                cb(makeHealthzResponse(drogon::k503ServiceUnavailable, "error"));
            }
        },
        dbClient)
        .detach();
}

} // namespace assembled_server
