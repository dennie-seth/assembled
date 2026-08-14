/**
 * @file item_client.h
 * @brief GDExtension Node wrapping the game's item transfer API (T-0177).
 *
 * Exposes three operations to GDScript:
 *   - take_item()        — POST /v1/transfers (kind=take), client-minted UUID transfer_id
 *   - leave_item()       — POST /v1/transfers (kind=leave), client-minted UUID transfer_id
 *   - retry_transfer()   — GET /v1/transfers/{transfer_id} (idempotent receipt lookup)
 *
 * Every operation is non-blocking.  Results arrive via the `transfer_completed`
 * signal which carries `state` from the `State` enum, the raw HTTP status, the
 * response body (receipt JSON on success), and the `transfer_id` that was used.
 *
 * Idempotency contract (T-0126)
 * ------------------------------
 * The client mints a UUID v4 `transfer_id` before issuing any POST.  If the
 * server response is dropped the caller retries via `retry_transfer(transfer_id)`
 * which sends `GET /v1/transfers/{id}` — a read of the already-stored receipt.
 * The server never re-executes the compare-and-swap on a repeated `transfer_id`.
 *
 * CAS conflict (one-taker rule, 07-items-economy.md §3)
 * -------------------------------------------------------
 * A 409 response means the server-side CAS lost — the item was already taken by
 * a concurrent caller.  This surfaces as `STATE_CAS_CONFLICT` (not
 * `STATE_HTTP_4XX` or `STATE_NETWORK_ERROR`) so GDScript can render "someone
 * else got there first" without inspecting the raw status code.
 *
 * Offline / degraded mode (T-0067)
 * ----------------------------------
 * When the server is unreachable, operations time out and emit
 * `STATE_TIMEOUT`; the interaction is unavailable, not a crash.  The caller is
 * responsible for surfacing this to the player (see 03-net-protocol.md §6).
 *
 * Design notes
 * ------------
 * - `_process()` delegates to `tick()`.  Tests call `tick()` directly so they
 *   can drive the pump without a running scene tree.
 * - `curl_global_init` / `curl_global_cleanup` are called once per instance.
 *   Only one ItemClient should exist per process at a time.
 * - Each in-flight request is heap-allocated (`unique_ptr<InFlight>`) so its
 *   address is stable across vector reallocations; the write-callback userdata
 *   pointer remains valid for the lifetime of the transfer.
 */

#pragma once

#include <curl/curl.h>
#include <godot_cpp/classes/node.hpp>
#include <godot_cpp/core/binder_common.hpp>
#include <godot_cpp/variant/string.hpp>

#include <memory>
#include <string>
#include <vector>

namespace godot {

/**
 * @brief Non-blocking item-transfer API client driven from `_process`.
 *
 * Wraps a `CURLM*` multi-handle; each `tick()` call is O(1) / non-blocking.
 * Completed transfers emit the `transfer_completed` signal that distinguishes
 * timeout, network errors, HTTP errors, and CAS conflicts via the `State` enum.
 */
class ItemClient : public Node {
    GDCLASS(ItemClient, Node)

  public:
    /// Client-side result state for each API call.
    /// Carried as the `state` argument on `transfer_completed`.
    enum State {
        STATE_OK = 0,            ///< 2xx response received.
        STATE_TIMEOUT = 1,       ///< Connect or transfer timed out.
        STATE_HTTP_4XX = 2,      ///< HTTP 4xx response (excluding 409).
        STATE_HTTP_5XX = 3,      ///< HTTP 5xx response.
        STATE_NETWORK_ERROR = 4, ///< curl error other than timeout.
        STATE_CAS_CONFLICT = 5,  ///< 409 TRANSFER_LOST — "someone else got there first."
    };

    ItemClient();
    ~ItemClient() override;

    /// Enable `_process` once the node enters the scene tree.
    void _ready() override;

    /// Called by the engine each frame; delegates to `tick()`.
    void _process(double delta) override;

    /**
     * @brief Drive the multi-handle for one frame tick.
     *
     * Calls `curl_multi_perform()` then drains completed transfer messages and
     * emits `transfer_completed` for each one.  Public so headless tests can
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

    /// @brief Set the lease ID added as `X-Lease-Id` on POST mutations.
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
     * @brief Take a loose item from an anchor into holding.
     *
     * Mints a UUID v4 `transfer_id`, then sends:
     *   `POST /v1/transfers`
     *   `{ "transfer_id": "<uuid>", "kind": "take", "item_id": "<id>",
     *      "anchor": { "archetype": <arch>, "tag": <tag> } }`
     *
     * Emits `transfer_completed(request_id, state, http_status, body, transfer_id)`
     * on completion.  A 409 response emits `STATE_CAS_CONFLICT`.
     *
     * @param item_id   UUID of the item instance to take.
     * @param archetype Archetype ID of the anchor.
     * @param tag       Anchor tag within the archetype.
     * @return          Request ID (positive) for correlation, or -1 on
     *                  immediate failure (multi-handle not initialised).
     */
    int take_item(const String &item_id, int archetype, int tag);

    /**
     * @brief Leave a held item at an anchor.
     *
     * Mints a UUID v4 `transfer_id`, then sends:
     *   `POST /v1/transfers`
     *   `{ "transfer_id": "<uuid>", "kind": "leave", "item_id": "<id>",
     *      "anchor": { "archetype": <arch>, "tag": <tag> } }`
     *
     * Emits `transfer_completed(request_id, state, http_status, body, transfer_id)`
     * on completion.
     *
     * @param item_id   UUID of the item instance to leave.
     * @param archetype Archetype ID of the anchor.
     * @param tag       Anchor tag within the archetype.
     * @return          Request ID or -1 on immediate failure.
     */
    int leave_item(const String &item_id, int archetype, int tag);

    /**
     * @brief Retry a prior transfer by its client-minted `transfer_id`.
     *
     * Sends `GET /v1/transfers/{transfer_id}` to retrieve the stored receipt
     * without re-executing the compare-and-swap.  Use this after a dropped
     * server response to recover the original outcome idempotently.
     *
     * Emits `transfer_completed(request_id, state, http_status, body, transfer_id)`
     * on completion, with `transfer_id` equal to the argument passed in.
     *
     * @param transfer_id UUID previously returned in a `transfer_completed` signal.
     * @return            Request ID or -1 on immediate failure.
     */
    int retry_transfer(const String &transfer_id);

  protected:
    static void _bind_methods();

  private:
    enum class RequestKind { TAKE, LEAVE, RETRY };

    /// Heap-allocated per-transfer state.  Address is stable (never moves after
    /// push_back) so write-callback userdata pointers remain valid.
    struct InFlight {
        CURL *easy = nullptr;
        std::string url;           ///< kept alive because CURLOPT_URL doesn't copy
        std::string request_body;  ///< POST body (must outlive transfer)
        std::string response_body; ///< accumulated via write callback
        curl_slist *headers = nullptr;
        int request_id = 0;
        RequestKind kind = RequestKind::TAKE;
        std::string transfer_id; ///< client-minted UUID (or caller-supplied on retry)
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
     * @brief Generate a RFC-4122 UUID v4 string.
     *
     * Uses `std::random_device` seeded `std::mt19937` for portability.
     * Output format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` (lower-case hex).
     *
     * @return 36-character UUID string.
     */
    static std::string make_uuid_v4();

    /**
     * @brief Enqueue a transfer POST or retry GET.
     * @param url          Full request URL.
     * @param method       "GET" or "POST".
     * @param body         Request body (empty for GET).
     * @param kind         Request classification for signal routing.
     * @param transfer_id  The UUID to echo back in the completion signal.
     * @return             Request ID or -1 on curl initialisation failure.
     */
    int enqueue_request(const std::string &url, const std::string &method,
                        const std::string &body, RequestKind kind,
                        const std::string &transfer_id);

    /**
     * @brief Determine state and emit `transfer_completed` for `req`.
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
