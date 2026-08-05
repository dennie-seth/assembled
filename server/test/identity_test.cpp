/// T-0094: seed-phrase generation + token derivation tests.
/// TDD: this file is committed BEFORE the implementation exists.
/// All TEST_CASEs here reference headers that do not yet compile.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <chrono>
#include <future>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>

#include "assembled_server/Database.h"
#include "assembled_server/IdentityController.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/RateLimiter.h"
#include "assembled_server/SeedPhrase.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Unit: SeedPhrase ─────────────────────────────────────────────────────────

TEST_CASE("SeedPhrase wordlist has exactly 256 entries") {
    CHECK(assembled_server::SeedPhrase::wordlist().size() == 256u);
}

TEST_CASE("SeedPhrase::generate produces 8 words all from the wordlist") {
    const auto &wl = assembled_server::SeedPhrase::wordlist();
    const std::set<std::string> valid(wl.begin(), wl.end());

    const std::string phrase = assembled_server::SeedPhrase::generate();

    std::istringstream ss(phrase);
    std::vector<std::string> words;
    std::string w;
    while (ss >> w) {
        words.push_back(w);
        CHECK(valid.count(w) == 1u);
    }
    CHECK(words.size() == 8u);
}

TEST_CASE("SeedPhrase::generate produces varied output across calls") {
    std::set<std::string> seen;
    for (int i = 0; i < 5; ++i) {
        seen.insert(assembled_server::SeedPhrase::generate());
    }
    // With 64-bit entropy collisions across 5 independent calls are
    // astronomically unlikely; a hit here almost certainly means a broken RNG.
    CHECK(seen.size() > 1u);
}

TEST_CASE("SeedPhrase::deriveToken is deterministic") {
    const std::string phrase = "abandon ability able about above absent absorb abstract";
    const std::string secret = "test-secret";

    const std::string t1 = assembled_server::SeedPhrase::deriveToken(secret, phrase);
    const std::string t2 = assembled_server::SeedPhrase::deriveToken(secret, phrase);

    CHECK(!t1.empty());
    CHECK(t1 == t2);
}

TEST_CASE("SeedPhrase::deriveToken differs for different phrases") {
    const std::string secret = "test-secret";
    const std::string p1 = "abandon ability able about above absent absorb abstract";
    const std::string p2 = "account accuse achieve acid acoustic acquire across act";

    CHECK(assembled_server::SeedPhrase::deriveToken(secret, p1) !=
          assembled_server::SeedPhrase::deriveToken(secret, p2));
}

TEST_CASE("SeedPhrase::deriveToken output is not the phrase itself") {
    const std::string phrase = "abandon ability able about above absent absorb abstract";
    const std::string token = assembled_server::SeedPhrase::deriveToken("test-secret", phrase);
    CHECK(token != phrase);
}

// ── Unit: RateLimiter ────────────────────────────────────────────────────────

TEST_CASE("RateLimiter allows requests within the limit") {
    assembled_server::RateLimiter limiter(3, std::chrono::seconds(60));
    CHECK(limiter.allow("1.2.3.4") == true);
    CHECK(limiter.allow("1.2.3.4") == true);
    CHECK(limiter.allow("1.2.3.4") == true);
}

TEST_CASE("RateLimiter blocks the request that exceeds the limit") {
    assembled_server::RateLimiter limiter(3, std::chrono::seconds(60));
    limiter.allow("1.2.3.4");
    limiter.allow("1.2.3.4");
    limiter.allow("1.2.3.4");
    CHECK(limiter.allow("1.2.3.4") == false);
}

TEST_CASE("RateLimiter tracks limits per-IP independently") {
    assembled_server::RateLimiter limiter(1, std::chrono::seconds(60));
    CHECK(limiter.allow("10.0.0.1") == true);
    CHECK(limiter.allow("10.0.0.1") == false);
    // A different IP starts with a fresh counter.
    CHECK(limiter.allow("10.0.0.2") == true);
}

// ── Integration: identity table schema check (DB, no HTTP) ───────────────────

TEST_CASE("identity table has no phrase column" * doctest::skip(!std::getenv("DATABASE_URL"))) {
    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // The UGC invariant: no column that can hold a phrase must exist.
    // Verify via information_schema -- this is the schema-level proof, not
    // just a documentation claim.
    auto result = db->getClient()->execSqlSync(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'identity' AND column_name LIKE '%phrase%'");
    CHECK(result.size() == 0);
}

// ── Integration: POST /v1/identity HTTP (DB + server) ─────────────────────────

namespace {
constexpr uint16_t kIdentityTestPort = 18082;
} // namespace

TEST_CASE("POST /v1/identity HTTP integration" * doctest::skip(!std::getenv("DATABASE_URL"))) {
    // Rate limit = 3 so we can confirm three successes then a 429.
    // Must be configured BEFORE the server thread starts.
    assembled_server::IdentityController::setRateLimiterForTesting(3, std::chrono::seconds(60));

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kIdentityTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client =
        drogon::HttpClient::newHttpClient("http://127.0.0.1:" + std::to_string(kIdentityTestPort));

    // Returns {status_code, phrase_field_value}.
    auto sendPost = [&]() -> std::pair<drogon::HttpStatusCode, std::string> {
        auto req = drogon::HttpRequest::newHttpRequest();
        req->setMethod(drogon::Post);
        req->setPath("/v1/identity");

        std::promise<std::pair<drogon::HttpStatusCode, std::string>> p;
        client->sendRequest(req, [&p](drogon::ReqResult res, const drogon::HttpResponsePtr &resp) {
            if (res == drogon::ReqResult::Ok && resp) {
                std::string phrase;
                auto json = resp->getJsonObject();
                if (json && json->isMember("phrase")) {
                    phrase = (*json)["phrase"].asString();
                }
                p.set_value({resp->statusCode(), phrase});
            } else {
                p.set_value({drogon::k500InternalServerError, ""});
            }
        });
        auto fut = p.get_future();
        REQUIRE(fut.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
        return fut.get();
    };

    // First request: 200, non-empty phrase returned exactly once.
    {
        auto [code, phrase] = sendPost();
        CHECK(code == drogon::k200OK);
        CHECK(!phrase.empty());
        // Phrase must be 8 space-separated words.
        std::istringstream ss(phrase);
        std::vector<std::string> words;
        std::string w;
        while (ss >> w) {
            words.push_back(w);
        }
        CHECK(words.size() == 8u);
    }

    // Second request: 200, also succeeds (different phrase each time).
    {
        auto [code, phrase] = sendPost();
        CHECK(code == drogon::k200OK);
        CHECK(!phrase.empty());
    }

    // Third request: 200 (still within limit of 3).
    {
        auto [code, phrase] = sendPost();
        CHECK(code == drogon::k200OK);
    }

    // Fourth request: rate-limited → 429.
    {
        auto [code, phrase] = sendPost();
        CHECK(code == drogon::k429TooManyRequests);
        CHECK(phrase.empty()); // no phrase on 429
    }

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
