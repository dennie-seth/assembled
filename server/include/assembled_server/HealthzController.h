#pragma once

#include <drogon/HttpController.h>

namespace assembled_server {

/// Readiness endpoint (T-0050). Unlike `HealthController`'s `/health`
/// (pure liveness, no dependency check -- see its own doc comment),
/// `/healthz` pings the database and only reports 200 when both the
/// process and the DB connection are healthy. Intended for load-balancer
/// and deploy readiness gates, not the liveness probe.
class HealthzController : public drogon::HttpController<HealthzController> {
  public:
    METHOD_LIST_BEGIN
    // ADD_METHOD_TO, not METHOD_ADD: see HealthController.h for why.
    ADD_METHOD_TO(HealthzController::getHealthz, "/healthz", drogon::Get);
    METHOD_LIST_END

    /// @param req incoming request (unused; the route takes no parameters).
    /// @param callback invoked with 200 `{"status":"ok"}` when the database
    ///        connection is live, or 503 `{"status":"error"}` when
    ///        `DATABASE_URL` is unset or the database is unreachable. Always
    ///        invoked exactly once, and always within `HEALTHZ_TIMEOUT_MS`
    ///        (default 2000ms) of the call -- a configured-but-unreachable
    ///        database, or one that stops responding mid-request, resolves
    ///        as 503 at the timeout bound rather than hanging.
    void getHealthz(const drogon::HttpRequestPtr &req,
                    std::function<void(const drogon::HttpResponsePtr &)> &&callback) const;
};

} // namespace assembled_server
