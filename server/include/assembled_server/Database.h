#pragma once

#include <drogon/orm/DbClient.h>

#include <optional>
#include <string>

namespace assembled_server {

/// Thin wrapper around a Drogon PostgreSQL client, constructed from the
/// `DATABASE_URL` environment variable (never a committed connection
/// string/secret -- see server/README.md "Configuration").
class Database {
  public:
    /// @param connectionInfo libpq-style connection string or URI
    ///        (e.g. `postgresql://user:pass@host:5432/dbname`).
    /// @param connectionPoolSize number of pooled connections to open.
    explicit Database(const std::string &connectionInfo, size_t connectionPoolSize = 1);

    /// Builds a Database from `DATABASE_URL`.
    /// @return `std::nullopt` if the environment variable is unset/empty,
    ///         so callers (tests, `migrate`) can skip gracefully instead of
    ///         failing when no DB is configured.
    static std::optional<Database> fromEnv();

    /// @return the underlying Drogon DB client used for all queries.
    const drogon::orm::DbClientPtr &getClient() const;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
