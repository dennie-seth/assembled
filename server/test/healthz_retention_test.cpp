/// T-0050 FIX ROUND 2 (Codex re-review 2026-09-11, P2): time out the
/// database *query*, not just the HTTP response. Round 1 (see
/// healthz_timeout_test.cpp) bounded the response with a timer and an
/// atomic exactly-once guard, but `execSqlAsync` itself had no deadline:
/// the DbClient's own callbacks stayed queued until a connection actually
/// succeeded, so a database that never resolves its connection (closed
/// port, or one that stops responding mid-outage) leaked the captured
/// response state indefinitely even though the caller already got its 503
/// from the response timer. Codex's `health_retention_probe.cpp` found an
/// object captured only by the response callback still alive 2 seconds
/// after a 100ms `HEALTHZ_TIMEOUT_MS`.
///
/// This test calls `HealthzController::getHealthz()` directly (no HTTP
/// round trip needed -- the retention bug lives entirely in what
/// `execSqlAsync` keeps alive, not in the HTTP layer) against a closed
/// local port, captures a marker object *only* inside each response
/// callback, and polls repeatedly to model a sustained outage. It asserts
/// every marker is released shortly after the configured timeout, so
/// neither a single poll nor a run of polls during an outage can leave
/// retained callbacks or pending queries piled up.
///
/// TDD: red before the fix -- without a real deadline on the dedicated
/// DbClient, the query callbacks are never released for an unreachable
/// database, so every marker's `weak_ptr` stays alive well past the check
/// delay below and every CHECK in this file fails.
///
/// Separate binary from healthz_test.cpp/healthz_live_test.cpp/
/// healthz_timeout_test.cpp: a fourth distinct DbClientPtr is needed
/// because HealthzController caches it via call_once for the process
/// lifetime (see that comment in HealthzController.cpp), so none of these
/// DB-health states can safely share a process.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <drogon/HttpAppFramework.h>

#include <chrono>
#include <cstdlib>
#include <future>
#include <memory>
#include <thread>
#include <vector>

#include "assembled_server/HealthzController.h"

namespace {

constexpr uint16_t kHealthzRetentionTestPort = 18101;

// Nothing listens here -- see healthz_timeout_test.cpp for why a closed
// port is the deterministic, Docker-free way to model "configured but
// unreachable". Distinct port from that file's so the two can't collide if
// ctest ever runs them concurrently.
constexpr const char *kClosedPortDatabaseUrl = "postgresql://review:review@127.0.0.1:18191/review";

// Short so the test runs fast and deterministically.
constexpr const char *kTestHealthzTimeoutMs = "100";

// Comfortably above the 100ms timeout so a slow CI box can't flake, but far
// below Codex's 2-second "still retained" finding.
constexpr auto kRetentionCheckDelay = std::chrono::milliseconds(700);

/// Queues one `getHealthz` call on the running event loop, with a marker
/// object reachable only through the response callback's capture. Returns
/// a `weak_ptr` observing that marker so the caller can check, later, that
/// it was actually released.
std::weak_ptr<int> pollAndCaptureMarker(assembled_server::HealthzController &controller) {
    auto marker = std::make_shared<int>(1);
    std::weak_ptr<int> weak = marker;

    drogon::app().getLoop()->queueInLoop([&controller, marker]() {
        controller.getHealthz(drogon::HttpRequest::newHttpRequest(),
                              [marker](const drogon::HttpResponsePtr &) {});
    });

    return weak;
}

} // namespace

TEST_CASE("Repeated /healthz polls during a sustained outage release their "
          "captured response state shortly after each query timeout, and "
          "do not accumulate retained callbacks or pending queries") {
    setenv("HEALTHZ_TIMEOUT_MS", kTestHealthzTimeoutMs, 1);
    setenv("DATABASE_URL", kClosedPortDatabaseUrl, 1);

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kHealthzRetentionTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning())
        std::this_thread::sleep_for(std::chrono::milliseconds(5));

    assembled_server::HealthzController controller;

    // A load balancer's steady state during an outage: poll repeatedly,
    // each one capturing its own marker so accumulation across polls is
    // visible rather than masked by reusing a single shared marker.
    std::vector<std::weak_ptr<int>> polls;
    for (int i = 0; i < 5; ++i) {
        polls.push_back(pollAndCaptureMarker(controller));
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    std::promise<std::vector<bool>> expiredPromise;
    drogon::app().getLoop()->runAfter(std::chrono::duration<double>(kRetentionCheckDelay).count(),
                                      [&polls, &expiredPromise]() {
                                          std::vector<bool> expired;
                                          for (const auto &weak : polls)
                                              expired.push_back(weak.expired());
                                          expiredPromise.set_value(expired);
                                      });

    auto future = expiredPromise.get_future();
    REQUIRE(future.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
    auto expired = future.get();
    REQUIRE(expired.size() == polls.size());
    for (size_t i = 0; i < expired.size(); ++i) {
        CAPTURE(i);
        CHECK(expired[i]);
    }

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
