#include "assembled_server/RequestLogger.h"

#include <drogon/HttpAppFramework.h>
#include <json/value.h>
#include <json/writer.h>
#include <trantor/utils/Logger.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <sstream>

namespace assembled_server {

namespace {

constexpr const char *kRequestIdKey = "t0050_request_id";
constexpr const char *kStartTimeKey = "t0050_start_time";

using Clock = std::chrono::steady_clock;

std::string toJsonLine(const Json::Value &entry) {
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    return Json::writeString(writer, entry);
}

} // namespace

std::string RequestLogger::generateRequestId() {
    static std::atomic<uint64_t> counter{0};
    std::ostringstream oss;
    oss << "req-" << std::hex << std::setw(16) << std::setfill('0') << ++counter;
    return oss.str();
}

void RequestLogger::install(Sink sink) {
    if (!sink) {
        sink = [](const std::string &line) { LOG_INFO << line; };
    }

    drogon::app().registerPreRoutingAdvice([](const drogon::HttpRequestPtr &req) {
        req->attributes()->insert(kRequestIdKey, generateRequestId());
        req->attributes()->insert(kStartTimeKey, Clock::now());
    });

    drogon::app().registerPostHandlingAdvice(
        [sink](const drogon::HttpRequestPtr &req, const drogon::HttpResponsePtr &resp) {
            const auto &attrs = req->attributes();
            const auto requestId = attrs->get<std::string>(kRequestIdKey);
            const auto start = attrs->get<Clock::time_point>(kStartTimeKey);
            const double durationMs =
                std::chrono::duration<double, std::milli>(Clock::now() - start).count();

            Json::Value entry(Json::objectValue);
            entry["request_id"] = requestId;
            entry["method"] = req->getMethodString();
            entry["route"] = req->path();
            entry["status"] = static_cast<int>(resp->statusCode());
            entry["duration_ms"] = durationMs;

            sink(toJsonLine(entry));
        });
}

} // namespace assembled_server
