/// T-0050: GET /healthz — readiness endpoint, DB-checked. Contrast with
/// `/health` (HealthController.h), which is a pure liveness check and
/// deliberately never pings the database.
/// TDD: this file references HealthzController.h, which does not yet exist;
/// this commit is intentionally pre-implementation (conduct.md red-before-green).
/// Separate binary from healthz_live_test.cpp and every other drogon::app()
/// integration test: the singleton can only run() once per process (see
/// CMakeLists.txt), and HealthzController caches its DbClientPtr via
/// call_once for the process lifetime, so the "DB unreachable" and
/// "DB reachable" paths can never safely share a process either.

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
constexpr uint16_t kHealthzTestPort = 18096;
} // namespace

TEST_CASE("GET /healthz returns non-200 when the database is unreachable") {
    // Force the "unhealthy" path regardless of what the ambient environment
    // (e.g. `ctest --preset db`) injects. HealthzController resolves
    // DATABASE_URL exactly once per process, so clearing it here must win
    // the race by running before the controller's first request.
    unsetenv("DATABASE_URL");

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kHealthzTestPort);
        drogon::app().run();
    });

    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client =
        drogon::HttpClient::newHttpClient("http://127.0.0.1:" + std::to_string(kHealthzTestPort));
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Get);
    req->setPath("/healthz");

    std::promise<void> done;
    client->sendRequest(req,
                        [&done](drogon::ReqResult result, const drogon::HttpResponsePtr &resp) {
                            REQUIRE(result == drogon::ReqResult::Ok);
                            REQUIRE(resp != nullptr);
                            CHECK(resp->statusCode() != drogon::k200OK);
                            CHECK(resp->statusCode() == drogon::k503ServiceUnavailable);
                            done.set_value();
                        });

    REQUIRE(done.get_future().wait_for(std::chrono::seconds(5)) == std::future_status::ready);

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
