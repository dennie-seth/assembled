#pragma once

#include <functional>
#include <string>

namespace assembled_server {

/// Structured (JSON) access logging for every HTTP request (T-0050).
/// `install()` registers a Drogon pre-routing observer that stamps a
/// request id and start time onto the request's attribute store, and a
/// post-handling advice that emits one JSON log line per completed request
/// containing the request id, HTTP method, route, status code, and
/// duration in milliseconds.
class RequestLogger {
  public:
    /// Receives one JSON-encoded log line per completed request.
    using Sink = std::function<void(const std::string &)>;

    /// Registers the pre-routing and post-handling advice on
    /// `drogon::app()`. Call once, before `drogon::app().run()`.
    /// @param sink called with the JSON log line for each request. Passing
    ///        `nullptr` (the default) logs via `LOG_INFO`, landing in the
    ///        normal Drogon/trantor output stream.
    static void install(Sink sink = nullptr);

  private:
    /// @return a new id, unique within this process, identifying one request.
    static std::string generateRequestId();
};

} // namespace assembled_server
