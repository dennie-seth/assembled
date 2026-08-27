/// T-0207: Two clients, one note — proof-of-play gating + bleed slowdown.
///
/// Scenario (HANDOFF §20-d2):
///   1. Client A composes a note at an anchor tag.
///   2. Client B, from a different universe but the same archetype, reads
///      and rates it.
///   3. A voter who has never actually played the note's archetype cannot
///      rate it (02-notes-system.md §7 proof-of-play requirement) — the vote
///      is rejected and A's note is untouched.
///   4. A voter who *has* proof-of-play may rate; a genuine +1 slows A's
///      held-item bleed timer (02-notes-system.md §7,
///      07-items-economy.md §5), clamped at the full held-bleed duration so
///      a single note cannot bank bleed time indefinitely.
///
/// TDD: this file is committed BEFORE the implementation exists. All
/// TEST_CASEs gate on DATABASE_URL; without a live Postgres container they
/// are skipped and the build-only CI path stays green.
///
/// Test-ID reservations (do not reuse in other test files):
///   item type   : 207
///   archetype   : 3 (BRIDGE), anchor tag 1 (approach)
///   tokens      : "test-t207-alice" (author), "test-t207-bob" (has proof-of-play),
///                 "test-t207-carol" (no proof-of-play)
///   HTTP port   : 18095

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

constexpr int16_t kTypeId = 207;      ///< T-0207 exclusive item type ID.
constexpr int16_t kArchetype = 3;     ///< BRIDGE.
constexpr int16_t kAnchorTag = 1;     ///< approach.
constexpr uint16_t kHttpPort = 18095; ///< T-0207 exclusive HTTP test port.

const std::string kAlice = "test-t207-alice"; ///< Client A: note author, item holder.
const std::string kBob = "test-t207-bob";     ///< Client B: proof-of-play satisfied.
const std::string kCarol = "test-t207-carol"; ///< No proof-of-play for kArchetype.

/// Ensures identity + a clean archetype_seen/notes/item_instance slate for
/// this suite's tokens, then seeds bob's proof-of-play for kArchetype.
void seedFixture(const drogon::orm::DbClientPtr &db) {
    for (const auto &tok : {kAlice, kBob, kCarol}) {
        db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT DO NOTHING", tok);
    }
    db->execSqlSync("INSERT INTO item_type (id, rarity) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING",
                    kTypeId);

    db->execSqlSync("DELETE FROM notes WHERE author_token = $1", kAlice);
    db->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);
    db->execSqlSync("DELETE FROM archetype_seen WHERE token IN ($1, $2) AND archetype_id = $3",
                    kBob, kCarol, kArchetype);

    // Only bob has proof-of-play — carol has never assembled a run
    // containing kArchetype.
    db->execSqlSync("INSERT INTO archetype_seen (token, archetype_id) VALUES ($1, $2)", kBob,
                    kArchetype);
}

/// Creates a note authored by alice at (kArchetype, kAnchorTag).
std::string createAliceNote(assembled_server::PgNoteRepo &repo) {
    assembled_server::CreateNoteParams p;
    p.author_token = kAlice;
    p.archetype_id = kArchetype;
    p.anchor_tag = kAnchorTag;
    p.template_id = 6; // {ACTION}
    p.slot_a = 21;      // wait
    return repo.create(p);
}

/// Seeds an item held by alice with the given bleed_at offset from now, and
/// returns its UUID.
std::string seedAliceItem(const drogon::orm::DbClientPtr &db, const std::string &interval) {
    auto r = db->execSqlSync("INSERT INTO item_instance (type_id, holder, bleed_at) "
                             "VALUES ($1, $2, now() + INTERVAL '" +
                                 interval + "') RETURNING id::text",
                             kTypeId, kAlice);
    return r[0][0].as<std::string>();
}

/// Seconds remaining until item_id's bleed_at, per the DB clock.
double secondsUntilBleed(const drogon::orm::DbClientPtr &db, const std::string &item_id) {
    auto r = db->execSqlSync(
        "SELECT EXTRACT(EPOCH FROM (bleed_at - now())) AS s FROM item_instance WHERE id = $1::uuid",
        item_id);
    REQUIRE(!r.empty());
    return r[0]["s"].as<double>();
}

} // namespace

// ── Integration: proof-of-play blocks an unproven voter ───────────────────────

TEST_CASE("PgNoteRepo rate — proof-of-play blocks a voter who never played the archetype") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    seedFixture(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());
    const std::string note_id = createAliceNote(repo);

    // Carol has no archetype_seen row for kArchetype — the vote must be
    // rejected, and the note must be untouched.
    const auto result = repo.rate(note_id, kCarol, 1);
    CHECK(result.error == assembled_server::RateError::ProofOfPlayMissing);

    const auto notes = repo.fetch(kArchetype, kAnchorTag);
    bool found = false;
    for (const auto &n : notes) {
        if (n.id == note_id) {
            found = true;
            CHECK(n.rating == 0);
        }
    }
    CHECK(found);

    const auto voteRows = db->getClient()->execSqlSync(
        "SELECT COUNT(*) FROM note_votes WHERE note_id = $1::uuid AND voter = $2", note_id,
        kCarol);
    CHECK(voteRows[0][0].as<int>() == 0);
}

// ── Integration: proof-of-play satisfied allows the vote ──────────────────────

TEST_CASE("PgNoteRepo rate — a voter with proof-of-play may rate") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    seedFixture(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());
    const std::string note_id = createAliceNote(repo);

    const auto result = repo.rate(note_id, kBob, 1);
    CHECK(result.error == assembled_server::RateError::None);

    const auto notes = repo.fetch(kArchetype, kAnchorTag);
    for (const auto &n : notes) {
        if (n.id == note_id)
            CHECK(n.rating == 1);
    }
}

// ── Integration: a qualifying +1 vote slows the author's held-item bleed ──────

TEST_CASE("PgNoteRepo rate — a proven +1 vote extends the author's held-item bleed") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    seedFixture(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());
    const std::string note_id = createAliceNote(repo);
    const std::string item_id = seedAliceItem(db->getClient(), "5 minutes");

    const double before = secondsUntilBleed(db->getClient(), item_id);

    const auto result = repo.rate(note_id, kBob, 1);
    REQUIRE(result.error == assembled_server::RateError::None);

    const double after = secondsUntilBleed(db->getClient(), item_id);

    // Extended, and by roughly the fixed bonus (10 minutes) — well short of
    // the 90-minute ceiling from this starting point.
    CHECK(after > before);
    CHECK(after > before + 9 * 60);
    CHECK(after < before + 11 * 60);
}

// ── Integration: bleed extension is clamped at the full-duration ceiling ──────

TEST_CASE("PgNoteRepo rate — held-bleed bonus is clamped at the ceiling") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    seedFixture(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());
    const std::string note_id = createAliceNote(repo);
    // Already close to the 90-minute ceiling — a naive +10m bonus would push
    // this past it.
    const std::string item_id = seedAliceItem(db->getClient(), "89 minutes");

    const auto result = repo.rate(note_id, kBob, 1);
    REQUIRE(result.error == assembled_server::RateError::None);

    const double after = secondsUntilBleed(db->getClient(), item_id);

    // Clamped to (approximately) 90 minutes from now, not 99.
    CHECK(after <= 90 * 60 + 5);
    CHECK(after > 89 * 60);
}

// ── Integration: a rejected vote never touches held bleed ─────────────────────

TEST_CASE("PgNoteRepo rate — proof-of-play rejection does not extend held bleed") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    seedFixture(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());
    const std::string note_id = createAliceNote(repo);
    const std::string item_id = seedAliceItem(db->getClient(), "5 minutes");

    const double before = secondsUntilBleed(db->getClient(), item_id);

    const auto result = repo.rate(note_id, kCarol, 1);
    REQUIRE(result.error == assembled_server::RateError::ProofOfPlayMissing);

    const double after = secondsUntilBleed(db->getClient(), item_id);
    CHECK(after == doctest::Approx(before).epsilon(0.02));
}

// ── Integration: a -1 vote never extends held bleed, even with proof-of-play ──

TEST_CASE("PgNoteRepo rate — a downvote does not extend held bleed") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    seedFixture(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());
    const std::string note_id = createAliceNote(repo);
    const std::string item_id = seedAliceItem(db->getClient(), "5 minutes");

    const double before = secondsUntilBleed(db->getClient(), item_id);

    const auto result = repo.rate(note_id, kBob, -1);
    REQUIRE(result.error == assembled_server::RateError::None);

    const double after = secondsUntilBleed(db->getClient(), item_id);
    CHECK(after == doctest::Approx(before).epsilon(0.02));
}

// ── Integration: POST /v1/notes/{id}/rate HTTP — 403 without proof-of-play ────

TEST_CASE("POST /v1/notes/{id}/rate — 403 NO_PROOF_OF_PLAY without proof-of-play, 200 with it") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    seedFixture(db->getClient());

    assembled_server::PgNoteRepo repo(db->getClient());
    const std::string note_id = createAliceNote(repo);

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kHttpPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client =
        drogon::HttpClient::newHttpClient("http://127.0.0.1:" + std::to_string(kHttpPort));

    auto sendRate =
        [&](const std::string &token) -> std::pair<drogon::HttpStatusCode, Json::Value> {
        Json::Value body;
        body["val"] = 1;
        auto req = drogon::HttpRequest::newHttpJsonRequest(body);
        req->setMethod(drogon::Post);
        req->setPath("/v1/notes/" + note_id + "/rate");
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

    // Carol has no proof-of-play for kArchetype.
    {
        auto [code, j] = sendRate(kCarol);
        CHECK(code == drogon::k403Forbidden);
        CHECK(j["error"].asInt() == 4001);
    }

    // Bob does.
    {
        auto [code, j] = sendRate(kBob);
        CHECK(code == drogon::k200OK);
    }

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
