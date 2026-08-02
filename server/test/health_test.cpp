#include <doctest/doctest.h>
#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>

#include <chrono>
#include <future>
#include <thread>

#include "assembled_server/HealthController.h"

namespace {

/// T-0040/T-0050: proves Drogon actually builds *and serves* -- this is the
/// proof-of-life integration test, not a handler-in-isolation unit test.
/// Runs the real app on a loopback-only port, hits it with Drogon's own
/// HTTP client, and tears the app down again so it can't leak into other
/// test cases.
constexpr uint16_t kTestPort = 18080;

} // namespace

TEST_CASE("GET /health returns 200 with {\"status\":\"ok\"}") {
    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kTestPort);
        drogon::app().run();
    });

    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client =
        drogon::HttpClient::newHttpClient("http://127.0.0.1:" + std::to_string(kTestPort));
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Get);
    req->setPath("/health");

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
