#include "assembled_server/VocabularyController.h"

#include <drogon/HttpResponse.h>
#include <json/value.h>

#include <atomic>
#include <cstdlib>
#include <memory>
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

/// Production default: bound a vocabulary query to 2s of wall time before
/// giving up on an unreachable/slow database. Override with
/// VOCABULARY_QUERY_TIMEOUT_MS (milliseconds).
constexpr double kDefaultQueryTimeoutSeconds = 2.0;

/// Negative = no test override in effect; see setQueryTimeoutForTesting.
std::atomic<double> gTestTimeoutSeconds{-1.0};

double queryTimeoutSeconds() {
    const double overridden = gTestTimeoutSeconds.load(std::memory_order_relaxed);
    if (overridden >= 0.0) {
        return overridden;
    }
    if (const char *env = std::getenv("VOCABULARY_QUERY_TIMEOUT_MS"); env && *env) {
        try {
            return std::stod(env) / 1000.0;
        } catch (const std::exception &) {
        }
    }
    return kDefaultQueryTimeoutSeconds;
}

/// Number of GET /v1/vocabulary requests whose async query is still
/// outstanding; see VocabularyController::pendingQueryCountForTests.
std::atomic<std::size_t> gPendingQueries{0};

/// Per-request state carried into the async query's callbacks. Holding it
/// in one shared_ptr means the object above (and everything it captured,
/// including the HTTP response callback) is destroyed the moment Drogon
/// invokes one of the two callbacks below and drops its own reference --
/// which, thanks to the DbClient's configured timeout, happens shortly
/// after the deadline even if the database never becomes reachable. There
/// is no separate manual timer/weak_ptr bookkeeping needed here: the
/// deadline is enforced by the DbClient itself (dbClient->setTimeout,
/// below), not by this controller (Codex re-review, 2026-09-11).
struct QueryState {
    std::function<void(const drogon::HttpResponsePtr &)> callback;

    explicit QueryState(std::function<void(const drogon::HttpResponsePtr &)> cb)
        : callback(std::move(cb)) {
        gPendingQueries.fetch_add(1, std::memory_order_relaxed);
    }

    ~QueryState() { gPendingQueries.fetch_sub(1, std::memory_order_relaxed); }
};

} // namespace

void VocabularyController::setQueryTimeoutForTesting(std::chrono::milliseconds timeout) {
    gTestTimeoutSeconds.store(timeout.count() / 1000.0, std::memory_order_relaxed);
}

std::size_t VocabularyController::pendingQueryCountForTests() {
    return gPendingQueries.load(std::memory_order_relaxed);
}

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

    // ── 2. DB client (lazy init, cached for this controller only) ─────────
    // A dedicated client (not the one NoteController/etc. share) so the
    // deadline configured below is local to this route -- #374/T-0050 needs
    // the same treatment for the shared Database setup and may touch that
    // file separately (Codex re-review, 2026-09-11).
    static std::once_flag dbFlag;
    static drogon::orm::DbClientPtr dbClient;
    std::call_once(dbFlag, []() {
        auto db = Database::fromEnv();
        if (db) {
            dbClient = db->getClient();
            // Real, configured deadline: without this, DbClient::setTimeout
            // defaults to -1 (no limit), and a query queued against an
            // unreachable database waits forever.
            dbClient->setTimeout(queryTimeoutSeconds());
        }
    });

    if (!dbClient) {
        auto resp = drogon::HttpResponse::newHttpResponse();
        resp->setStatusCode(drogon::k503ServiceUnavailable);
        callback(resp);
        return;
    }

    // ── 3. Bounded async query for the caller's unlocked words ─────────────
    // This is exactly the table NoteController::createNote checks before
    // accepting a slot word — no fallback tier, no full-catalogue default.
    // execSqlAsync never blocks the calling (HTTP event loop) thread -- the
    // wait for a connection/result happens on the DbClient's own loop, not
    // here, and no thread-per-request is spawned to hide it.
    auto state = std::make_shared<QueryState>(std::move(callback));

    dbClient->execSqlAsync(
        "SELECT word_id FROM vocabulary WHERE token = $1 ORDER BY word_id",
        [state](const drogon::orm::Result &rows) {
            Json::Value body(Json::arrayValue);
            for (const auto &row : rows) {
                body.append(row["word_id"].as<int>());
            }
            state->callback(drogon::HttpResponse::newHttpJsonResponse(body));
        },
        [state](const drogon::orm::DrogonDbException & /*unused*/) {
            // Covers both a real query failure and DbClient::setTimeout's
            // TimeoutError -- either way the database can't answer right
            // now, so this is a database-error response, not a 401/403.
            auto resp = drogon::HttpResponse::newHttpResponse();
            resp->setStatusCode(drogon::k503ServiceUnavailable);
            state->callback(resp);
        },
        token);
}

} // namespace assembled_server
