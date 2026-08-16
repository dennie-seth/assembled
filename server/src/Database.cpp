#include "assembled_server/Database.h"

#include <cstdlib>
#include <regex>
#include <vector>

namespace assembled_server {

namespace {

/// drogon::orm::DbClientImpl owns a trantor::EventLoopThread whose destructor
/// unconditionally joins its thread. If the last DbClientPtr reference is
/// dropped from *inside* a callback running on that very thread (observed
/// live via core dump: trantor::EventLoop::loop() ->
/// drogon::orm::PgConnection::handleRead() -> ..._M_release_last_use_cold()
/// -> ~DbClientImpl() -> ~EventLoopThread() -> thread::join()), the join is a
/// self-join: it throws std::system_error(EDEADLK) out of a destructor,
/// which is implicitly noexcept, so std::terminate() aborts the process.
/// Every `Database` used to own the sole/last reference to its client and
/// hit this nondeterministically at end-of-scope. Every production
/// controller already sidesteps this by caching its DbClientPtr in a
/// call_once static for the process lifetime (see e.g.
/// OfferingController.cpp); do the same centrally here so no caller --
/// including short-lived test binaries that don't do that caching -- can
/// trigger the teardown race. The number of distinct connection strings
/// used per process is small and bounded (one per call_once site / test
/// binary), so leaking them for the process's lifetime is negligible.
std::vector<drogon::orm::DbClientPtr> &keepAliveRegistry() {
    static auto *registry = new std::vector<drogon::orm::DbClientPtr>();
    return *registry;
}

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

    std::string connInfo = "host=" + host + " port=" + port + " dbname=" + dbname +
                          " user=" + user + " connect_timeout=10";
    if (!password.empty()) {
        connInfo += " password=" + password;
    }
    return connInfo;
}

} // namespace

Database::Database(const std::string &connectionInfo, size_t connectionPoolSize)
    : client_(drogon::orm::DbClient::newPgClient(toLibpqConnInfo(connectionInfo),
                                                 connectionPoolSize)) {
    keepAliveRegistry().push_back(client_);
}

std::optional<Database> Database::fromEnv() {
    const char *url = std::getenv("DATABASE_URL");
    if (url == nullptr || std::string(url).empty()) {
        return std::nullopt;
    }
    return Database(url);
}

const drogon::orm::DbClientPtr &Database::getClient() const { return client_; }

} // namespace assembled_server
