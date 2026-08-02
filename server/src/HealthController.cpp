#include "assembled_server/HealthController.h"

#include <drogon/HttpResponse.h>

namespace assembled_server {

void HealthController::getHealth(
    const drogon::HttpRequestPtr &req,
    std::function<void(const drogon::HttpResponsePtr &)> &&callback) const {
    (void)req;
    Json::Value body;
    body["status"] = "ok";
    auto resp = drogon::HttpResponse::newHttpJsonResponse(body);
    callback(resp);
}

} // namespace assembled_server
