/// T-0044: NoteRepo interface + PgNoteRepo integration tests.
/// TDD: this file is committed BEFORE the implementation exists.
/// All TEST_CASEs gate on DATABASE_URL so CI without a Postgres container
/// stays green (build-only) while the dev machine and ci-server integration
/// job run the live DB assertions.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"
#include "assembled_server/NoteRepo.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

// ── Integration: CRUD round-trip ──────────────────────────────────────────────

TEST_CASE("PgNoteRepo CRUD round-trip") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    // Seed a test identity to satisfy the notes.author_token FK.
    db->getClient()->execSqlSync("INSERT INTO identity (token) VALUES ('test-token-note-crud') "
                                 "ON CONFLICT DO NOTHING");

    assembled_server::PgNoteRepo repo(db->getClient());

    // Create a note: template 6 = "{ACTION}", 1 slot; slot_a = 21 (wait).
    assembled_server::CreateNoteParams params;
    params.author_token = "test-token-note-crud";
    params.archetype_id = 1; // HOSPITAL
    params.anchor_tag = 1;   // entrance
    params.template_id = 6;  // {ACTION}
    params.slot_a = 21;      // wait
    // slot_b and item_ref left as nullopt

    const std::string note_id = repo.create(params);
    CHECK(!note_id.empty());

    // Fetch at the same (archetype_id, anchor_tag): our note must appear.
    const auto notes = repo.fetch(1, 1);
    REQUIRE(!notes.empty());

    bool found = false;
    for (const auto &n : notes) {
        if (n.id == note_id) {
            found = true;
            CHECK(n.author_token == "test-token-note-crud");
            CHECK(n.archetype_id == 1);
            CHECK(n.anchor_tag == 1);
            CHECK(n.template_id == 6);
            REQUIRE(n.slot_a.has_value());
            CHECK(n.slot_a.value() == 21);
            CHECK(!n.slot_b.has_value());
            CHECK(!n.item_ref.has_value());
            CHECK(n.rating == 0);
        }
    }
    CHECK(found);

    // Rate: +1 vote from the author token.
    repo.rate(note_id, "test-token-note-crud", 1);
    const auto notes2 = repo.fetch(1, 1);
    for (const auto &n : notes2) {
        if (n.id == note_id) {
            CHECK(n.rating == 1);
        }
    }
}

// ── Integration: FK violation — bad template_id ───────────────────────────────

TEST_CASE("PgNoteRepo rejects bad template_id via FK") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    db->getClient()->execSqlSync("INSERT INTO identity (token) VALUES ('test-token-bad-tmpl') "
                                 "ON CONFLICT DO NOTHING");

    assembled_server::PgNoteRepo repo(db->getClient());

    assembled_server::CreateNoteParams params;
    params.author_token = "test-token-bad-tmpl";
    params.archetype_id = 1;
    params.anchor_tag = 1;
    params.template_id = 999; // does not exist in note_templates
    params.slot_a = 21;

    CHECK_THROWS(repo.create(params));
}

// ── Integration: FK violation — bad slot_a ────────────────────────────────────

TEST_CASE("PgNoteRepo rejects bad slot_a via FK") {
    if (!std::getenv("DATABASE_URL"))
        return;

    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    runner.applyPending(db->getClient());

    db->getClient()->execSqlSync("INSERT INTO identity (token) VALUES ('test-token-bad-slot') "
                                 "ON CONFLICT DO NOTHING");

    assembled_server::PgNoteRepo repo(db->getClient());

    assembled_server::CreateNoteParams params;
    params.author_token = "test-token-bad-slot";
    params.archetype_id = 1;
    params.anchor_tag = 1;
    params.template_id = 6; // valid
    params.slot_a = 999;    // does not exist in note_words

    CHECK_THROWS(repo.create(params));
}

// ── Compile-time check: no radius/coordinate in fetch signature ───────────────

TEST_CASE("NoteRepo fetch is keyed on (archetype_id, anchor_tag) — no radius") {
    // Static assertion: the only two-argument overload of PgNoteRepo::fetch
    // takes (int16_t, int16_t).  Adding a radius parameter would change the
    // signature and break this cast, catching the regression at compile time.
    using FetchFn = std::vector<assembled_server::NoteRecord> (assembled_server::PgNoteRepo::*)(
        int16_t, int16_t);
    static_cast<void>(static_cast<FetchFn>(&assembled_server::PgNoteRepo::fetch));
    CHECK(true); // if we got here the signature is correct
}
