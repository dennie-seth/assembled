/// T-0046: GET /v1/notes — tag equality + ranking tests.
/// TDD: this file is committed BEFORE the implementation exists.
/// Tests: ordering by score (rating) DESC, limit clamping, empty-anchor
/// non-error, and HTTP integration for the NoteController.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <future>
#include <string>
#include <thread>
#include <vector>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/NoteController.h"
#include "assembled_server/NoteRepo.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Compile-time check: fetchRanked has no radius/coordinate parameter ────────

TEST_CASE("fetchRanked signature is (archetype_id, anchor_tag, limit) — no radius") {
    // If a radius parameter is ever added this cast will fail at compile time,
    // catching the regression immediately.
    using FetchRankedFn = std::vector<assembled_server::NoteRecord> (
        assembled_server::PgNoteRepo::*)(int16_t, int16_t, int);
    static_cast<void>(static_cast<FetchRankedFn>(&assembled_server::PgNoteRepo::fetchRanked));
    CHECK(true);
}

// ── Integration: ordering by rating (score) DESC ─────────────────────────────

TEST_CASE("fetchRanked returns notes ordered by rating DESC") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-tok-0046-rank') ON CONFLICT DO NOTHING");
    // Clean stale data from previous runs.
    db->getClient()->execSqlSync("DELETE FROM notes WHERE author_token = 'test-tok-0046-rank'");

    assembled_server::PgNoteRepo repo(db->getClient());

    // Template 6 = {ACTION}, slot_a = 21 (wait) — valid single-slot note.
    // Anchor: BRIDGE (3) / midpoint (2) — unused by other test suites.
    assembled_server::CreateNoteParams p;
    p.author_token = "test-tok-0046-rank";
    p.archetype_id = 3; // BRIDGE
    p.anchor_tag = 2;   // midpoint
    p.template_id = 6;
    p.slot_a = 21;

    const std::string id_low = repo.create(p);
    const std::string id_mid = repo.create(p);
    const std::string id_high = repo.create(p);

    // Set distinct ratings so ORDER BY rating DESC is deterministic.
    db->getClient()->execSqlSync("UPDATE notes SET rating = 1 WHERE id = $1::uuid", id_low);
    db->getClient()->execSqlSync("UPDATE notes SET rating = 3 WHERE id = $1::uuid", id_mid);
    db->getClient()->execSqlSync("UPDATE notes SET rating = 5 WHERE id = $1::uuid", id_high);

    const auto results = repo.fetchRanked(3, 2, 10);
    REQUIRE(results.size() == 3u);

    int pos_low = -1, pos_mid = -1, pos_high = -1;
    for (int i = 0; i < static_cast<int>(results.size()); ++i) {
        if (results[i].id == id_low)
            pos_low = i;
        if (results[i].id == id_mid)
            pos_mid = i;
        if (results[i].id == id_high)
            pos_high = i;
    }
    REQUIRE(pos_low != -1);
    REQUIRE(pos_mid != -1);
    REQUIRE(pos_high != -1);
    // Highest-rated note must appear first.
    CHECK(pos_high < pos_mid);
    CHECK(pos_mid < pos_low);
}

// ── Integration: limit clamped to kMaxNotesLimit ─────────────────────────────

TEST_CASE("fetchRanked clamps limit to kMaxNotesLimit") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());

    // Requesting far more than the allowed maximum must still obey the cap.
    const auto results = repo.fetchRanked(3, 2, 99999);
    CHECK(static_cast<int>(results.size()) <= assembled_server::kMaxNotesLimit);
}

// ── Integration: empty anchor is not an error ─────────────────────────────────

TEST_CASE("fetchRanked returns empty vector for anchor with no notes — not an error") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Guarantee the test anchor is empty (ARCHIVE/basement = 5/6).
    db->getClient()->execSqlSync("DELETE FROM notes WHERE archetype_id = 5 AND anchor_tag = 6");

    assembled_server::PgNoteRepo repo(db->getClient());

    std::vector<assembled_server::NoteRecord> results;
    CHECK_NOTHROW(results = repo.fetchRanked(5, 6, 10));
    CHECK(results.empty());
}

// ── Integration: GET /v1/notes HTTP ──────────────────────────────────────────

namespace {
constexpr uint16_t kNotesTestPort = 18083;
} // namespace

TEST_CASE("GET /v1/notes HTTP integration") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // Set up DB state before starting the server.
    {
        auto db = assembled_server::Database::fromEnv();
        REQUIRE(db.has_value());
        assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
        runner.applyPending(db->getClient());
        // Ensure (5, 6) is empty so the empty-anchor HTTP check is deterministic.
        db->getClient()->execSqlSync("DELETE FROM notes WHERE archetype_id = 5 AND anchor_tag = 6");
    }

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kNotesTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client =
        drogon::HttpClient::newHttpClient("http://127.0.0.1:" + std::to_string(kNotesTestPort));

    auto sendGet = [&](const std::string &query) -> std::pair<drogon::HttpStatusCode, Json::Value> {
        auto req = drogon::HttpRequest::newHttpRequest();
        req->setMethod(drogon::Get);
        req->setPath("/v1/notes?" + query);

        std::promise<std::pair<drogon::HttpStatusCode, Json::Value>> prom;
        client->sendRequest(req,
                            [&prom](drogon::ReqResult res, const drogon::HttpResponsePtr &resp) {
                                if (res == drogon::ReqResult::Ok && resp) {
                                    Json::Value body;
                                    auto json = resp->getJsonObject();
                                    if (json)
                                        body = *json;
                                    prom.set_value({resp->statusCode(), body});
                                } else {
                                    prom.set_value({drogon::k500InternalServerError, {}});
                                }
                            });
        auto fut = prom.get_future();
        REQUIRE(fut.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
        return fut.get();
    };

    // Valid request → 200 JSON array (ordering already proven by repo tests).
    {
        auto [code, body] = sendGet("archetype_id=3&anchor_tag=2&limit=5");
        CHECK(code == drogon::k200OK);
        REQUIRE(body.isArray());
    }

    // Empty anchor → 200 empty JSON array, not an error.
    {
        auto [code, body] = sendGet("archetype_id=5&anchor_tag=6&limit=5");
        CHECK(code == drogon::k200OK);
        REQUIRE(body.isArray());
        CHECK(body.size() == 0u);
    }

    // Missing archetype_id → 400.
    {
        auto [code, body] = sendGet("anchor_tag=2&limit=5");
        CHECK(code == drogon::k400BadRequest);
    }

    // Missing anchor_tag → 400.
    {
        auto [code, body] = sendGet("archetype_id=3&limit=5");
        CHECK(code == drogon::k400BadRequest);
    }

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
