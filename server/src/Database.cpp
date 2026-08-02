#include "assembled_server/Database.h"

#include <cstdlib>
#include <regex>

namespace assembled_server {

namespace {

/// Drogon's PgClient wants libpq keyword=value form
/// (`host=... port=... dbname=... user=... password=...`), not a URI.
/// `DATABASE_URL` (matches ci-server.yml / docker-compose convention) is a
/// `postgresql://user:pass@host:port/dbname` URI, so translate it. A string
/// that doesn't match the URI shape is assumed to already be keyword=value
/// and is passed through unchanged.
std::string toLibpqConnInfo(const std::string &url) {
    static const std::regex re(
        R"(^postgres(?:ql)?://([^:@/]+)(?::([^@/]*))?@([^:/]+)(?::(\d+))?/([^?]+))");
    std::smatch m;
    if (!std::regex_match(url, m, re)) {
        return url;
    }

    std::string user = m[1].str();
    std::string password = m[2].str();
    std::string host = m[3].str();
    std::string port = m[4].matched ? m[4].str() : "5432";
    std::string dbname = m[5].str();

    std::string connInfo = "host=" + host + " port=" + port + " dbname=" + dbname + " user=" + user;
    if (!password.empty()) {
        connInfo += " password=" + password;
    }
    return connInfo;
}

} // namespace

Database::Database(const std::string &connectionInfo, size_t connectionPoolSize)
    : client_(drogon::orm::DbClient::newPgClient(toLibpqConnInfo(connectionInfo),
                                                 connectionPoolSize)) {}

std::optional<Database> Database::fromEnv() {
    const char *url = std::getenv("DATABASE_URL");
    if (url == nullptr || std::string(url).empty()) {
        return std::nullopt;
    }
    return Database(url);
}

const drogon::orm::DbClientPtr &Database::getClient() const { return client_; }

} // namespace assembled_server
