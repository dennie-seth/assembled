#include <cstdio>
#include <cstdlib>

#include "assembled_server/Database.h"
#include "assembled_server/MigrationRunner.h"

/// T-0042 documented migration-apply mechanism: `./build/migrate`, reading
/// `DATABASE_URL` and applying every migration in `ASSEMBLED_MIGRATIONS_DIR`
/// (defined by CMake as `server/migrations`) not yet recorded in
/// `schema_migrations`. See server/README.md.
int main() {
    auto db = assembled_server::Database::fromEnv();
    if (!db.has_value()) {
        std::fprintf(stderr, "migrate: DATABASE_URL is not set\n");
        return 1;
    }

    assembled_server::MigrationRunner runner(ASSEMBLED_MIGRATIONS_DIR);
    const int applied = runner.applyPending(db->getClient());
    std::printf("migrate: applied %d migration(s), now at version %lld\n", applied,
                static_cast<long long>(runner.currentVersion(db->getClient())));
    return 0;
}
