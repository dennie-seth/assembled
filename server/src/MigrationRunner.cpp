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

/// Split a SQL script on `;` statement terminators and return one statement
/// per element.  Leading/trailing whitespace is stripped from each segment.
/// Segments that consist only of whitespace or `--` line comments are omitted
/// so that a trailing newline after the last `;` never produces a spurious
/// empty exec.
///
/// The splitter is comment-aware: a `;` that appears after `--` on the same
/// line is inside a line comment and does NOT act as a statement terminator.
/// This handles migration files that include SQL fragments in their header
/// comments (e.g. `-- HMAC-SHA256(key, phrase); the phrase cannot be ...`).
///
/// Postgres (via libpq prepared-statement path) rejects multi-command strings,
/// so migration files must be split and executed one statement at a time.
static std::vector<std::string> splitStatements(const std::string &sql) {
    std::vector<std::string> stmts;
    std::string current;
    bool inLineComment = false;

    for (std::string::size_type i = 0; i < sql.size(); ++i) {
        const char c = sql[i];

        if (inLineComment) {
            current += c;
            if (c == '\n') {
                inLineComment = false;
            }
            continue;
        }

        // Detect start of a -- line comment.
        if (c == '-' && i + 1 < sql.size() && sql[i + 1] == '-') {
            inLineComment = true;
            current += c;
            continue;
        }

        if (c == ';') {
            // Statement boundary — stash the accumulated text.
            const auto first = current.find_first_not_of(" \t\r\n");
            if (first != std::string::npos) {
                const auto last = current.find_last_not_of(" \t\r\n");
                std::string seg = current.substr(first, last - first + 1);

                // Skip segments whose non-blank lines are all `--` comments.
                bool hasSql = false;
                std::istringstream ss(seg);
                for (std::string line; std::getline(ss, line);) {
                    const auto lf = line.find_first_not_of(" \t");
                    if (lf == std::string::npos) {
                        continue;
                    }
                    if (line.compare(lf, 2, "--") != 0) {
                        hasSql = true;
                        break;
                    }
                }
                if (hasSql) {
                    stmts.push_back(std::move(seg));
                }
            }
            current.clear();
        } else {
            current += c;
        }
    }

    // Handle trailing content after the last `;` (or files with no `;`).
    const auto first = current.find_first_not_of(" \t\r\n");
    if (first != std::string::npos) {
        const auto last = current.find_last_not_of(" \t\r\n");
        std::string seg = current.substr(first, last - first + 1);

        bool hasSql = false;
        std::istringstream ss(seg);
        for (std::string line; std::getline(ss, line);) {
            const auto lf = line.find_first_not_of(" \t");
            if (lf == std::string::npos) {
                continue;
            }
            if (line.compare(lf, 2, "--") != 0) {
                hasSql = true;
                break;
            }
        }
        if (hasSql) {
            stmts.push_back(std::move(seg));
        }
    }

    return stmts;
}

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

        // Execute each statement individually: Postgres rejects multi-command
        // strings when libpq uses the prepared-statement protocol (PQexecParams).
        for (const auto &stmt : splitStatements(buffer.str())) {
            client->execSqlSync(stmt);
        }
        client->execSqlSync("INSERT INTO schema_migrations (version) VALUES (" +
                            std::to_string(migration.version) + ")");
        ++applied;
    }
    return applied;
}

} // namespace assembled_server
