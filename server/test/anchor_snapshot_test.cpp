/// T-0124: GET /v1/anchors/{archetype}/{tag} — room-entry snapshot tests.
/// TDD: this file is committed BEFORE the AnchorRepo / AnchorController
/// implementation exists.  All integration TEST_CASEs gate on DATABASE_URL so
/// CI without a Postgres container stays green (build-only) while the dev
/// machine and ci-server integration job run the live DB assertions.
///
/// Endpoint contract (03-net-protocol.md §5):
///   GET /v1/anchors/{archetype}/{tag}
///   -> 200 { "items": [...], "offerings": [...], "notes": [...] }
///
/// Three visibility classes in one consistent database transaction:
///   items[]     — loose item_instance rows hosted in the caller's universe
///                 (not backed by an open offering).
///   offerings[] — open offering rows at that anchor (globally visible).
///   notes[]     — anchor-scoped notes; is_broadcast=true excluded.
///
/// Key invariant tested: an item cannot appear in both items[] and offerings[]
/// in the same snapshot — the single transaction ensures a consistent view
/// even when a concurrent POST /v1/offerings commits between reads.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <future>
#include <string>
#include <thread>
#include <vector>

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpClient.h>

#include "assembled_server/AnchorController.h"
#include "assembled_server/AnchorRepo.h"
#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Helpers ──────────────────────────────────────────────────────────────────

namespace {

void seedIdentity(const drogon::orm::DbClientPtr &db, const std::string &token) {
    db->execSqlSync("INSERT INTO identity (token) VALUES ($1) ON CONFLICT DO NOTHING", token);
}

void seedItemType(const drogon::orm::DbClientPtr &db, int16_t id) {
    db->execSqlSync("INSERT INTO item_type (id, rarity) VALUES ($1, 0) ON CONFLICT DO NOTHING", id);
}

/// Insert an item_instance anchored at (arch, tag) in the given universe.
/// Returns the newly minted UUID.
std::string seedAnchoredItem(const drogon::orm::DbClientPtr &db, int16_t type_id,
                             const std::string &hosted_by, int16_t arch, int16_t tag) {
    auto r = db->execSqlSync("INSERT INTO item_instance "
                             "(type_id, hosted_by, anchor_arch, anchor_tag, bleed_at) "
                             "VALUES ($1, $2, $3, $4, now() + INTERVAL '1 hour') "
                             "RETURNING id",
                             type_id, hosted_by, arch, tag);
    return r[0][0].as<std::string>();
}

/// Insert an offering for the given item_instance at (arch, tag) by author.
/// Returns the newly minted offering UUID.
std::string seedOffering(const drogon::orm::DbClientPtr &db, const std::string &item_id,
                         int16_t wants_type, int16_t arch, int16_t tag, const std::string &author) {
    auto r =
        db->execSqlSync("INSERT INTO offering "
                        "(item_instance, wants_type, anchor_arch, anchor_tag, author, expires_at) "
                        "VALUES ($1::uuid, $2, $3, $4, $5, now() + INTERVAL '1 hour') "
                        "RETURNING id",
                        item_id, wants_type, arch, tag, author);
    return r[0][0].as<std::string>();
}

/// Insert a non-broadcast note at (arch, tag) by author.
/// Returns the newly minted note UUID.
std::string seedNote(const drogon::orm::DbClientPtr &db, const std::string &author, int16_t arch,
                     int16_t tag) {
    // template_id=6 ({ACTION}), slot_a=21 (wait) — seeded in 003.
    auto r = db->execSqlSync(
        "INSERT INTO notes (author_token, archetype_id, anchor_tag, template_id, slot_a) "
        "VALUES ($1, $2, $3, 6, 21) RETURNING id",
        author, arch, tag);
    return r[0][0].as<std::string>();
}

/// Insert a broadcast note (is_broadcast=true).
/// Broadcast notes use a special archetype_id=0 row here to avoid the FK;
/// in production they would have archetype_id NULL once the schema allows it.
/// This helper avoids the FK by inserting directly with is_broadcast=true.
std::string seedBroadcastNote(const drogon::orm::DbClientPtr &db, const std::string &author,
                              int16_t arch, int16_t tag) {
    auto r = db->execSqlSync(
        "INSERT INTO notes "
        "(author_token, archetype_id, anchor_tag, template_id, slot_a, is_broadcast) "
        "VALUES ($1, $2, $3, 6, 21, true) RETURNING id",
        author, arch, tag);
    return r[0][0].as<std::string>();
}

} // namespace

// ── Compile-time: snapshot() has the expected signature ───────────────────────

TEST_CASE("PgAnchorRepo::snapshot has expected signature (caller_token, arch, tag)") {
    using SnapshotFn = assembled_server::AnchorSnapshot (assembled_server::PgAnchorRepo::*)(
        const std::string &, int16_t, int16_t);
    static_cast<void>(static_cast<SnapshotFn>(&assembled_server::PgAnchorRepo::snapshot));
    CHECK(true);
}

// ── Compile-time: AnchorSnapshot has the three required array fields ──────────

TEST_CASE("AnchorSnapshot has items, offerings, and notes fields") {
    assembled_server::AnchorSnapshot snap;
    // These lines fail to compile if the struct fields are renamed or removed.
    static_cast<void>(snap.items);
    static_cast<void>(snap.offerings);
    static_cast<void>(snap.notes);
    CHECK(true);
}

// ── Integration: empty anchor returns three empty arrays ─────────────────────

TEST_CASE("snapshot: empty anchor returns three empty arrays") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string caller = "test-anchor-snap-empty";
    seedIdentity(db->getClient(), caller);

    // Anchor (HOSPITAL=1, tag=1) exists in the seed; ensure it's clean.
    db->getClient()->execSqlSync("DELETE FROM offering WHERE anchor_arch = 1 AND anchor_tag = 1 "
                                 "AND author = $1",
                                 caller);
    db->getClient()->execSqlSync(
        "DELETE FROM item_instance WHERE hosted_by = $1 AND anchor_arch = 1 AND anchor_tag = 1",
        caller);
    db->getClient()->execSqlSync("DELETE FROM notes WHERE archetype_id = 1 AND anchor_tag = 1");

    assembled_server::PgAnchorRepo repo(db->getClient());
    const auto snap = repo.snapshot(caller, 1, 1);

    CHECK(snap.items.empty());
    CHECK(snap.offerings.empty());
    CHECK(snap.notes.empty());
}

// ── Integration: loose item appears in items[], not offerings[] ───────────────

TEST_CASE("snapshot: loose item in caller universe appears in items[], not offerings[]") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string caller = "test-anchor-snap-loose";
    seedIdentity(db->getClient(), caller);
    constexpr int16_t kTypeId = 91;
    seedItemType(db->getClient(), kTypeId);

    // Clean up prior runs.
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    const std::string item_id = seedAnchoredItem(db->getClient(), kTypeId, caller, 1, 1);

    assembled_server::PgAnchorRepo repo(db->getClient());
    const auto snap = repo.snapshot(caller, 1, 1);

    REQUIRE(snap.items.size() == 1u);
    CHECK(snap.items[0].id == item_id);
    CHECK(snap.items[0].type_id == kTypeId);
    CHECK(snap.items[0].custody_depth == 0);
    CHECK(!snap.items[0].bleed_at.empty());

    // Must not appear in offerings[].
    for (const auto &o : snap.offerings) {
        CHECK(o.item_instance_id != item_id);
    }
}

// ── Integration: item with active offering in offerings[], not items[] ─────────

TEST_CASE("snapshot: offered item appears in offerings[] not items[]") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string caller = "test-anchor-snap-offered";
    const std::string offerer = "test-anchor-snap-offerer";
    seedIdentity(db->getClient(), caller);
    seedIdentity(db->getClient(), offerer);
    constexpr int16_t kTypeId = 92;
    constexpr int16_t kWantsType = 93;
    seedItemType(db->getClient(), kTypeId);
    seedItemType(db->getClient(), kWantsType);

    // Clean up prior runs.
    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE anchor_arch = 1 AND anchor_tag = 2 AND author = $1", offerer);
    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    // Anchor the item in caller's universe, then create an offering for it.
    const std::string item_id = seedAnchoredItem(db->getClient(), kTypeId, caller, 1, 2);
    const std::string offering_id =
        seedOffering(db->getClient(), item_id, kWantsType, 1, 2, offerer);

    assembled_server::PgAnchorRepo repo(db->getClient());
    const auto snap = repo.snapshot(caller, 1, 2);

    // Must NOT appear in items[] — it is escrowed.
    for (const auto &it : snap.items) {
        CHECK(it.id != item_id);
    }

    // Must appear in offerings[].
    bool found_offering = false;
    for (const auto &o : snap.offerings) {
        if (o.id == offering_id) {
            found_offering = true;
            CHECK(o.item_instance_id == item_id);
            CHECK(o.wants_type == kWantsType);
            CHECK(o.anchor_arch == 1);
            CHECK(o.anchor_tag == 2);
            CHECK(!o.expires_at.empty());
        }
    }
    CHECK(found_offering);
}

// ── Integration: items from OTHER universes not included ──────────────────────

TEST_CASE("snapshot: items hosted in another universe excluded from items[]") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string caller = "test-anchor-snap-caller-univ";
    const std::string other = "test-anchor-snap-other-univ";
    seedIdentity(db->getClient(), caller);
    seedIdentity(db->getClient(), other);
    constexpr int16_t kTypeId = 94;
    seedItemType(db->getClient(), kTypeId);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);

    // Anchor item in OTHER's universe, not caller's.
    const std::string item_id = seedAnchoredItem(db->getClient(), kTypeId, other, 1, 1);

    assembled_server::PgAnchorRepo repo(db->getClient());
    const auto snap = repo.snapshot(caller, 1, 1);

    // Must NOT appear in caller's items[].
    for (const auto &it : snap.items) {
        CHECK(it.id != item_id);
    }
}

// ── Integration: broadcast notes excluded from notes[] ────────────────────────

TEST_CASE("snapshot: broadcast notes excluded from notes[]") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string author = "test-anchor-snap-broadcast";
    seedIdentity(db->getClient(), author);

    // Clean up prior runs.
    db->getClient()->execSqlSync(
        "DELETE FROM notes WHERE author_token = $1 AND archetype_id = 1 AND anchor_tag = 1",
        author);

    // Insert one regular note and one broadcast note at the same anchor.
    const std::string regular_id = seedNote(db->getClient(), author, 1, 1);
    const std::string broadcast_id = seedBroadcastNote(db->getClient(), author, 1, 1);

    assembled_server::PgAnchorRepo repo(db->getClient());

    const std::string caller = "test-anchor-snap-caller-bc";
    seedIdentity(db->getClient(), caller);
    const auto snap = repo.snapshot(caller, 1, 1);

    bool found_regular = false;
    bool found_broadcast = false;
    for (const auto &n : snap.notes) {
        if (n.id == regular_id)
            found_regular = true;
        if (n.id == broadcast_id)
            found_broadcast = true;
    }

    CHECK(found_regular);
    CHECK_FALSE(found_broadcast); // broadcasts must be excluded
}

// ── Integration: concurrent offering never produces a torn snapshot ───────────

TEST_CASE("snapshot: item cannot appear in both items[] and offerings[] simultaneously") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string caller = "test-anchor-snap-conc-caller";
    const std::string offerer = "test-anchor-snap-conc-offerer";
    seedIdentity(db->getClient(), caller);
    seedIdentity(db->getClient(), offerer);
    constexpr int16_t kTypeId = 95;
    constexpr int16_t kWantsType = 96;
    seedItemType(db->getClient(), kTypeId);
    seedItemType(db->getClient(), kWantsType);

    db->getClient()->execSqlSync("DELETE FROM item_instance WHERE type_id = $1", kTypeId);
    db->getClient()->execSqlSync(
        "DELETE FROM offering WHERE anchor_arch = 2 AND anchor_tag = 1 AND author = $1", offerer);

    const std::string item_id = seedAnchoredItem(db->getClient(), kTypeId, caller, 2, 1);

    assembled_server::PgAnchorRepo repo(db->getClient());

    std::atomic<bool> found_inconsistency{false};
    std::atomic<bool> writer_done{false};

    // Writer thread: rapidly create and delete an offering for the item.
    std::thread writer([&]() {
        for (int i = 0; i < 40; ++i) {
            try {
                db->getClient()->execSqlSync(
                    "INSERT INTO offering "
                    "(item_instance, wants_type, anchor_arch, anchor_tag, author, expires_at) "
                    "VALUES ($1::uuid, $2, 2, 1, $3, now() + INTERVAL '1 hour') "
                    "ON CONFLICT (item_instance) DO NOTHING",
                    item_id, kWantsType, offerer);
                db->getClient()->execSqlSync("DELETE FROM offering WHERE item_instance = $1::uuid",
                                             item_id);
            } catch (...) {
                // Swallow — a concurrent delete can cause FK conflicts.
            }
        }
        writer_done = true;
    });

    // Reader loop: take snapshots while the writer races.
    for (int i = 0; i < 60 && !found_inconsistency; ++i) {
        const auto snap = repo.snapshot(caller, 2, 1);

        // Collect IDs in items[] and offerings[].
        bool item_is_loose = false;
        bool item_is_offered = false;

        for (const auto &it : snap.items) {
            if (it.id == item_id)
                item_is_loose = true;
        }
        for (const auto &o : snap.offerings) {
            if (o.item_instance_id == item_id)
                item_is_offered = true;
        }

        // An item must not appear in both arrays in the same snapshot.
        if (item_is_loose && item_is_offered) {
            found_inconsistency = true;
        }
    }

    writer.join();
    CHECK_FALSE(found_inconsistency);
}

// ── Integration: notes at anchor appear in notes[] ordered by rating DESC ────

TEST_CASE("snapshot: notes returned ordered by rating DESC") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());
    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    const std::string author = "test-anchor-snap-noteorder";
    seedIdentity(db->getClient(), author);

    // Anchor (BRIDGE=3, tag=3) — unused by other anchor tests.
    db->getClient()->execSqlSync(
        "DELETE FROM notes WHERE author_token = $1 AND archetype_id = 3 AND anchor_tag = 3",
        author);

    const std::string id_lo = seedNote(db->getClient(), author, 3, 3);
    const std::string id_hi = seedNote(db->getClient(), author, 3, 3);
    db->getClient()->execSqlSync("UPDATE notes SET rating = 1 WHERE id = $1::uuid", id_lo);
    db->getClient()->execSqlSync("UPDATE notes SET rating = 5 WHERE id = $1::uuid", id_hi);

    const std::string caller = "test-anchor-snap-caller-no";
    seedIdentity(db->getClient(), caller);

    assembled_server::PgAnchorRepo repo(db->getClient());
    const auto snap = repo.snapshot(caller, 3, 3);

    int pos_lo = -1, pos_hi = -1;
    for (int i = 0; i < static_cast<int>(snap.notes.size()); ++i) {
        if (snap.notes[i].id == id_lo)
            pos_lo = i;
        if (snap.notes[i].id == id_hi)
            pos_hi = i;
    }
    REQUIRE(pos_lo != -1);
    REQUIRE(pos_hi != -1);
    // Higher-rated note must appear first.
    CHECK(pos_hi < pos_lo);
}

// ── Integration: HTTP GET /v1/anchors/{arch}/{tag} ────────────────────────────

namespace {
constexpr uint16_t kAnchorTestPort = 18090;
} // namespace

TEST_CASE("HTTP GET /v1/anchors/{arch}/{tag} returns 200 with three arrays") {
    if (!std::getenv("DATABASE_URL"))
        return;

    // Set up DB state before starting the server.
    {
        auto db = assembled_server::Database::fromEnv();
        REQUIRE(db.has_value());
        assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
        runner.applyPending(db->getClient());
    }

    std::thread serverThread([]() {
        drogon::app().addListener("127.0.0.1", kAnchorTestPort);
        drogon::app().run();
    });
    while (!drogon::app().isRunning()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    auto client =
        drogon::HttpClient::newHttpClient("http://127.0.0.1:" + std::to_string(kAnchorTestPort));

    auto sendGet = [&](const std::string &path,
                       const std::string &token) -> std::pair<drogon::HttpStatusCode, Json::Value> {
        auto req = drogon::HttpRequest::newHttpRequest();
        req->setMethod(drogon::Get);
        req->setPath(path);
        if (!token.empty())
            req->addHeader("Authorization", "Bearer " + token);

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

    // Valid request → 200 with three arrays.
    {
        auto [code, body] = sendGet("/v1/anchors/1/1", "test-anchor-http-tok");
        CHECK(code == drogon::k200OK);
        CHECK(body.isMember("items"));
        CHECK(body.isMember("offerings"));
        CHECK(body.isMember("notes"));
        CHECK(body["items"].isArray());
        CHECK(body["offerings"].isArray());
        CHECK(body["notes"].isArray());
    }

    // Missing bearer token → 401.
    {
        auto [code, body] = sendGet("/v1/anchors/1/1", "");
        CHECK(code == drogon::k401Unauthorized);
    }

    // Non-integer path parameters → 400.
    {
        auto [code, body] = sendGet("/v1/anchors/foo/bar", "test-anchor-http-tok");
        CHECK(code == drogon::k400BadRequest);
    }

    drogon::app().getLoop()->queueInLoop([]() { drogon::app().quit(); });
    serverThread.join();
}
