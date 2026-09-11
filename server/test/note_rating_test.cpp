/// T-0047: Note rating — one vote per player.
/// TDD: this file is committed BEFORE the implementation exists.
/// All TEST_CASEs gate on DATABASE_URL; without a live Postgres container
/// they are skipped and the build-only CI path stays green.
///
/// Acceptance criteria exercised:
///   - Idempotent: submitting the same (note_id, voter, val) twice is a no-op
///     (rating unchanged, exactly one row in note_votes).
///   - Vote change: a voter who changes their value overwrites the existing row
///     rather than adding a second one.
///   - Score accuracy: notes.rating reflects SUM(val) over note_votes correctly
///     (multi-voter scenario; also verifies vote-change updates the tally).
///   - HTTP: POST /v1/notes/{id}/rate returns 200 for valid calls, 400 for an
///     illegal val, and 401 when the Authorization header is absent.
///
/// T-0049: per-token rate limiting on the note-rating route group.
///   5001 RATE_LIMITED          — burst above the configured per-token
///                                ceiling is rejected; steady-state usage
///                                under the ceiling is unaffected
///                                (03-net-protocol.md §7).

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <atomic>
#include <barrier>
#include <chrono>
#include <cstdlib>
#include <future>
#include <string>
#include <thread>
#include <vector>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>
#include <json/value.h>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/NoteController.h"
#include "assembled_server/NoteRepo.h"
#include "assembled_server/RateLimiter.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

namespace {
constexpr uint16_t kNoteRatingTestPort = 18091;
} // namespace

// ── Integration: idempotent on same value ─────────────────────────────────────

TEST_CASE("PgNoteRepo rate — idempotent on same value") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Seed test identity and clean any leftover notes.
    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-tok-0047-idem') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync("DELETE FROM notes WHERE author_token = 'test-tok-0047-idem'");
    // Proof-of-play (T-0207): rate() now requires an archetype_seen row.
    db->getClient()->execSqlSync(
        "INSERT INTO archetype_seen (token, archetype_id) VALUES ('test-tok-0047-idem', 1) "
        "ON CONFLICT DO NOTHING");

    assembled_server::PgNoteRepo repo(db->getClient());

    // Create a note at HOSPITAL/basement (1, 4) — unique per this suite.
    assembled_server::CreateNoteParams p;
    p.author_token = "test-tok-0047-idem";
    p.archetype_id = 1; // HOSPITAL
    p.anchor_tag = 4;   // basement
    p.template_id = 6;  // {ACTION}
    p.slot_a = 21;      // wait

    const std::string note_id = repo.create(p);

    // First +1 vote.
    repo.rate(note_id, "test-tok-0047-idem", 1);
    int32_t rating_after_first = 0;
    {
        const auto notes = repo.fetch(1, 4);
        for (const auto &n : notes) {
            if (n.id == note_id)
                rating_after_first = n.rating;
        }
    }
    CHECK(rating_after_first == 1);

    // Second +1 vote by the same voter — must be a no-op.
    repo.rate(note_id, "test-tok-0047-idem", 1);
    int32_t rating_after_second = 0;
    {
        const auto notes = repo.fetch(1, 4);
        for (const auto &n : notes) {
            if (n.id == note_id)
                rating_after_second = n.rating;
        }
    }
    CHECK(rating_after_second == rating_after_first);

    // Exactly one row in note_votes, not two.
    const auto rows =
        db->getClient()->execSqlSync("SELECT COUNT(*) FROM note_votes "
                                     "WHERE note_id = $1::uuid AND voter = 'test-tok-0047-idem'",
                                     note_id);
    CHECK(rows[0][0].as<int>() == 1);
}

// ── Integration: changing vote overwrites, not inserts ────────────────────────

TEST_CASE("PgNoteRepo rate — changing vote overwrites, does not add a second row") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-tok-0047-chg') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync("DELETE FROM notes WHERE author_token = 'test-tok-0047-chg'");
    // Proof-of-play (T-0207): rate() now requires an archetype_seen row.
    db->getClient()->execSqlSync(
        "INSERT INTO archetype_seen (token, archetype_id) VALUES ('test-tok-0047-chg', 1) "
        "ON CONFLICT DO NOTHING");

    assembled_server::PgNoteRepo repo(db->getClient());

    // HOSPITAL/roof (1, 5) — unique per this suite.
    assembled_server::CreateNoteParams p;
    p.author_token = "test-tok-0047-chg";
    p.archetype_id = 1;
    p.anchor_tag = 5; // roof
    p.template_id = 6;
    p.slot_a = 21;

    const std::string note_id = repo.create(p);

    // +1 then -1 from the same voter.
    repo.rate(note_id, "test-tok-0047-chg", 1);
    repo.rate(note_id, "test-tok-0047-chg", -1);

    // Net rating should be -1 (vote was overwritten, not added).
    int32_t rating = 0;
    {
        const auto notes = repo.fetch(1, 5);
        for (const auto &n : notes) {
            if (n.id == note_id)
                rating = n.rating;
        }
    }
    CHECK(rating == -1);

    // Still only one row in note_votes.
    const auto rows =
        db->getClient()->execSqlSync("SELECT COUNT(*) FROM note_votes "
                                     "WHERE note_id = $1::uuid AND voter = 'test-tok-0047-chg'",
                                     note_id);
    CHECK(rows[0][0].as<int>() == 1);
}

// ── Integration: score reflects tally across multiple voters ──────────────────

TEST_CASE("PgNoteRepo rate — score reflects current tally correctly") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-tok-0047-ta') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-tok-0047-tb') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync("DELETE FROM notes WHERE author_token = 'test-tok-0047-ta'");
    // Proof-of-play (T-0207): rate() now requires an archetype_seen row.
    db->getClient()->execSqlSync(
        "INSERT INTO archetype_seen (token, archetype_id) VALUES "
        "('test-tok-0047-ta', 2), ('test-tok-0047-tb', 2) ON CONFLICT DO NOTHING");

    assembled_server::PgNoteRepo repo(db->getClient());

    // STATION/waiting_room (2, 2) — unique per this suite.
    assembled_server::CreateNoteParams p;
    p.author_token = "test-tok-0047-ta";
    p.archetype_id = 2; // STATION
    p.anchor_tag = 2;   // waiting_room
    p.template_id = 6;
    p.slot_a = 21;

    const std::string note_id = repo.create(p);

    // Two upvotes: +1 from ta, +1 from tb → rating = +2.
    repo.rate(note_id, "test-tok-0047-ta", 1);
    repo.rate(note_id, "test-tok-0047-tb", 1);
    {
        const auto notes = repo.fetch(2, 2);
        for (const auto &n : notes) {
            if (n.id == note_id)
                CHECK(n.rating == 2);
        }
    }

    // ta changes to -1: ta=-1, tb=+1 → rating = 0.
    repo.rate(note_id, "test-tok-0047-ta", -1);
    {
        const auto notes = repo.fetch(2, 2);
        for (const auto &n : notes) {
            if (n.id == note_id)
                CHECK(n.rating == 0);
        }
    }
}

// ── Integration: POST /v1/notes/{id}/rate HTTP ────────────────────────────────

TEST_CASE("POST /v1/notes/{id}/rate HTTP integration") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // ── DB setup ──────────────────────────────────────────────────────────────
    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-tok-0047-http') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync("DELETE FROM notes WHERE author_token = 'test-tok-0047-http'");
    // Proof-of-play (T-0207): rate() now requires an archetype_seen row.
    db->getClient()->execSqlSync(
        "INSERT INTO archetype_seen (token, archetype_id) VALUES ('test-tok-0047-http', 2) "
        "ON CONFLICT DO NOTHING");

    // Second identity, dedicated to the rate-limit burst test below.
    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-tok-0047-burst') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync(
        "INSERT INTO archetype_seen (token, archetype_id) VALUES ('test-tok-0047-burst', 2) "
        "ON CONFLICT DO NOTHING");

    // T-0049: configure a small per-token note-rating ceiling for this run so
    // the burst test below can actually trip it over HTTP. Must happen
    // before drogon::app().run() starts (see setRatingRateLimiterForTesting
    // doc).
    assembled_server::NoteController::setRatingRateLimiterForTesting(6, std::chrono::seconds(60));

    // Create a note to rate via HTTP. STATION/tracks (2, 3) — unique per suite.
    assembled_server::PgNoteRepo repo(db->getClient());
    assembled_server::CreateNoteParams p;
    p.author_token = "test-tok-0047-http";
    p.archetype_id = 2;
    p.anchor_tag = 3; // tracks
    p.template_id = 6;
    p.slot_a = 21;
    const std::string note_id = repo.create(p);

    // ── Server ────────────────────────────────────────────────────────────────
    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kNoteRatingTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client = drogon::HttpClient::newHttpClient("http://127.0.0.1:" +
                                                    std::to_string(kNoteRatingTestPort));

    auto sendRate =
        [&](const std::string &id, int val,
            const std::string &token) -> std::pair<drogon::HttpStatusCode, Json::Value> {
        Json::Value body;
        body["val"] = val;
        auto req = drogon::HttpRequest::newHttpJsonRequest(body);
        req->setMethod(drogon::Post);
        req->setPath("/v1/notes/" + id + "/rate");
        if (!token.empty())
            req->addHeader("Authorization", "Bearer " + token);

        std::promise<std::pair<drogon::HttpStatusCode, Json::Value>> prom;
        client->sendRequest(req,
                            [&prom](drogon::ReqResult res, const drogon::HttpResponsePtr &resp) {
                                Json::Value j;
                                if (res == drogon::ReqResult::Ok && resp) {
                                    auto json = resp->getJsonObject();
                                    if (json)
                                        j = *json;
                                    prom.set_value({resp->statusCode(), j});
                                } else {
                                    prom.set_value({drogon::k500InternalServerError, j});
                                }
                            });
        auto fut = prom.get_future();
        REQUIRE(fut.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
        return fut.get();
    };

    // Valid +1 vote → 200.
    {
        auto [code, j] = sendRate(note_id, 1, "test-tok-0047-http");
        CHECK(code == drogon::k200OK);
    }

    // Same voter, same value again (idempotent) → 200.
    {
        auto [code, j] = sendRate(note_id, 1, "test-tok-0047-http");
        CHECK(code == drogon::k200OK);
    }

    // Same voter, change to -1 → 200.
    {
        auto [code, j] = sendRate(note_id, -1, "test-tok-0047-http");
        CHECK(code == drogon::k200OK);
    }

    // Invalid val (0) → 400.
    {
        auto [code, j] = sendRate(note_id, 0, "test-tok-0047-http");
        CHECK(code == drogon::k400BadRequest);
    }

    // No Authorization header → 401.
    {
        auto [code, j] = sendRate(note_id, 1, "");
        CHECK(code == drogon::k401Unauthorized);
    }

    // Burst above the per-token note-rating rate limit → 429. The limiter
    // was configured above to 6 requests / 60 s. Uses a dedicated token so
    // this burst doesn't interact with the budget 'test-tok-0047-http'
    // already spent in the sub-tests above.
    {
        for (int i = 0; i < 6; ++i) {
            auto [code, j] = sendRate(note_id, 1, "test-tok-0047-burst");
            CHECK(code == drogon::k200OK);
        }

        // Seventh request in the same window exceeds the configured ceiling.
        auto [code, j] = sendRate(note_id, 1, "test-tok-0047-burst");
        CHECK(code == drogon::k429TooManyRequests);
        CHECK(j["error"].asInt() == 5001);
    }

    // A different token's steady-state usage is unaffected: 'test-tok-0047-http'
    // has only spent 4 of its 6-request budget in the sub-tests above; the
    // burst against a different token above must not affect it.
    {
        auto [code, j] = sendRate(note_id, 1, "test-tok-0047-http");
        CHECK(code == drogon::k200OK);
    }

    // ── Teardown ──────────────────────────────────────────────────────────────
    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}

// ── Note-rating rate limit: RateLimiter class, white-box ──────────────────────
//
// The T-0049 acceptance criteria (burst rejected with 429, steady-state
// unaffected) are verified over real HTTP in the integration suite above.
// drogon::app() is a process-global singleton that can only run once per
// binary, so it can't host a second HTTP run here; these cases give
// supplementary white-box coverage of NoteController::ratingRateLimiter()'s
// bucket-isolation behavior directly.

TEST_CASE("Note-rating rate limiter allows steady-state usage under the limit") {
    assembled_server::NoteController::setRatingRateLimiterForTesting(3, std::chrono::seconds(60));
    assembled_server::RateLimiter &limiter =
        assembled_server::NoteController::ratingRateLimiterForTesting();

    const std::string key = "note-rate-tok-steady";
    CHECK(limiter.allow(key) == true);
    CHECK(limiter.allow(key) == true);
    CHECK(limiter.allow(key) == true);
}

TEST_CASE("Note-rating rate limiter rejects a burst above the configured limit") {
    assembled_server::NoteController::setRatingRateLimiterForTesting(2, std::chrono::seconds(60));
    assembled_server::RateLimiter &limiter =
        assembled_server::NoteController::ratingRateLimiterForTesting();

    const std::string key = "note-rate-tok-burst";
    CHECK(limiter.allow(key) == true);
    CHECK(limiter.allow(key) == true);
    CHECK(limiter.allow(key) == false); // third request in the same window is rejected

    // A different token's bucket is independent of tok-burst's usage.
    CHECK(limiter.allow("note-rate-tok-other") == true);
}

// ── T-0049 fix round: concurrent first-access construction race ──────────────
//
// Codex PR review (2026-09-11, #373 P2): NoteController::ratingRateLimiter()
// checked its shared static unique_ptr and assigned it with no
// synchronization -- the mutex inside RateLimiter::allow() protects bucket
// data only, not construction/replacement of the limiter object itself.
// Concurrent first requests on separate HTTP worker threads could race on
// the pointer. This fires kThreads genuinely concurrent "first" requests at
// a deliberately-reset (uninitialized, never pre-constructed) limiter and
// asserts exactly the configured ceiling is admitted and the remainder are
// rejected with 429, which only holds if construction is synchronized.
TEST_CASE("Rating rate limiter: concurrent first requests race safely on construction") {
    // resetRatingRateLimiterForTesting() forces the pointer back to nullptr.
    // setRatingRateLimiterForTesting() (used elsewhere in this file) instead
    // pre-constructs a RateLimiter directly, which would defeat the point of
    // this test -- there would be nothing left to race on.
    assembled_server::NoteController::resetRatingRateLimiterForTesting();

    // Configure the lazy-construction path via env vars, the same way
    // production does. Save/restore so this doesn't leak into other
    // TEST_CASEs sharing this binary.
    const char *prevMaxRaw = std::getenv("NOTE_RATING_RATE_LIMIT_MAX");
    const bool hadPrevMax = prevMaxRaw != nullptr;
    const std::string prevMax = hadPrevMax ? prevMaxRaw : "";
    const char *prevWinRaw = std::getenv("NOTE_RATING_RATE_LIMIT_WINDOW_SEC");
    const bool hadPrevWin = prevWinRaw != nullptr;
    const std::string prevWin = hadPrevWin ? prevWinRaw : "";
    const char *prevDbRaw = std::getenv("DATABASE_URL");
    const bool hadPrevDb = prevDbRaw != nullptr;
    const std::string prevDb = hadPrevDb ? prevDbRaw : "";

    constexpr int kLimit = 1;
    constexpr int kThreads = 16;
    setenv("NOTE_RATING_RATE_LIMIT_MAX", "1", 1);
    setenv("NOTE_RATING_RATE_LIMIT_WINDOW_SEC", "60", 1);
    // Rejected (429) requests never reach the DB client lookup (the rate
    // check runs first in rateNote()); the one admitted request would, but
    // with DATABASE_URL unset it short-circuits to 503 instead of racing a
    // detached worker thread against this TEST_CASE's teardown.
    unsetenv("DATABASE_URL");

    assembled_server::NoteController controller;
    std::barrier start(kThreads);
    std::atomic<int> admitted{0};
    std::atomic<int> rejected{0};

    std::vector<std::thread> threads;
    threads.reserve(kThreads);
    for (int i = 0; i < kThreads; ++i) {
        threads.emplace_back([&]() {
            Json::Value body;
            body["val"] = 1;
            auto req = drogon::HttpRequest::newHttpJsonRequest(body);
            req->addHeader("Authorization", "Bearer rate-limiter-race-token");
            start.arrive_and_wait();
            controller.rateNote(
                req,
                [&](const drogon::HttpResponsePtr &resp) {
                    if (resp->statusCode() == drogon::k429TooManyRequests)
                        ++rejected;
                    else
                        ++admitted;
                },
                "00000000-0000-0000-0000-000000000001");
        });
    }
    for (auto &t : threads)
        t.join();

    if (hadPrevMax)
        setenv("NOTE_RATING_RATE_LIMIT_MAX", prevMax.c_str(), 1);
    else
        unsetenv("NOTE_RATING_RATE_LIMIT_MAX");
    if (hadPrevWin)
        setenv("NOTE_RATING_RATE_LIMIT_WINDOW_SEC", prevWin.c_str(), 1);
    else
        unsetenv("NOTE_RATING_RATE_LIMIT_WINDOW_SEC");
    if (hadPrevDb)
        setenv("DATABASE_URL", prevDb.c_str(), 1);
    else
        unsetenv("DATABASE_URL");

    CHECK(admitted.load() == kLimit);
    CHECK(rejected.load() == kThreads - kLimit);
}
