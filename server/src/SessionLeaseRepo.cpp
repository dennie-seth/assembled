#include "assembled_server/SessionLeaseRepo.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <random>

namespace assembled_server {

namespace {

/// Generate a UUID v4 string (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx).
/// Thread-safe: uses a mutex-protected Mersenne Twister seeded from
/// std::random_device on first call.
std::string generateUuid() {
    static std::mutex mtx;
    static std::mt19937 gen = []() {
        std::random_device rd;
        return std::mt19937(rd());
    }();
    static std::uniform_int_distribution<uint32_t> dist;

    std::array<uint8_t, 16> bytes{};
    {
        std::lock_guard<std::mutex> lock(mtx);
        for (int i = 0; i < 4; ++i) {
            const uint32_t r = dist(gen);
            bytes[static_cast<size_t>(i * 4 + 0)] = static_cast<uint8_t>(r >> 24u);
            bytes[static_cast<size_t>(i * 4 + 1)] = static_cast<uint8_t>(r >> 16u);
            bytes[static_cast<size_t>(i * 4 + 2)] = static_cast<uint8_t>(r >> 8u);
            bytes[static_cast<size_t>(i * 4 + 3)] = static_cast<uint8_t>(r);
        }
    }
    // Version 4, variant RFC 4122.
    bytes[6] = static_cast<uint8_t>((bytes[6] & 0x0Fu) | 0x40u);
    bytes[8] = static_cast<uint8_t>((bytes[8] & 0x3Fu) | 0x80u);

    char buf[37];
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    std::snprintf(buf, sizeof(buf),
                  "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-"
                  "%02x%02x%02x%02x%02x%02x",
                  bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                  bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14],
                  bytes[15]);
    return {buf};
}

} // namespace

SessionLeaseRepo::SessionLeaseRepo(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

LeaseResult SessionLeaseRepo::acquire(const std::string &token, std::chrono::seconds ttl) {
    const std::string lease_id = generateUuid();
    const std::string ttl_str = std::to_string(ttl.count());

    // UPSERT: one row per identity (INV-11).  ON CONFLICT overwrites the old
    // lease_id and expires_at, which is the eviction mechanism: the previous
    // client's lease_id is gone, so its next heartbeat returns false.
    client_->execSqlSync("INSERT INTO session_lease (token, lease_id, expires_at) "
                         "VALUES ($1, $2, now() + ($3::bigint * INTERVAL '1 second')) "
                         "ON CONFLICT (token) DO UPDATE SET "
                         "    lease_id   = EXCLUDED.lease_id, "
                         "    expires_at = EXCLUDED.expires_at",
                         token, lease_id, ttl_str);

    const auto expires_at = std::chrono::system_clock::now() + ttl;
    return {lease_id, expires_at};
}

bool SessionLeaseRepo::heartbeat(const std::string &token, const std::string &lease_id,
                                 std::chrono::seconds ttl) {
    const std::string ttl_str = std::to_string(ttl.count());

    // Only extend if the lease_id matches and the row has not yet expired.
    // A mismatch means takeover; an expired row means the TTL ran out.
    const auto result =
        client_->execSqlSync("UPDATE session_lease "
                             "SET expires_at = now() + ($3::bigint * INTERVAL '1 second') "
                             "WHERE token = $1 AND lease_id = $2 AND expires_at > now()",
                             token, lease_id, ttl_str);

    return result.affectedRows() > 0;
}

bool SessionLeaseRepo::isAlive(const std::string &token, const std::string &lease_id) {
    const auto result =
        client_->execSqlSync("SELECT 1 FROM session_lease "
                             "WHERE token = $1 AND lease_id = $2 AND expires_at > now() "
                             "LIMIT 1",
                             token, lease_id);

    return !result.empty();
}

} // namespace assembled_server
