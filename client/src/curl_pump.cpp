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
    for (CURL *easy : in_flight_) {
        // Retrieve the heap-allocated URL string stored as private data.
        char *raw = nullptr;
        curl_easy_getinfo(easy, CURLINFO_PRIVATE, &raw);
        delete reinterpret_cast<std::string *>(raw); // NOLINT(cppcoreguidelines-owning-memory)

        curl_multi_remove_handle(multi_, easy);
        curl_easy_cleanup(easy);
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

void CurlPump::_process(double delta) { tick(delta); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void CurlPump::tick(double /*delta*/) {
    if (!multi_) {
        return;
    }

    // Non-blocking: pump whatever I/O work is ready without waiting.
    curl_multi_perform(multi_, &running_);

    // Drain completed transfer messages and free finished handles.
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

    // CURLOPT_URL does not copy the string — we need the buffer to outlive
    // the transfer.  Heap-allocate an std::string and recover it in
    // cleanup_easy() via CURLINFO_PRIVATE.
    auto *owned_url = new std::string(url.utf8().get_data()); // NOLINT(cppcoreguidelines-owning-memory)

    curl_easy_setopt(easy, CURLOPT_URL, owned_url->c_str());
    // Thread safety: never deliver signals from libcurl.
    curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
    // Discard the response body; T-0063 adds a real data sink.
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, &CurlPump::discard_write);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, 5000L);
    curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT_MS, 2000L);
    // Carry the owned URL pointer so cleanup_easy() can free it.
    curl_easy_setopt(easy, CURLOPT_PRIVATE, owned_url);

    CURLMcode rc = curl_multi_add_handle(multi_, easy);
    if (rc != CURLM_OK) {
        delete owned_url; // NOLINT(cppcoreguidelines-owning-memory)
        curl_easy_cleanup(easy);
        return;
    }

    in_flight_.push_back(easy);
}

int CurlPump::get_running_count() const { return running_; }

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

size_t CurlPump::discard_write(void * /*buf*/, size_t size, size_t nmemb,
                                void * /*userdata*/) {
    return size * nmemb;
}

void CurlPump::cleanup_easy(CURL *easy) {
    char *raw = nullptr;
    curl_easy_getinfo(easy, CURLINFO_PRIVATE, &raw);
    delete reinterpret_cast<std::string *>(raw); // NOLINT(cppcoreguidelines-owning-memory)

    curl_multi_remove_handle(multi_, easy);
    curl_easy_cleanup(easy);

    auto it = std::find(in_flight_.begin(), in_flight_.end(), easy);
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

    ADD_PROPERTY(PropertyInfo(Variant::INT, "running_count"), "",
                 "get_running_count");
}

} // namespace godot
