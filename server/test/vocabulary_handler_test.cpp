/// T-0364: GET /v1/vocabulary HTTP handler tests.
/// TDD: this file is committed BEFORE the implementation exists.
/// All tests are gated on DATABASE_URL; without it the server cannot
/// start in a useful state and the whole case is skipped.
///
/// Acceptance criteria exercised (tasks/T-0364.md):
///   - authenticates with the same bearer identity token the note routes
///     use, returns 200 JSON array of word ids (03-net-protocol.md §5).
///   - the returned set is exactly what POST /v1/notes accepts for that
///     token: every returned id is accepted in a note slot, and a word
///     absent from the list is rejected 403 / 4002.
///   - a token with nothing unlocked gets 200 [] — no fallback tier.
///   - missing/invalid token gets the same auth error as the note routes.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <chrono>
#include <future>
#include <string>
#include <thread>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>
#include <json/value.h>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "shared/note_templates.hpp"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

namespace {
constexpr uint16_t kVocabularyTestPort = 18096;

/// Finds a single-slot template whose slot_a_category matches @p category.
/// Returns -1 if none exists (fails the calling test — every shipped word
/// category has at least one single-slot template today).
int16_t findSingleSlotTemplateFor(int16_t category) {
    for (const auto &t : assembled::kTemplates) {
        if (t.slots == 1 && t.slot_a_category == category) {
            return t.id;
        }
    }
    return -1;
}

/// Looks up a word's category by id. Returns 0 (no category) if unknown.
int16_t categoryOf(int16_t word_id) {
    for (const auto &w : assembled::kWords) {
        if (w.id == word_id) {
            return static_cast<int16_t>(w.category);
        }
    }
    return 0;
}

} // namespace

// ── Shared HTTP helpers ────────────────────────────────────────────────────────

static std::pair<drogon::HttpStatusCode, Json::Value>
sendVocabularyGet(const drogon::HttpClientPtr &client, const std::string &token,
                  bool sendAuthHeader = true) {
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(drogon::Get);
    req->setPath("/v1/vocabulary");
    if (sendAuthHeader) {
        req->addHeader("Authorization", "Bearer " + token);
    }

    std::promise<std::pair<drogon::HttpStatusCode, Json::Value>> p;
    client->sendRequest(req, [&p](drogon::ReqResult res, const drogon::HttpResponsePtr &resp) {
        Json::Value j;
        if (res == drogon::ReqResult::Ok && resp) {
            auto json = resp->getJsonObject();
            if (json)
                j = *json;
            p.set_value({resp->statusCode(), j});
        } else {
            p.set_value({drogon::k500InternalServerError, j});
        }
    });

    auto fut = p.get_future();
    REQUIRE(fut.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
    return fut.get();
}

static std::pair<drogon::HttpStatusCode, Json::Value>
sendNotePostRaw(const drogon::HttpClientPtr &client, const Json::Value &body,
                const std::string &token) {
    auto req = drogon::HttpRequest::newHttpJsonRequest(body);
    req->setMethod(drogon::Post);
    req->setPath("/v1/notes");
    req->addHeader("Authorization", "Bearer " + token);

    std::promise<std::pair<drogon::HttpStatusCode, Json::Value>> p;
    client->sendRequest(req, [&p](drogon::ReqResult res, const drogon::HttpResponsePtr &resp) {
        Json::Value j;
        if (res == drogon::ReqResult::Ok && resp) {
            auto json = resp->getJsonObject();
            if (json)
                j = *json;
            p.set_value({resp->statusCode(), j});
        } else {
            p.set_value({drogon::k500InternalServerError, j});
        }
    });

    auto fut = p.get_future();
    REQUIRE(fut.wait_for(std::chrono::seconds(5)) == std::future_status::ready);
    return fut.get();
}

// ── Integration suite ─────────────────────────────────────────────────────────

TEST_CASE("GET /v1/vocabulary HTTP integration") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // ── DB setup ──────────────────────────────────────────────────────────
    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Three test identities:
    //   "test-token-vocab-populated" — has words 7 (DIRECTION) and 21 (ACTION)
    //   "test-token-vocab-empty"     — has NO vocabulary entries
    //   (an unauthenticated / malformed-token case needs no identity row)
    db->getClient()->execSqlSync("INSERT INTO identity (token) VALUES "
                                 "('test-token-vocab-populated') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync("INSERT INTO identity (token) VALUES "
                                 "('test-token-vocab-empty') ON CONFLICT DO NOTHING");

    // Deterministic vocabulary set for the populated token: clear stale rows
    // from a prior run, then grant exactly {7, 21}.
    db->getClient()->execSqlSync(
        "DELETE FROM vocabulary WHERE token = 'test-token-vocab-populated'");
    db->getClient()->execSqlSync("DELETE FROM vocabulary WHERE token = 'test-token-vocab-empty'");
    db->getClient()->execSqlSync(
        "INSERT INTO vocabulary (token, word_id) VALUES "
        "('test-token-vocab-populated', 7), ('test-token-vocab-populated', 21)");

    // Clear any notes this token left in a prior run. Anchor (4, 4) —
    // MARKET / cellar — is not used by any other test suite, so exercising
    // POST /v1/notes here cannot pollute another suite's exact-count
    // assertions (unlike (3, 2), which notes_handler_test.cpp owns).
    db->getClient()->execSqlSync(
        "DELETE FROM notes WHERE author_token = 'test-token-vocab-populated'");

    // ── Server ────────────────────────────────────────────────────────────
    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kVocabularyTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto httpClient = drogon::HttpClient::newHttpClient("http://127.0.0.1:" +
                                                        std::to_string(kVocabularyTestPort));

    // ── Test 1: populated token → 200, exactly {7, 21} ───────────────────
    Json::Value populatedBody;
    {
        auto [code, body] = sendVocabularyGet(httpClient, "test-token-vocab-populated");
        CHECK(code == drogon::k200OK);
        REQUIRE(body.isArray());
        REQUIRE(body.size() == 2u);
        populatedBody = body;

        bool has7 = false, has21 = false;
        for (const auto &v : body) {
            if (v.asInt() == 7)
                has7 = true;
            if (v.asInt() == 21)
                has21 = true;
        }
        CHECK(has7);
        CHECK(has21);
    }

    // ── Test 2: every returned id is accepted by POST /v1/notes ──────────
    // Generic over whatever the endpoint returned — looks up each word's
    // category and finds a matching single-slot template, rather than
    // hardcoding template ids for 7/21.
    for (const auto &wordVal : populatedBody) {
        const auto wordId = static_cast<int16_t>(wordVal.asInt());
        const int16_t category = categoryOf(wordId);
        REQUIRE(category != 0);
        const int16_t templateId = findSingleSlotTemplateFor(category);
        REQUIRE(templateId != -1);

        Json::Value body;
        body["archetype"] = 4; // MARKET
        body["tag"] = 4;       // cellar
        body["template_id"] = templateId;
        Json::Value slots(Json::arrayValue);
        slots.append(wordId);
        body["slots"] = slots;

        auto [code, j] = sendNotePostRaw(httpClient, body, "test-token-vocab-populated");
        CHECK(code == drogon::k201Created);
        CHECK(j.isMember("id"));
    }

    // ── Test 3: a word absent from the list is rejected 403 / 4002 ───────
    // Word 22 (run / ACTION) was never granted to the populated token.
    {
        Json::Value body;
        body["archetype"] = 4;
        body["tag"] = 4;
        body["template_id"] = 6; // {ACTION}
        Json::Value slots(Json::arrayValue);
        slots.append(22);
        body["slots"] = slots;

        auto [code, j] = sendNotePostRaw(httpClient, body, "test-token-vocab-populated");
        CHECK(code == drogon::k403Forbidden);
        CHECK(j["error"].asInt() == 4002);
    }

    // ── Test 4: token with nothing unlocked → 200 [] ──────────────────────
    {
        auto [code, body] = sendVocabularyGet(httpClient, "test-token-vocab-empty");
        CHECK(code == drogon::k200OK);
        REQUIRE(body.isArray());
        CHECK(body.size() == 0u);
    }

    // ── Test 5: missing Authorization header → same auth error as notes ──
    {
        auto [code, body] = sendVocabularyGet(httpClient, "", /*sendAuthHeader=*/false);
        CHECK(code == drogon::k401Unauthorized);
        CHECK(body["error"].asInt() == 1001);
    }

    // ── Teardown ──────────────────────────────────────────────────────────
    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
