#include "assembled_server/IdentityController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <cstdlib>
#include <memory>
#include <mutex>

#include "assembled_server/Database.h"
#include "assembled_server/RateLimiter.h"
#include "assembled_server/SeedPhrase.h"

namespace assembled_server {

// Default rate limit: 10 mints per minute per IP (S-5 anti-brute-force).
std::unique_ptr<RateLimiter> IdentityController::rateLimiter_;

RateLimiter &IdentityController::rateLimiter() {
    if (!rateLimiter_) {
        rateLimiter_ = std::make_unique<RateLimiter>(10, std::chrono::seconds(60));
    }
    return *rateLimiter_;
}

void IdentityController::setRateLimiterForTesting(size_t maxRequests,
                                                   std::chrono::seconds window) {
    rateLimiter_ = std::make_unique<RateLimiter>(maxRequests, window);
}

void IdentityController::mintIdentity(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback) {

    // 1. Rate-limit check per client IP.
    const std::string ip = req->peerAddr().toIp();
    if (!rateLimiter().allow(ip)) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k429TooManyRequests);
        callback(resp);
        return;
    }

    // 2. Obtain DB client (lazy init from DATABASE_URL, thread-safe).
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

    // 3. Generate phrase and derive token (both sync, inexpensive).
    const std::string phrase = SeedPhrase::generate();

    const char *secretEnv = std::getenv("IDENTITY_SECRET");
    const std::string secret =
        (secretEnv && *secretEnv) ? secretEnv : "dev-secret-change-in-prod";
    const std::string token = SeedPhrase::deriveToken(secret, phrase);

    // 4. Persist the derived token; the phrase is NOT stored -- design §1.
    //    ON CONFLICT DO NOTHING: collision probability is ~2^-128, treated as
    //    a safe no-op (the identity already exists with this token).
    auto cb = std::move(callback);
    dbClient->execSqlAsync(
        "INSERT INTO identity (token) VALUES ($1) ON CONFLICT (token) DO NOTHING",
        [phrase, cb](const drogon::orm::Result & /*unused*/) {
            // 5. Return phrase exactly once; it is discarded after this response.
            Json::Value body;
            body["phrase"] = phrase;
            cb(drogon::HttpResponse::newHttpJsonResponse(body));
        },
        [cb](const drogon::orm::DrogonDbException & /*unused*/) {
            auto resp = drogon::HttpResponse::newHttpResponse();
            resp->setStatusCode(drogon::k500InternalServerError);
            cb(resp);
        },
        token);
}

} // namespace assembled_server
