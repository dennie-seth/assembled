/// T-0050 FIX ROUND (Codex PR review 2026-09-11, P1): GET /healthz must
/// resolve within a bounded, configured timeout even when DATABASE_URL
/// points at a database that never completes a connection. The original
/// implementation ran a synchronous `SELECT 1` in a detached thread with no
/// query timeout: a configured-but-unreachable database left the health
/// callback never invoked at all (Codex's reproduction: no callback after
/// 12 seconds), and every poll during an outage piled up one more blocked
/// thread.
///
/// This test points DATABASE_URL at a closed local port -- configured, but
/// nothing is listening, so the connection can never complete -- and polls
/// /healthz repeatedly, asserting every poll still responds (503) within
/// the configured bound.
///
/// TDD: this file references a `HEALTHZ_TIMEOUT_MS`-bounded getHealthz()
/// that does not exist yet; this commit is intentionally pre-implementation
/// (conduct.md red-before-green). Not yet wired into CMakeLists.txt -- see
/// the implementation commit for that, same convention as the original
/// healthz_test.cpp / healthz_live_test.cpp red-step commit (3ccbd2d).
///
/// Separate binary from healthz_test.cpp and healthz_live_test.cpp: this is
/// a third, distinct DB-health state (configured but unreachable, as
/// opposed to unset/DATABASE_URL-absent or genuinely reachable), and
/// HealthzController caches its DbClientPtr via call_once for the process
/// lifetime, so none of the three states can safely share a process.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>

#include <chrono>
#include <cstdlib>
#include <future>
#include <thread>

#include "assembled_server/HealthzController.h"

namespace {

constexpr uint16_t kHealthzTimeoutTestPort = 18099;

// Nothing listens here -- a closed port makes TCP-level connection refusal
// immediate while still exercising the bounded-timeout wrapper end-to-end,
// deterministically and with no Docker/Postgres dependency (same "fixed
// port, nothing bound there" convention as the other test ports in this
// suite).
constexpr const char *kClosedPortDatabaseUrl = "postgresql://review:review@127.0.0.1:18190/review";

// Configured short so the test runs fast and deterministically; production
// gets a longer default (see healthzTimeoutSeconds() in HealthzController.cpp).
constexpr const char *kTestHealthzTimeoutMs = "300";

// Comfortably above the configured timeout so a slow CI box can't flake,
// but far below Codex's 12-second "never responds" reproduction.
constexpr auto kResponseBound = std::chrono::seconds(5);

} // namespace

TEST_CASE("GET /healthz returns 503 within the configured bound, repeatedly, "
          "when the configured database is unreachable") {
    setenv("HEALTHZ_TIMEOUT_MS", kTestHealthzTimeoutMs, 1);
    setenv("DATABASE_URL", kClosedPortDatabaseUrl, 1);

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kHealthzTimeoutTestPort);
        drogon::app().run();
    });

    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client = drogon::HttpClient::newHttpClient("http://127.0.0.1:" +
                                                    std::to_string(kHealthzTimeoutTestPort));

    // Poll several times in a row -- a load balancer's steady state during
    // an outage. Every poll must land its own bounded response; none may
    // pile up waiting behind a connection attempt stuck from a prior poll.
    for (int i = 0; i < 5; ++i) {
        auto req = drogon::HttpRequest::newHttpRequest();
        req->setMethod(drogon::Get);
        req->setPath("/healthz");

        std::promise<void> done;
        client->sendRequest(req,
                            [&done](drogon::ReqResult result, const drogon::HttpResponsePtr &resp) {
                                REQUIRE(result == drogon::ReqResult::Ok);
                                REQUIRE(resp != nullptr);
                                CHECK(resp->statusCode() == drogon::k503ServiceUnavailable);
                                done.set_value();
                            });

        CAPTURE(i);
        REQUIRE(done.get_future().wait_for(kResponseBound) == std::future_status::ready);
    }

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
