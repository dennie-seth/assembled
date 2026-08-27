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

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/NoteRepo.h"

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

    // ── Teardown ──────────────────────────────────────────────────────────────
    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
