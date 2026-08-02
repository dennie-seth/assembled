#pragma once

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <string>

namespace assembled_server {

/// Applies plain-SQL migrations from a directory against `schema_migrations`
/// (see `.claude/rules/sql.md`). No ORM, no ordering magic beyond the
/// numeric filename prefix -- `NNN_slug.sql` (up) paired with
/// `NNN_slug.down.sql` (down).
class MigrationRunner {
  public:
    /// @param migrationsDir directory containing `NNN_slug.sql` /
    ///        `NNN_slug.down.sql` pairs.
    explicit MigrationRunner(std::string migrationsDir);

    /// @return the migrations directory this runner reads from.
    const std::string &getMigrationsDir() const;

    /// Ensures `schema_migrations` exists, then applies every `up` migration
    /// whose version isn't already recorded, in ascending order, each in
    /// its own transaction.
    /// @return the number of migrations newly applied.
    int applyPending(const drogon::orm::DbClientPtr &client) const;

    /// @return the highest applied version, or 0 if none have been applied
    ///         (also 0 if `schema_migrations` doesn't exist yet).
    int64_t currentVersion(const drogon::orm::DbClientPtr &client) const;

  private:
    void ensureVersionTable(const drogon::orm::DbClientPtr &client) const;

    std::string migrationsDir_;
};

} // namespace assembled_server
