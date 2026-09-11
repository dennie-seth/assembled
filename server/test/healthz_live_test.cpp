/// T-0050: GET /healthz — readiness endpoint, live-DB happy path.
/// Gated on DATABASE_URL (early-return guard, same convention as
/// note_repo_test.cpp) so the build-only CI path stays green; `ctest
/// --preset db` exercises it against a real Postgres.
/// TDD: this file references HealthzController.h, which does not yet exist;
/// this commit is intentionally pre-implementation (conduct.md red-before-green).
/// Separate binary from healthz_test.cpp — see that file's header comment
/// for why the two DB-health paths can't share a process.

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
constexpr uint16_t kHealthzLiveTestPort = 18098;
} // namespace

TEST_CASE("GET /healthz returns 200 when the database is reachable") {
    if (!std::getenv("DATABASE_URL"))
        return;

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kHealthzLiveTestPort);
        drogon::app().run();
    });

    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client = drogon::HttpClient::newHttpClient("http://127.0.0.1:" +
                                                    std::to_string(kHealthzLiveTestPort));
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Get);
    req->setPath("/healthz");

    std::promise<void> done;
    client->sendRequest(req,
                        [&done](drogon::ReqResult result, const drogon::HttpResponsePtr &resp) {
                            REQUIRE(result == drogon::ReqResult::Ok);
                            REQUIRE(resp != nullptr);
                            CHECK(resp->statusCode() == drogon::k200OK);
                            auto json = resp->getJsonObject();
                            REQUIRE(json != nullptr);
                            CHECK((*json)["status"].asString() == "ok");
                            done.set_value();
                        });

    REQUIRE(done.get_future().wait_for(std::chrono::seconds(5)) == std::future_status::ready);

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
