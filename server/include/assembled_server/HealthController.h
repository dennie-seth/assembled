#pragma once

#include <drogon/HttpController.h>

namespace assembled_server {

/// Proof-of-life HTTP endpoint (T-0040/T-0050). Reports that the server
/// process is up; it is deliberately not a dependency/readiness check
/// (no DB ping) -- that distinction matters once /v1 routes exist behind
/// a load balancer, so it is kept narrow from the start rather than
/// widened later under time pressure.
class HealthController : public drogon::HttpController<HealthController> {
  public:
    METHOD_LIST_BEGIN
    // ADD_METHOD_TO, not METHOD_ADD: METHOD_ADD prefixes the route with the
    // (namespaced) class name, e.g. /assembled_server/HealthController/health.
    // ADD_METHOD_TO registers the literal path, which is what /health needs.
    ADD_METHOD_TO(HealthController::getHealth, "/health", drogon::Get);
    METHOD_LIST_END

    /// @param req incoming request (unused; the route takes no parameters).
    /// @param callback invoked with a 200 JSON response `{"status":"ok"}`.
    void getHealth(const drogon::HttpRequestPtr &req,
                   std::function<void(const drogon::HttpResponsePtr &)> &&callback) const;
};

} // namespace assembled_server
