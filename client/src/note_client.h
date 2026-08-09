/**
 * @file note_client.h
 * @brief GDExtension Node wrapping the game's notes API (T-0063).
 *
 * Exposes three operations to GDScript:
 *   - fetch_notes()  — GET /v1/notes
 *   - post_note()    — POST /v1/notes
 *   - rate_note()    — POST /v1/notes/{id}/rate
 *
 * Every operation is non-blocking.  Results arrive via signals; each signal
 * carries a `state` value from the `State` enum so callers can distinguish
 * timeout, 4xx, and 5xx outcomes without inspecting the raw http_status.
 *
 * Design notes
 * ------------
 * - `_process()` delegates to `tick()`.  Tests call `tick()` directly so they
 *   can drive the pump without a running scene tree.
 * - `curl_global_init` / `curl_global_cleanup` are called once per instance.
 *   Only one NoteClient should exist per process at a time (same constraint as
 *   CurlPump — curl's global state is a single reference).
 * - Each in-flight request is heap-allocated (`unique_ptr<InFlight>`) so its
 *   address is stable across vector reallocations; the write-callback userdata
 *   pointer remains valid for the lifetime of the transfer.
 */

#pragma once

#include <curl/curl.h>
#include <godot_cpp/classes/node.hpp>
#include <godot_cpp/core/binder_common.hpp>
#include <godot_cpp/variant/array.hpp>
#include <godot_cpp/variant/string.hpp>

#include <memory>
#include <string>
#include <vector>

namespace godot {

/**
 * @brief Non-blocking notes API client driven from `_process`.
 *
 * Wraps a `CURLM*` multi-handle; each `tick()` call is O(1) / non-blocking.
 * Completed transfers emit typed signals that distinguish timeout, 4xx, and
 * 5xx outcomes via the `State` enum.
 */
class NoteClient : public Node {
    GDCLASS(NoteClient, Node)

  public:
    /// Client-side result state for each API call.
    /// Carried as the `state` argument on every completion signal.
    enum State {
        STATE_OK = 0,           ///< 2xx response received.
        STATE_TIMEOUT = 1,      ///< Connect or transfer timed out.
        STATE_HTTP_4XX = 2,     ///< HTTP 400–499 response.
        STATE_HTTP_5XX = 3,     ///< HTTP 500–599 response.
        STATE_NETWORK_ERROR = 4 ///< curl error other than timeout.
    };

    NoteClient();
    ~NoteClient() override;

    /// Enable `_process` once the node enters the scene tree.
    void _ready() override;

    /// Called by the engine each frame; delegates to `tick()`.
    void _process(double delta) override;

    /**
     * @brief Drive the multi-handle for one frame tick.
     *
     * Calls `curl_multi_perform()` then drains completed transfer messages and
     * emits the appropriate signal for each one.  Public so headless tests can
     * drive the pump without a running scene tree.
     *
     * @param delta Seconds since last frame (mirrors engine contract; not
     *              consumed by the multi-handle itself).
     */
    void tick(double delta);

    // ── Config ────────────────────────────────────────────────────────────────

    /// @brief Set the server base URL (e.g. "http://127.0.0.1:8080").
    void set_base_url(const String &url);
    /// @brief Get the server base URL.
    String get_base_url() const;

    /// @brief Set the bearer token for `Authorization` headers.
    void set_auth_token(const String &token);
    /// @brief Get the bearer token.
    String get_auth_token() const;

    /// @brief Set the lease ID added as `X-Lease-Id` on mutations.
    void set_lease_id(const String &lease_id);
    /// @brief Get the lease ID.
    String get_lease_id() const;

    /**
     * @brief Set the transfer + connect timeout in milliseconds.
     * @param ms Timeout in milliseconds; default is 5000.
     */
    void set_timeout_ms(int ms);
    /// @brief Get the current timeout in milliseconds.
    int get_timeout_ms() const;

    // ── API ───────────────────────────────────────────────────────────────────

    /**
     * @brief Fetch notes at a given anchor.
     *
     * Sends `GET /v1/notes?archetype=<archetype_id>&tag=<anchor_tag>&limit=<limit>`.
     * Emits `notes_fetched(request_id, state, http_status, body)` on completion.
     *
     * @param archetype_id  Archetype ID (from shared/note_templates.hpp).
     * @param anchor_tag    Anchor tag scoped to that archetype.
     * @param limit         Maximum number of notes to return.
     * @return              Request ID (positive) for correlation, or -1 on
     *                      immediate failure (multi-handle not initialised).
     */
    int fetch_notes(int archetype_id, int anchor_tag, int limit);

    /**
     * @brief Post a new note at a given anchor.
     *
     * Sends `POST /v1/notes` with a JSON body.
     * Emits `note_posted(request_id, state, http_status, body)` on completion.
     *
     * @param archetype_id  Archetype ID.
     * @param anchor_tag    Anchor tag.
     * @param template_id   Note template ID (from shared/note_templates.hpp).
     * @param slots         Array of word IDs filling the template's slots.
     * @param item_ref      Optional item UUID for item-reference templates; pass
     *                      an empty string when unused.
     * @return              Request ID or -1 on immediate failure.
     */
    int post_note(int archetype_id, int anchor_tag, int template_id,
                  const Array &slots, const String &item_ref);

    /**
     * @brief Rate an existing note.
     *
     * Sends `POST /v1/notes/{note_id}/rate` with `{"val": +1 | -1}`.
     * Emits `note_rated(request_id, state, http_status)` on completion.
     *
     * @param note_id  UUID of the note to rate.
     * @param val      Rating value: +1 (up) or -1 (down).
     * @return         Request ID or -1 on immediate failure.
     */
    int rate_note(const String &note_id, int val);

  protected:
    static void _bind_methods();

  private:
    enum class RequestKind { FETCH_NOTES, POST_NOTE, RATE_NOTE };

    /// Heap-allocated per-transfer state.  Address is stable (never moves after
    /// push_back) so write-callback userdata pointers remain valid.
    struct InFlight {
        CURL *easy = nullptr;
        std::string url;          ///< kept alive because CURLOPT_URL doesn't copy
        std::string request_body; ///< POST body (must outlive transfer)
        std::string response_body;///< accumulated via write callback
        curl_slist *headers = nullptr;
        int request_id = 0;
        RequestKind kind = RequestKind::FETCH_NOTES;
    };

    CURLM *multi_ = nullptr;
    int running_ = 0;
    int next_request_id_ = 1;
    std::vector<std::unique_ptr<InFlight>> in_flight_;

    std::string base_url_;
    std::string auth_token_;
    std::string lease_id_;
    long timeout_ms_ = 5000;

    /**
     * @brief Enqueue a generic HTTP request.
     * @param url    Full URL.
     * @param method "GET" or "POST".
     * @param body   Request body (empty for GET).
     * @param kind   Request classification for signal routing.
     * @return       Request ID or -1 on curl initialisation failure.
     */
    int enqueue_request(const std::string &url, const std::string &method,
                        const std::string &body, RequestKind kind);

    /**
     * @brief Determine state and emit the completion signal for `req`.
     * @param req    The completed in-flight record.
     * @param result The CURLcode from `CURLMSG_DONE`.
     */
    void complete_request(const InFlight &req, CURLcode result);

    /// Remove a completed easy handle from multi and free all resources.
    void cleanup_easy(CURL *easy);

    /// Write callback: appends received bytes to InFlight::response_body.
    static size_t append_write(void *buf, size_t size, size_t nmemb, void *userdata);
};

} // namespace godot
