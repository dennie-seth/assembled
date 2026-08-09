#include "note_client.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <algorithm>
#include <string>

namespace godot {

// ---------------------------------------------------------------------------
// Construction / destruction
// ---------------------------------------------------------------------------

NoteClient::NoteClient() {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    multi_ = curl_multi_init();
}

NoteClient::~NoteClient() {
    // Clean up every in-flight transfer before tearing down the multi-handle.
    for (auto &entry : in_flight_) {
        curl_multi_remove_handle(multi_, entry->easy);
        if (entry->headers) {
            curl_slist_free_all(entry->headers);
        }
        curl_easy_cleanup(entry->easy);
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

void NoteClient::_ready() { set_process(true); }

void NoteClient::_process(double delta) { tick(delta); }

// ---------------------------------------------------------------------------
// Tick — non-blocking pump
// ---------------------------------------------------------------------------

void NoteClient::tick(double /*delta*/) {
    if (!multi_) {
        return;
    }

    curl_multi_perform(multi_, &running_);

    // Collect all completed messages before processing any of them; modifying
    // in_flight_ while iterating curl_multi_info_read is safe because the
    // info queue is separate from the active-handles list, but we must not
    // call curl_multi_remove_handle while still reading from the queue.
    struct Done {
        CURL *easy;
        CURLcode result;
    };
    std::vector<Done> done;

    int msgs = 0;
    while (CURLMsg *msg = curl_multi_info_read(multi_, &msgs)) {
        if (msg->msg == CURLMSG_DONE) {
            done.push_back({msg->easy_handle, msg->data.result});
        }
    }

    for (const Done &d : done) {
        auto it = std::find_if(
            in_flight_.begin(), in_flight_.end(),
            [&d](const std::unique_ptr<InFlight> &e) { return e->easy == d.easy; });
        if (it != in_flight_.end()) {
            complete_request(**it, d.result);
        }
        cleanup_easy(d.easy);
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

void NoteClient::set_base_url(const String &url) {
    base_url_ = std::string(url.utf8().get_data());
}

String NoteClient::get_base_url() const { return String(base_url_.c_str()); }

void NoteClient::set_auth_token(const String &token) {
    auth_token_ = std::string(token.utf8().get_data());
}

String NoteClient::get_auth_token() const { return String(auth_token_.c_str()); }

void NoteClient::set_lease_id(const String &lease_id) {
    lease_id_ = std::string(lease_id.utf8().get_data());
}

String NoteClient::get_lease_id() const { return String(lease_id_.c_str()); }

void NoteClient::set_timeout_ms(int ms) { timeout_ms_ = static_cast<long>(ms); }

int NoteClient::get_timeout_ms() const { return static_cast<int>(timeout_ms_); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

int NoteClient::fetch_notes(int archetype_id, int anchor_tag, int limit) {
    std::string url = base_url_ + "/v1/notes?archetype=" + std::to_string(archetype_id) +
                      "&tag=" + std::to_string(anchor_tag) + "&limit=" + std::to_string(limit);
    return enqueue_request(url, "GET", "", RequestKind::FETCH_NOTES);
}

int NoteClient::post_note(int archetype_id, int anchor_tag, int template_id,
                           const Array &slots, const String &item_ref) {
    std::string body = "{\"archetype\":" + std::to_string(archetype_id) +
                       ",\"tag\":" + std::to_string(anchor_tag) +
                       ",\"template_id\":" + std::to_string(template_id) + ",\"slots\":[";
    for (int i = 0; i < slots.size(); ++i) {
        if (i > 0) {
            body += ",";
        }
        body += std::to_string(static_cast<int>(slots[i]));
    }
    body += "]";
    if (!item_ref.is_empty()) {
        body += ",\"item_ref\":\"" + std::string(item_ref.utf8().get_data()) + "\"";
    }
    body += "}";

    std::string url = base_url_ + "/v1/notes";
    return enqueue_request(url, "POST", body, RequestKind::POST_NOTE);
}

int NoteClient::rate_note(const String &note_id, int val) {
    std::string url = base_url_ + "/v1/notes/" + std::string(note_id.utf8().get_data()) + "/rate";
    std::string body = "{\"val\":" + std::to_string(val) + "}";
    return enqueue_request(url, "POST", body, RequestKind::RATE_NOTE);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

int NoteClient::enqueue_request(const std::string &url, const std::string &method,
                                  const std::string &body, RequestKind kind) {
    if (!multi_) {
        return -1;
    }

    CURL *easy = curl_easy_init();
    if (!easy) {
        return -1;
    }

    auto inflight = std::make_unique<InFlight>();
    inflight->easy = easy;
    inflight->url = url;
    inflight->request_body = body;
    inflight->kind = kind;
    inflight->request_id = next_request_id_++;

    const int req_id = inflight->request_id;
    InFlight *raw = inflight.get();

    curl_easy_setopt(easy, CURLOPT_URL, raw->url.c_str());
    curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, &NoteClient::append_write);
    curl_easy_setopt(easy, CURLOPT_WRITEDATA, raw);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, timeout_ms_);
    curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT_MS, timeout_ms_);

    // Auth headers — present on every request.
    if (!auth_token_.empty()) {
        raw->headers = curl_slist_append(raw->headers,
                                         ("Authorization: Bearer " + auth_token_).c_str());
    }
    if (method == "POST") {
        // Mutations additionally carry the lease ID (docs/design/03-net-protocol.md §2).
        if (!lease_id_.empty()) {
            raw->headers =
                curl_slist_append(raw->headers, ("X-Lease-Id: " + lease_id_).c_str());
        }
        raw->headers = curl_slist_append(raw->headers, "Content-Type: application/json");
    }
    if (raw->headers) {
        curl_easy_setopt(easy, CURLOPT_HTTPHEADER, raw->headers);
    }

    if (method == "POST") {
        curl_easy_setopt(easy, CURLOPT_POST, 1L);
        curl_easy_setopt(easy, CURLOPT_POSTFIELDS, raw->request_body.c_str());
        curl_easy_setopt(easy, CURLOPT_POSTFIELDSIZE, static_cast<long>(raw->request_body.size()));
    }

    const CURLMcode rc = curl_multi_add_handle(multi_, easy);
    if (rc != CURLM_OK) {
        if (raw->headers) {
            curl_slist_free_all(raw->headers);
        }
        curl_easy_cleanup(easy);
        return -1;
    }

    in_flight_.push_back(std::move(inflight));
    return req_id;
}

void NoteClient::complete_request(const InFlight &req, CURLcode result) {
    long http_status = 0;
    int state = STATE_OK;

    if (result == CURLE_OPERATION_TIMEDOUT) {
        state = STATE_TIMEOUT;
        // http_status stays 0 — no response was received.
    } else if (result != CURLE_OK) {
        state = STATE_NETWORK_ERROR;
    } else {
        curl_easy_getinfo(req.easy, CURLINFO_RESPONSE_CODE, &http_status);
        if (http_status >= 500) {
            state = STATE_HTTP_5XX;
        } else if (http_status >= 400) {
            state = STATE_HTTP_4XX;
        } else {
            state = STATE_OK;
        }
    }

    const String body =
        String::utf8(req.response_body.c_str(), static_cast<int>(req.response_body.size()));
    const int status_int = static_cast<int>(http_status);

    switch (req.kind) {
    case RequestKind::FETCH_NOTES:
        emit_signal("notes_fetched", req.request_id, state, status_int, body);
        break;
    case RequestKind::POST_NOTE:
        emit_signal("note_posted", req.request_id, state, status_int, body);
        break;
    case RequestKind::RATE_NOTE:
        emit_signal("note_rated", req.request_id, state, status_int);
        break;
    }
}

void NoteClient::cleanup_easy(CURL *easy) {
    curl_multi_remove_handle(multi_, easy);

    auto it = std::find_if(in_flight_.begin(), in_flight_.end(),
                           [easy](const std::unique_ptr<InFlight> &e) { return e->easy == easy; });
    if (it != in_flight_.end()) {
        if ((*it)->headers) {
            curl_slist_free_all((*it)->headers);
            (*it)->headers = nullptr;
        }
        in_flight_.erase(it);
    }

    curl_easy_cleanup(easy);
}

size_t NoteClient::append_write(void *buf, size_t size, size_t nmemb, void *userdata) {
    auto *inflight = static_cast<InFlight *>(userdata);
    inflight->response_body.append(static_cast<char *>(buf), size * nmemb);
    return size * nmemb;
}

// ---------------------------------------------------------------------------
// GDExtension binding
// ---------------------------------------------------------------------------

void NoteClient::_bind_methods() {
    // Tick (public for headless tests)
    ClassDB::bind_method(D_METHOD("tick", "delta"), &NoteClient::tick);

    // Config
    ClassDB::bind_method(D_METHOD("set_base_url", "url"), &NoteClient::set_base_url);
    ClassDB::bind_method(D_METHOD("get_base_url"), &NoteClient::get_base_url);
    ClassDB::bind_method(D_METHOD("set_auth_token", "token"), &NoteClient::set_auth_token);
    ClassDB::bind_method(D_METHOD("get_auth_token"), &NoteClient::get_auth_token);
    ClassDB::bind_method(D_METHOD("set_lease_id", "lease_id"), &NoteClient::set_lease_id);
    ClassDB::bind_method(D_METHOD("get_lease_id"), &NoteClient::get_lease_id);
    ClassDB::bind_method(D_METHOD("set_timeout_ms", "ms"), &NoteClient::set_timeout_ms);
    ClassDB::bind_method(D_METHOD("get_timeout_ms"), &NoteClient::get_timeout_ms);

    ADD_PROPERTY(PropertyInfo(Variant::STRING, "base_url"), "set_base_url", "get_base_url");
    ADD_PROPERTY(PropertyInfo(Variant::STRING, "auth_token"), "set_auth_token", "get_auth_token");
    ADD_PROPERTY(PropertyInfo(Variant::STRING, "lease_id"), "set_lease_id", "get_lease_id");
    ADD_PROPERTY(PropertyInfo(Variant::INT, "timeout_ms"), "set_timeout_ms", "get_timeout_ms");

    // API
    ClassDB::bind_method(D_METHOD("fetch_notes", "archetype_id", "anchor_tag", "limit"),
                         &NoteClient::fetch_notes);
    ClassDB::bind_method(
        D_METHOD("post_note", "archetype_id", "anchor_tag", "template_id", "slots", "item_ref"),
        &NoteClient::post_note);
    ClassDB::bind_method(D_METHOD("rate_note", "note_id", "val"), &NoteClient::rate_note);

    // Signals
    ADD_SIGNAL(MethodInfo("notes_fetched",
                          PropertyInfo(Variant::INT, "request_id"),
                          PropertyInfo(Variant::INT, "state"),
                          PropertyInfo(Variant::INT, "http_status"),
                          PropertyInfo(Variant::STRING, "body")));
    ADD_SIGNAL(MethodInfo("note_posted",
                          PropertyInfo(Variant::INT, "request_id"),
                          PropertyInfo(Variant::INT, "state"),
                          PropertyInfo(Variant::INT, "http_status"),
                          PropertyInfo(Variant::STRING, "body")));
    ADD_SIGNAL(MethodInfo("note_rated",
                          PropertyInfo(Variant::INT, "request_id"),
                          PropertyInfo(Variant::INT, "state"),
                          PropertyInfo(Variant::INT, "http_status")));

    // State enum constants — accessible in GDScript as NoteClient.STATE_*
    BIND_CONSTANT(STATE_OK);
    BIND_CONSTANT(STATE_TIMEOUT);
    BIND_CONSTANT(STATE_HTTP_4XX);
    BIND_CONSTANT(STATE_HTTP_5XX);
    BIND_CONSTANT(STATE_NETWORK_ERROR);
}

} // namespace godot
