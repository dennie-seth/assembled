#include "assembled_server/MigrationRunner.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

namespace assembled_server {

namespace fs = std::filesystem;

namespace {

/// One `up` migration file discovered on disk, e.g. `001_init.sql` -> {1,
/// path}. `*.down.sql` siblings are never picked up as pending migrations.
struct PendingMigration {
    int version;
    fs::path upFile;
};

} // namespace

MigrationRunner::MigrationRunner(std::string migrationsDir)
    : migrationsDir_(std::move(migrationsDir)) {}

const std::string &MigrationRunner::getMigrationsDir() const { return migrationsDir_; }

void MigrationRunner::ensureVersionTable(const drogon::orm::DbClientPtr &client) const {
    client->execSqlSync("CREATE TABLE IF NOT EXISTS schema_migrations ("
                        "version INT PRIMARY KEY, "
                        "applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
}

int64_t MigrationRunner::currentVersion(const drogon::orm::DbClientPtr &client) const {
    ensureVersionTable(client);
    auto result =
        client->execSqlSync("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations");
    if (result.empty()) {
        return 0;
    }
    return result[0]["v"].as<int64_t>();
}

int MigrationRunner::applyPending(const drogon::orm::DbClientPtr &client) const {
    ensureVersionTable(client);
    const int64_t current = currentVersion(client);

    std::vector<PendingMigration> pending;
    for (const auto &entry : fs::directory_iterator(migrationsDir_)) {
        if (!entry.is_regular_file()) {
            continue;
        }
        const auto name = entry.path().filename().string();
        constexpr std::string_view kSqlExt = ".sql";
        if (name.size() < kSqlExt.size() ||
            name.compare(name.size() - kSqlExt.size(), kSqlExt.size(), kSqlExt) != 0) {
            continue;
        }
        if (name.find(".down.sql") != std::string::npos) {
            continue;
        }

        const auto underscore = name.find('_');
        if (underscore == std::string::npos) {
            continue;
        }
        int version = 0;
        try {
            version = std::stoi(name.substr(0, underscore));
        } catch (const std::exception &) {
            continue;
        }
        if (version > current) {
            pending.push_back(PendingMigration{version, entry.path()});
        }
    }

    std::sort(
        pending.begin(), pending.end(),
        [](const PendingMigration &a, const PendingMigration &b) { return a.version < b.version; });

    int applied = 0;
    for (const auto &migration : pending) {
        std::ifstream in(migration.upFile);
        std::stringstream buffer;
        buffer << in.rdbuf();

        client->execSqlSync(buffer.str());
        client->execSqlSync("INSERT INTO schema_migrations (version) VALUES (" +
                            std::to_string(migration.version) + ")");
        ++applied;
    }
    return applied;
}

} // namespace assembled_server
