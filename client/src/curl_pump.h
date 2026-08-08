/**
 * @file curl_pump.h
 * @brief GDExtension Node that vendors libcurl and drives its multi-handle
 *        from Godot's _process callback — the non-blocking HTTP foundation
 *        for NoteClient (T-0063).
 *
 * Design contract
 * ---------------
 * - One `CurlPump` node per scene tree.  Add it as an autoload or as a child
 *   of the scene root; it enables processing in `_ready()` automatically.
 * - `_process()` delegates entirely to `tick()`.  Tests call `tick()` directly
 *   to drive the pump without a running game loop.
 * - `enqueue_get()` fires a one-shot GET request.  Responses are currently
 *   discarded (data sink is a no-op write callback).  T-0063 will replace this
 *   with a signal-based completion API so NoteClient can handle results.
 * - `curl_global_init` / `curl_global_cleanup` are called in the constructor /
 *   destructor.  Only one `CurlPump` should exist at a time.
 */

#pragma once

#include <curl/curl.h>
#include <godot_cpp/classes/node.hpp>
#include <godot_cpp/core/binder_common.hpp>

#include <string>
#include <vector>

namespace godot {

/**
 * @brief Non-blocking HTTP pump driven from `_process`.
 *
 * Wraps a `CURLM*` multi-handle.  Each `tick()` calls `curl_multi_perform()`
 * once — O(1), non-blocking — then drains completed-message info from the
 * multi-handle's internal ring buffer.
 */
class CurlPump : public Node {
    GDCLASS(CurlPump, Node)

  public:
    CurlPump();
    ~CurlPump() override;

    /// Called by the engine each frame; delegates to tick().
    void _process(double delta) override;

    /**
     * @brief Drive the multi-handle for one frame tick.
     *
     * Calls `curl_multi_perform()` (non-blocking) and drains any completed
     * transfer messages from the multi-handle's info queue.  Completed easy
     * handles are removed and cleaned up automatically.
     *
     * Public so that headless tests can call it directly without a running
     * scene tree (T-0062 timing test).
     *
     * @param delta Seconds since the last frame (passed through from
     *              `_process`; not used by the multi-handle but preserved
     *              so the signature mirrors the engine contract).
     */
    void tick(double delta);

    /**
     * @brief Enqueue a fire-and-forget HTTP GET request.
     *
     * The response body is discarded.  T-0063 will add a result-signal variant
     * that forwards the body to GDScript.
     *
     * @param url Full URL including scheme, e.g. "http://127.0.0.1:8080/ping".
     *            Invalid URLs produce a no-op (the easy handle is cleaned up
     *            without being added to the multi).
     */
    void enqueue_get(const String &url);

    /**
     * @brief Number of transfers currently running inside the multi-handle.
     * @return Count returned by the most recent `curl_multi_perform()` call,
     *         or 0 if the multi-handle was never initialised.
     */
    int get_running_count() const;

  protected:
    static void _bind_methods();

  private:
    CURLM *multi_ = nullptr;
    int running_ = 0;

    /// Owned easy handles currently tracked by the multi-handle.
    std::vector<CURL *> in_flight_;

    /// Discard-all write callback (response body not needed by this layer).
    static size_t discard_write(void *buf, size_t size, size_t nmemb,
                                void *userdata);

    /// Remove a completed easy handle from the multi and free all resources.
    void cleanup_easy(CURL *easy);
};

} // namespace godot
