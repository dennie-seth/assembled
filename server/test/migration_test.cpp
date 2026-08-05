#include <doctest/doctest.h>

#include <future>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"

#ifndef ASSEMBLED_MIGRATIONS_DIR
#error "ASSEMBLED_MIGRATIONS_DIR must be defined by CMake"
#endif

/// T-0041/T-0042: exercises the real connection + migration-apply path
/// against the docker-compose Postgres. Gated on DATABASE_URL rather than
/// hard-failing without one, per task instructions -- a machine with no DB
/// configured still gets a green build, it just skips this proof.
TEST_CASE("migrations apply against a live Postgres") {
    if (!std::getenv("DATABASE_URL"))
        return;
    auto db = assembled_server::Database::fromEnv();
    REQUIRE(db.has_value());

    // Reset migration tracking so this test is repeatable against a persistent
    // dev DB.  The migrations themselves are idempotent (CREATE IF NOT EXISTS /
    // ON CONFLICT DO NOTHING), so re-applying them to an already-migrated
    // schema is safe.
    db->getClient()->execSqlSync("DROP TABLE IF EXISTS schema_migrations");

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    CHECK(runner.currentVersion(db->getClient()) >= 0);

    int firstPassApplied = runner.applyPending(db->getClient());
    CHECK(firstPassApplied >= 1);
    CHECK(runner.currentVersion(db->getClient()) >= 1);

    // Idempotency: re-running applies nothing new (sql.md: up must be a
    // no-op once already applied).
    int secondPassApplied = runner.applyPending(db->getClient());
    CHECK(secondPassApplied == 0);
}
