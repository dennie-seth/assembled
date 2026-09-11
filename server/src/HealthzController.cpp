#include "assembled_server/HealthzController.h"

#include <drogon/HttpResponse.h>
#include <drogon/orm/DbClient.h>
#include <json/value.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>

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

/// Bound, in seconds, on the database round trip backing GET /healthz.
/// Configurable via `HEALTHZ_TIMEOUT_MS` (default 2000ms). Read fresh on
/// every call -- unlike DATABASE_URL, there is no cost to re-reading it,
/// and doing so lets tests dial it down without restarting the process.
double healthzTimeoutSeconds() {
    const char *env = std::getenv("HEALTHZ_TIMEOUT_MS");
    long ms = 2000;
    if (env != nullptr && std::strlen(env) > 0) {
        char *end = nullptr;
        long parsed = std::strtol(env, &end, 10);
        if (end != env && parsed > 0)
            ms = parsed;
    }
    return static_cast<double>(ms) / 1000.0;
}

} // namespace

void HealthzController::getHealthz(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback) const {
    (void)req;
    auto cb =
        std::make_shared<std::function<void(const drogon::HttpResponsePtr &)>>(std::move(callback));

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
        (*cb)(makeHealthzResponse(drogon::k503ServiceUnavailable, "error"));
        return;
    }

    // Guarantee exactly one response, however this resolves: the query
    // succeeding, the query failing, or the timeout below firing first. A
    // configured-but-unreachable database (or a healthy one that drops
    // mid-request) must still yield a timely 503 instead of leaving the
    // request hanging forever (Codex PR review 2026-09-11: the previous
    // synchronous-query-in-a-detached-thread implementation had no such
    // bound, so the callback was never invoked at all).
    auto responded = std::make_shared<std::atomic<bool>>(false);
    auto respondOnce = [cb, responded](drogon::HttpStatusCode status, const std::string &field) {
        bool expected = false;
        if (responded->compare_exchange_strong(expected, true))
            (*cb)(makeHealthzResponse(status, field));
    };

    drogon::app().getLoop()->runAfter(healthzTimeoutSeconds(), [respondOnce]() {
        respondOnce(drogon::k503ServiceUnavailable, "error");
    });

    // execSqlAsync is non-blocking -- it queues the query on the DbClient's
    // own I/O thread rather than tying up an application thread waiting for
    // a connection, so a sustained outage does not accumulate one blocked
    // thread per poll the way the previous detached std::thread did.
    dbClient->execSqlAsync(
        "SELECT 1",
        [respondOnce](const drogon::orm::Result &) { respondOnce(drogon::k200OK, "ok"); },
        [respondOnce](const drogon::orm::DrogonDbException &) {
            respondOnce(drogon::k503ServiceUnavailable, "error");
        });
}

} // namespace assembled_server
