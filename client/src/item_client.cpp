#include "item_client.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <algorithm>
#include <cstdio>
#include <random>
#include <string>

namespace godot {

// ---------------------------------------------------------------------------
// Construction / destruction
// ---------------------------------------------------------------------------

ItemClient::ItemClient() {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    multi_ = curl_multi_init();
}

ItemClient::~ItemClient() {
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

void ItemClient::_ready() { set_process(true); }

void ItemClient::_process(double delta) { tick(delta); }

// ---------------------------------------------------------------------------
// Tick — non-blocking pump
// ---------------------------------------------------------------------------

void ItemClient::tick(double /*delta*/) {
    if (!multi_) {
        return;
    }

    curl_multi_perform(multi_, &running_);

    // Collect completed messages before processing to avoid modifying
    // in_flight_ while iterating the curl info queue.
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

void ItemClient::set_base_url(const String &url) {
    base_url_ = std::string(url.utf8().get_data());
}

String ItemClient::get_base_url() const { return String(base_url_.c_str()); }

void ItemClient::set_auth_token(const String &token) {
    auth_token_ = std::string(token.utf8().get_data());
}

String ItemClient::get_auth_token() const { return String(auth_token_.c_str()); }

void ItemClient::set_lease_id(const String &lease_id) {
    lease_id_ = std::string(lease_id.utf8().get_data());
}

String ItemClient::get_lease_id() const { return String(lease_id_.c_str()); }

void ItemClient::set_timeout_ms(int ms) { timeout_ms_ = static_cast<long>(ms); }

int ItemClient::get_timeout_ms() const { return static_cast<int>(timeout_ms_); }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

int ItemClient::take_item(const String &item_id, int archetype, int tag) {
    const std::string tid = make_uuid_v4();
    const std::string url = base_url_ + "/v1/transfers";
    const std::string body =
        "{\"transfer_id\":\"" + tid + "\","
        "\"kind\":\"take\","
        "\"item_id\":\"" + std::string(item_id.utf8().get_data()) + "\","
        "\"anchor\":{\"archetype\":" + std::to_string(archetype) +
        ",\"tag\":" + std::to_string(tag) + "}}";
    return enqueue_request(url, "POST", body, RequestKind::TAKE, tid);
}

int ItemClient::leave_item(const String &item_id, int archetype, int tag) {
    const std::string tid = make_uuid_v4();
    const std::string url = base_url_ + "/v1/transfers";
    const std::string body =
        "{\"transfer_id\":\"" + tid + "\","
        "\"kind\":\"leave\","
        "\"item_id\":\"" + std::string(item_id.utf8().get_data()) + "\","
        "\"anchor\":{\"archetype\":" + std::to_string(archetype) +
        ",\"tag\":" + std::to_string(tag) + "}}";
    return enqueue_request(url, "POST", body, RequestKind::LEAVE, tid);
}

int ItemClient::retry_transfer(const String &transfer_id) {
    const std::string tid = std::string(transfer_id.utf8().get_data());
    const std::string url = base_url_ + "/v1/transfers/" + tid;
    return enqueue_request(url, "GET", "", RequestKind::RETRY, tid);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

std::string ItemClient::make_uuid_v4() {
    // Use std::random_device + mt19937 for portability (no platform-specific
    // syscalls); sufficient entropy for a client-minted idempotency key.
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<unsigned int> d8(0, 0xff);

    uint8_t b[16];
    for (auto &byte : b) {
        byte = static_cast<uint8_t>(d8(gen));
    }
    // Version 4: top nibble of byte 6 = 0100
    b[6] = static_cast<uint8_t>((b[6] & 0x0f) | 0x40);
    // Variant 10xx: top two bits of byte 8
    b[8] = static_cast<uint8_t>((b[8] & 0x3f) | 0x80);

    char buf[37];
    // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    std::snprintf(buf, sizeof(buf),
                  "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                  b[0], b[1], b[2], b[3],
                  b[4], b[5],
                  b[6], b[7],
                  b[8], b[9],
                  b[10], b[11], b[12], b[13], b[14], b[15]);
    return std::string(buf);
}

int ItemClient::enqueue_request(const std::string &url, const std::string &method,
                                const std::string &body, RequestKind kind,
                                const std::string &transfer_id) {
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
    inflight->transfer_id = transfer_id;
    inflight->request_id = next_request_id_++;

    const int req_id = inflight->request_id;
    InFlight *raw = inflight.get();

    curl_easy_setopt(easy, CURLOPT_URL, raw->url.c_str());
    curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, &ItemClient::append_write);
    curl_easy_setopt(easy, CURLOPT_WRITEDATA, raw);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, timeout_ms_);
    curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT_MS, timeout_ms_);

    if (!auth_token_.empty()) {
        raw->headers = curl_slist_append(
            raw->headers, ("Authorization: Bearer " + auth_token_).c_str());
    }
    if (method == "POST") {
        // Mutations carry the lease ID (03-net-protocol.md §2).
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
        curl_easy_setopt(easy, CURLOPT_POSTFIELDSIZE,
                         static_cast<long>(raw->request_body.size()));
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

void ItemClient::complete_request(const InFlight &req, CURLcode result) {
    long http_status = 0;
    int state = STATE_OK;

    if (result == CURLE_OPERATION_TIMEDOUT) {
        state = STATE_TIMEOUT;
    } else if (result != CURLE_OK) {
        state = STATE_NETWORK_ERROR;
    } else {
        curl_easy_getinfo(req.easy, CURLINFO_RESPONSE_CODE, &http_status);
        if (http_status == 409) {
            // CAS lost: another caller took this item first (TRANSFER_LOST 3001).
            // Surfaced distinctly so GDScript can render "someone else got there
            // first" — not the generic STATE_HTTP_4XX (03-net-protocol.md §3).
            state = STATE_CAS_CONFLICT;
        } else if (http_status >= 500) {
            state = STATE_HTTP_5XX;
        } else if (http_status >= 400) {
            state = STATE_HTTP_4XX;
        } else {
            state = STATE_OK;
        }
    }

    const String body = String::utf8(req.response_body.c_str(),
                                     static_cast<int>(req.response_body.size()));
    const int status_int = static_cast<int>(http_status);
    const String tid = String(req.transfer_id.c_str());

    emit_signal("transfer_completed", req.request_id, state, status_int, body, tid);
}

void ItemClient::cleanup_easy(CURL *easy) {
    curl_multi_remove_handle(multi_, easy);

    auto it = std::find_if(
        in_flight_.begin(), in_flight_.end(),
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

size_t ItemClient::append_write(void *buf, size_t size, size_t nmemb, void *userdata) {
    auto *inflight = static_cast<InFlight *>(userdata);
    inflight->response_body.append(static_cast<char *>(buf), size * nmemb);
    return size * nmemb;
}

// ---------------------------------------------------------------------------
// GDExtension binding
// ---------------------------------------------------------------------------

void ItemClient::_bind_methods() {
    // Tick (public for headless tests)
    ClassDB::bind_method(D_METHOD("tick", "delta"), &ItemClient::tick);

    // Config
    ClassDB::bind_method(D_METHOD("set_base_url", "url"), &ItemClient::set_base_url);
    ClassDB::bind_method(D_METHOD("get_base_url"), &ItemClient::get_base_url);
    ClassDB::bind_method(D_METHOD("set_auth_token", "token"), &ItemClient::set_auth_token);
    ClassDB::bind_method(D_METHOD("get_auth_token"), &ItemClient::get_auth_token);
    ClassDB::bind_method(D_METHOD("set_lease_id", "lease_id"), &ItemClient::set_lease_id);
    ClassDB::bind_method(D_METHOD("get_lease_id"), &ItemClient::get_lease_id);
    ClassDB::bind_method(D_METHOD("set_timeout_ms", "ms"), &ItemClient::set_timeout_ms);
    ClassDB::bind_method(D_METHOD("get_timeout_ms"), &ItemClient::get_timeout_ms);

    ADD_PROPERTY(PropertyInfo(Variant::STRING, "base_url"), "set_base_url", "get_base_url");
    ADD_PROPERTY(PropertyInfo(Variant::STRING, "auth_token"), "set_auth_token",
                 "get_auth_token");
    ADD_PROPERTY(PropertyInfo(Variant::STRING, "lease_id"), "set_lease_id", "get_lease_id");
    ADD_PROPERTY(PropertyInfo(Variant::INT, "timeout_ms"), "set_timeout_ms", "get_timeout_ms");

    // API
    ClassDB::bind_method(D_METHOD("take_item", "item_id", "archetype", "tag"),
                         &ItemClient::take_item);
    ClassDB::bind_method(D_METHOD("leave_item", "item_id", "archetype", "tag"),
                         &ItemClient::leave_item);
    ClassDB::bind_method(D_METHOD("retry_transfer", "transfer_id"),
                         &ItemClient::retry_transfer);

    // Signal: transfer_completed(request_id, state, http_status, body, transfer_id)
    ADD_SIGNAL(MethodInfo(
        "transfer_completed",
        PropertyInfo(Variant::INT, "request_id"),
        PropertyInfo(Variant::INT, "state"),
        PropertyInfo(Variant::INT, "http_status"),
        PropertyInfo(Variant::STRING, "body"),
        PropertyInfo(Variant::STRING, "transfer_id")));

    // State enum constants — accessible in GDScript as ItemClient.STATE_*
    BIND_CONSTANT(STATE_OK);
    BIND_CONSTANT(STATE_TIMEOUT);
    BIND_CONSTANT(STATE_HTTP_4XX);
    BIND_CONSTANT(STATE_HTTP_5XX);
    BIND_CONSTANT(STATE_NETWORK_ERROR);
    BIND_CONSTANT(STATE_CAS_CONFLICT);
}

} // namespace godot
