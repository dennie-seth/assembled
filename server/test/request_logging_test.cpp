/// T-0050: structured (JSON) access logging for every HTTP request.
/// RequestLogger::install() registers Drogon pre-routing/post-handling
/// advice that emits one JSON log line per completed request, carrying the
/// request id, HTTP method, route, status code, and duration in
/// milliseconds. The test injects a sink (rather than scraping stdout) so
/// it asserts on structured data instead of a log-format string.
/// TDD: this file references RequestLogger.h, which does not yet exist;
/// this commit is intentionally pre-implementation (conduct.md red-before-green).
/// Separate binary: spins up its own drogon::app() instance (singleton
/// run-once-per-process constraint, see CMakeLists.txt).

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>
#include <json/json.h>

#include <chrono>
#include <future>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "assembled_server/HealthController.h"
#include "assembled_server/RequestLogger.h"

namespace {

constexpr uint16_t kRequestLoggingTestPort = 18097;

std::mutex g_logMutex;
std::vector<std::string> g_capturedLines;

void captureSink(const std::string &line) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    g_capturedLines.push_back(line);
}

} // namespace

TEST_CASE("structured request logging emits request id, route, status, and "
          "duration for each request") {
    assembled_server::RequestLogger::install(captureSink);

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kRequestLoggingTestPort);
        drogon::app().run();
    });

    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client = drogon::HttpClient::newHttpClient("http://127.0.0.1:" +
                                                    std::to_string(kRequestLoggingTestPort));
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Get);
    req->setPath("/health");

    std::promise<void> done;
    client->sendRequest(req,
                        [&done](drogon::ReqResult result, const drogon::HttpResponsePtr &resp) {
                            REQUIRE(result == drogon::ReqResult::Ok);
                            REQUIRE(resp != nullptr);
                            CHECK(resp->statusCode() == drogon::k200OK);
                            done.set_value();
                        });

    REQUIRE(done.get_future().wait_for(std::chrono::seconds(5)) == std::future_status::ready);

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();

    std::lock_guard<std::mutex> lock(g_logMutex);
    REQUIRE(g_capturedLines.size() == 1);

    Json::CharReaderBuilder builder;
    Json::Value entry;
    std::string errs;
    std::istringstream iss(g_capturedLines[0]);
    REQUIRE(Json::parseFromStream(builder, iss, &entry, &errs));

    CHECK(entry["method"].asString() == "GET");
    CHECK(entry["route"].asString() == "/health");
    CHECK(entry["status"].asInt() == 200);
    REQUIRE(entry["duration_ms"].isNumeric());
    CHECK(entry["duration_ms"].asDouble() >= 0.0);
    CHECK_FALSE(entry["request_id"].asString().empty());
}
