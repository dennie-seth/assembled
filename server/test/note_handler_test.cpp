/// T-0045: POST /v1/notes HTTP handler + validation tests.
/// TDD: this file is committed BEFORE the implementation exists.
/// All tests are gated on DATABASE_URL; without it the server cannot
/// start in a useful state and the whole case is skipped.
///
/// Acceptance criteria exercised:
///   2001 BAD_TEMPLATE          — unknown template_id            -> 400
///   2002 SLOT_ARITY_MISMATCH   — wrong slot count               -> 400
///   2003 SLOT_CATEGORY_MISMATCH — slot word wrong category      -> 400
///   4002 VOCAB_TIER_LOCKED     — word not in caller's vocab     -> 403
///   valid request              — all checks pass                -> 201 {id}

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

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

namespace {
constexpr uint16_t kNoteHandlerTestPort = 18083;
} // namespace

// ── Shared HTTP helper ────────────────────────────────────────────────────────

/// Send POST /v1/notes with the given JSON body and bearer token.
/// Blocks up to 5 s; requires the caller to hold the server-running invariant.
static std::pair<drogon::HttpStatusCode, Json::Value>
sendNotePost(const drogon::HttpClientPtr &client, const Json::Value &body,
             const std::string &token) {
    auto req = drogon::HttpRequest::newHttpJsonRequest(body);
    req->setMethod(drogon::Post);
    req->setPath("/v1/notes");
    if (!token.empty()) {
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

// ── Integration suite ─────────────────────────────────────────────────────────

TEST_CASE("POST /v1/notes HTTP integration") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // ── DB setup ──────────────────────────────────────────────────────────
    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Two test identities:
    //   "test-token-notes-ok"     — has word 21 (wait / ACTION) in vocabulary
    //   "test-token-notes-locked" — has NO vocabulary entries
    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-token-notes-ok') ON CONFLICT DO NOTHING");
    db->getClient()->execSqlSync(
        "INSERT INTO identity (token) VALUES ('test-token-notes-locked') ON CONFLICT DO NOTHING");

    // Grant word 21 (wait, ACTION category) to the 'ok' token.
    db->getClient()->execSqlSync(
        "INSERT INTO vocabulary (token, word_id) VALUES ('test-token-notes-ok', 21) "
        "ON CONFLICT DO NOTHING");

    // ── Server ────────────────────────────────────────────────────────────
    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kNoteHandlerTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto httpClient = drogon::HttpClient::newHttpClient("http://127.0.0.1:" +
                                                        std::to_string(kNoteHandlerTestPort));

    // ── Test 1: unknown template_id → 400 / error 2001 ───────────────────
    {
        Json::Value body;
        body["archetype"] = 1;
        body["tag"] = 1;
        body["template_id"] = 999; // does not exist in note_templates
        body["slots"] = Json::Value(Json::arrayValue);

        auto [code, j] = sendNotePost(httpClient, body, "test-token-notes-ok");
        CHECK(code == drogon::k400BadRequest);
        CHECK(j["error"].asInt() == 2001);
    }

    // ── Test 2: slot arity mismatch → 400 / error 2002 ───────────────────
    // Template 6 = {ACTION} — requires exactly 1 slot; providing 0 fails.
    {
        Json::Value body;
        body["archetype"] = 1;
        body["tag"] = 1;
        body["template_id"] = 6;                       // {ACTION} — 1 slot
        body["slots"] = Json::Value(Json::arrayValue); // 0 slots provided

        auto [code, j] = sendNotePost(httpClient, body, "test-token-notes-ok");
        CHECK(code == drogon::k400BadRequest);
        CHECK(j["error"].asInt() == 2002);
    }

    // ── Test 3: slot category mismatch → 400 / error 2003 ────────────────
    // Template 6 = {ACTION} needs an ACTION word; word 1 = "ahead" (DIRECTION).
    {
        Json::Value body;
        body["archetype"] = 1;
        body["tag"] = 1;
        body["template_id"] = 6; // {ACTION}
        Json::Value slots(Json::arrayValue);
        slots.append(1); // word 1 = "ahead" = DIRECTION category, not ACTION
        body["slots"] = slots;

        auto [code, j] = sendNotePost(httpClient, body, "test-token-notes-ok");
        CHECK(code == drogon::k400BadRequest);
        CHECK(j["error"].asInt() == 2003);
    }

    // ── Test 4: vocabulary tier locked → 403 / error 4002 ────────────────
    // Word 21 (wait / ACTION) is valid for template 6, but the 'locked' token
    // has no vocabulary entries — every word is above its tier.
    {
        Json::Value body;
        body["archetype"] = 1;
        body["tag"] = 1;
        body["template_id"] = 6; // {ACTION}
        Json::Value slots(Json::arrayValue);
        slots.append(21); // word 21 = "wait" = ACTION — correct category
        body["slots"] = slots;

        auto [code, j] = sendNotePost(httpClient, body, "test-token-notes-locked");
        CHECK(code == drogon::k403Forbidden);
        CHECK(j["error"].asInt() == 4002);
    }

    // ── Test 5: valid request → 201 {id} ─────────────────────────────────
    // 'ok' token has word 21 in vocabulary; template 6 needs one ACTION word.
    {
        Json::Value body;
        body["archetype"] = 1;
        body["tag"] = 1;
        body["template_id"] = 6; // {ACTION}
        Json::Value slots(Json::arrayValue);
        slots.append(21); // word 21 = "wait" = ACTION — in ok token's vocab
        body["slots"] = slots;

        auto [code, j] = sendNotePost(httpClient, body, "test-token-notes-ok");
        CHECK(code == drogon::k201Created);
        CHECK(j.isMember("id"));
        CHECK(!j["id"].asString().empty());
    }

    // ── Teardown ──────────────────────────────────────────────────────────
    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
