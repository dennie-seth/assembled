#include "curl_pump.h"

#include <godot_cpp/core/class_db.hpp>

#include <algorithm>

namespace godot {

// ---------------------------------------------------------------------------
// Construction / destruction
// ---------------------------------------------------------------------------

CurlPump::CurlPump() {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    multi_ = curl_multi_init();
}

CurlPump::~CurlPump() {
    for (InFlight &entry : in_flight_) {
        curl_multi_remove_handle(multi_, entry.easy);
        curl_easy_cleanup(entry.easy);
    }
    in_flight_.clear();

    if (multi_) {
        curl_multi_cleanup(multi_);
        multi_ = nullptr;
    }

    curl_global_cleanup();
}

// ---------------------------------------------------------------------------
// Node overrides
// ---------------------------------------------------------------------------

void CurlPump::_ready() { set_process(true); }

void CurlPump::_process(double delta) { tick(delta); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void CurlPump::tick(double /*delta*/) {
    if (!multi_) {
        return;
    }

    // Non-blocking: pump whatever I/O is ready without waiting for more.
    curl_multi_perform(multi_, &running_);

    // Drain completed transfer messages and release finished handles.
    int msgs = 0;
    while (CURLMsg *msg = curl_multi_info_read(multi_, &msgs)) {
        if (msg->msg == CURLMSG_DONE) {
            cleanup_easy(msg->easy_handle);
        }
    }
}

void CurlPump::enqueue_get(const String &url) {
    if (!multi_) {
        return;
    }

    CURL *easy = curl_easy_init();
    if (!easy) {
        return;
    }

    // Store the URL in an InFlight entry before passing its c_str() to curl.
    // CURLOPT_URL does NOT copy the string; the buffer must outlive the
    // transfer.  Storing it in the struct guarantees that.
    in_flight_.push_back({easy, std::string(url.utf8().get_data())});
    const std::string &stored = in_flight_.back().url;

    curl_easy_setopt(easy, CURLOPT_URL, stored.c_str());
    // Prevent libcurl from delivering signals on the game's main thread.
    curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
    // Discard the response body; T-0063 adds a real data sink.
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, &CurlPump::discard_write);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, 5000L);
    curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT_MS, 2000L);

    CURLMcode rc = curl_multi_add_handle(multi_, easy);
    if (rc != CURLM_OK) {
        in_flight_.pop_back(); // rolls back the entry we just pushed
        curl_easy_cleanup(easy);
    }
}

int CurlPump::get_running_count() const { return running_; }

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

size_t CurlPump::discard_write(void * /*buf*/, size_t size, size_t nmemb, void * /*userdata*/) {
    return size * nmemb;
}

void CurlPump::cleanup_easy(CURL *easy) {
    curl_multi_remove_handle(multi_, easy);
    curl_easy_cleanup(easy);

    auto it = std::find_if(in_flight_.begin(), in_flight_.end(),
                           [easy](const InFlight &e) { return e.easy == easy; });
    if (it != in_flight_.end()) {
        in_flight_.erase(it);
    }
}

// ---------------------------------------------------------------------------
// GDExtension binding
// ---------------------------------------------------------------------------

void CurlPump::_bind_methods() {
    ClassDB::bind_method(D_METHOD("tick", "delta"), &CurlPump::tick);
    ClassDB::bind_method(D_METHOD("enqueue_get", "url"), &CurlPump::enqueue_get);
    ClassDB::bind_method(D_METHOD("get_running_count"), &CurlPump::get_running_count);

    ADD_PROPERTY(PropertyInfo(Variant::INT, "running_count"), "", "get_running_count");
}

} // namespace godot
