/// T-0364 fix round: Codex re-review of #379 (P1), 2026-09-11.
/// TDD: this file is committed BEFORE the async/deadline fix exists, so it
/// must fail red against the execSqlSync implementation (the single HTTP
/// worker stalls on /health while /v1/vocabulary hangs against a dead DB)
/// and pass green once VocabularyController uses execSqlAsync + a real
/// DbClient deadline.
///
/// Runs in its own process with DATABASE_URL pointed at a closed local
/// port -- set via a global static constructed before main(), so it's in
/// place before VocabularyController's lazily-constructed DbClient reads
/// it on the first request. A live Postgres is deliberately NOT required
/// here (this suite is about behaviour under an unreachable database, not
/// vocabulary contents -- see vocabulary_handler_test.cpp for that).
///
/// Acceptance criteria exercised (tasks/T-0364.md, Codex re-review section):
///   - with the database configured but unreachable, GET /v1/vocabulary
///     still returns a database-error response within the configured bound.
///   - while GET /v1/vocabulary is pending, an unrelated GET /health still
///     answers promptly -- the one HTTP worker is never stalled.
///   - the per-request state captured by the query's callbacks is released
///     shortly after the deadline, not retained for the life of the outage.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <chrono>
#include <cstdlib>
#include <future>
#include <string>
#include <thread>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>
#include <json/value.h>

#include "assembled_server/VocabularyController.h"

namespace {

constexpr uint16_t kOutageTestPort = 18097;
// Nothing listens here on purpose -- refused connections keep Drogon's
// PgClient retrying forever with no deadline of our own to bound it.
constexpr const char *kUnreachableDatabaseUrl = "postgresql://review:review@127.0.0.1:19943/review";
constexpr int kQueryTimeoutMs = 300;
// Generous slack over kQueryTimeoutMs for CI scheduling jitter -- this is a
// ceiling the *real* deadline must comfortably beat, not a tight bound.
constexpr auto kResponseSlack = std::chrono::milliseconds(3000);
constexpr auto kHealthBudget = std::chrono::milliseconds(1000);

/// Constructed at static-init time, before main() runs (doctest generates
/// main via DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN) -- guarantees DATABASE_URL
/// is set before VocabularyController's call_once DbClient construction,
/// which only happens on the first request, well after main() starts.
struct SetUnreachableDatabaseUrl {
    SetUnreachableDatabaseUrl() { setenv("DATABASE_URL", kUnreachableDatabaseUrl, 1); }
} gSetUnreachableDatabaseUrl;

std::pair<drogon::HttpStatusCode, std::chrono::milliseconds>
timedGet(const drogon::HttpClientPtr &client, const std::string &path, const std::string &token,
         std::chrono::milliseconds waitBudget) {
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Get);
    req->setPath(path);
    if (!token.empty()) {
        req->addHeader("Authorization", "Bearer " + token);
    }

    std::promise<drogon::HttpStatusCode> p;
    const auto start = std::chrono::steady_clock::now();
    client->sendRequest(req, [&p](drogon::ReqResult res, const drogon::HttpResponsePtr &resp) {
        if (res == drogon::ReqResult::Ok && resp) {
            p.set_value(resp->statusCode());
        } else {
            p.set_value(drogon::k500InternalServerError);
        }
    });

    auto fut = p.get_future();
    REQUIRE(fut.wait_for(waitBudget) == std::future_status::ready);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start);
    return {fut.get(), elapsed};
}

} // namespace

TEST_CASE("GET /v1/vocabulary is bounded and never blocks /health during a DB outage") {
    // Short deadline so this test doesn't have to wait out the production
    // default (VOCABULARY_QUERY_TIMEOUT_MS / 2s) to see it fire.
    assembled_server::VocabularyController::setQueryTimeoutForTesting(
        std::chrono::milliseconds(kQueryTimeoutMs));

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kOutageTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client =
        drogon::HttpClient::newHttpClient("http://127.0.0.1:" + std::to_string(kOutageTestPort));

    // Baseline: /health answers promptly before vocabulary ever touches the
    // (unreachable) database.
    {
        auto [code, elapsed] = timedGet(client, "/health", "", kHealthBudget);
        CHECK(code == drogon::k200OK);
        CHECK(elapsed < kHealthBudget);
    }

    REQUIRE(assembled_server::VocabularyController::pendingQueryCountForTests() == 0u);

    // Kick off GET /v1/vocabulary on its own thread purely so this test can
    // probe /health concurrently -- the controller itself must not spawn
    // any thread of its own to run the query (Codex re-review, 2026-09-11).
    auto vocabFuture = std::async(std::launch::async, [&client]() {
        return timedGet(client, "/v1/vocabulary", "outage-test-token", kResponseSlack);
    });

    // Give the request time to actually reach the handler and queue its
    // query against the dead database before probing /health concurrently.
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK(assembled_server::VocabularyController::pendingQueryCountForTests() >= 1u);

    // While /v1/vocabulary is still pending against the unreachable
    // database, /health must still answer promptly: the single HTTP worker
    // must never be stalled waiting on it (this is the exact failure Codex
    // reproduced against execSqlSync -- both /health calls timed out at 3s).
    {
        auto [code, elapsed] = timedGet(client, "/health", "", kHealthBudget);
        CHECK(code == drogon::k200OK);
        CHECK(elapsed < kHealthBudget);
    }

    auto [vocabCode, vocabElapsed] = vocabFuture.get();
    CHECK(vocabCode == drogon::k503ServiceUnavailable);
    CHECK(vocabElapsed < kResponseSlack);

    // The per-request state (which owns the HTTP response callback) must be
    // released shortly after the deadline elapses, not retained for as long
    // as the database stays unreachable.
    bool releasedPromptly = false;
    for (int i = 0; i < 50 && !releasedPromptly; ++i) {
        if (assembled_server::VocabularyController::pendingQueryCountForTests() == 0u) {
            releasedPromptly = true;
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    }
    CHECK(releasedPromptly);

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
