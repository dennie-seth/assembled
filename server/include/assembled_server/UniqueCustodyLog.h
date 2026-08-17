#pragma once

/// @file assembled_server/UniqueCustodyLog.h
/// @brief Append-only custody log for unique items (T-0118).
///
/// Implements the logical copy-on-write layer described in 15-server-ops.md §9.2.
/// Every custody change appends a new row to `unique_custody_log`; no existing
/// row is ever mutated.  Current custody is the row with the highest `seq` for
/// a given `unique_id`.
///
/// Event semantics (matches the SMALLINT column; enum value == DB value):
///   Seed(0)     — unique seeded into the world for the first time.
///   Lease(1)    — lease granted to a shard by UniqueAuthority.
///   Take(2)     — identity picks the unique up from a world anchor.
///   Use(3)      — identity uses the unique in place (held → anchored).
///   Bleed(4)    — sweep worker moves it to a new anchor (bleed cycle).
///   Release(5)  — lease/escrow release returns it to the authority.
///   Complete(6) — exit-condition completion (win state).
///
/// `custody_depth` for unique items is `count(*)` over the log for that
/// `unique_id`, not an incremented column on `item_instance` (04-data-model.md §3).
///
/// Duplication detection: two `Take` events with no intervening `Release` or
/// `Bleed` in the log is an INV-2 violation that is detectable after the fact
/// rather than only inferred — the key property from 15-server-ops.md §9.2.

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <optional>
#include <string>

namespace assembled_server {

/// Event codes stored in `unique_custody_log.event` (SMALLINT).
/// The underlying integer value is stored directly in the database.
enum class CustodyEvent : int16_t {
    Seed = 0,     ///< Initial seeding of the unique into the world.
    Lease = 1,    ///< Lease granted to a shard by UniqueAuthority.
    Take = 2,     ///< Identity picks the unique up from a world anchor.
    Use = 3,      ///< Identity uses the unique in place (held -> anchored).
    Bleed = 4,    ///< Sweep worker moves it to a new world anchor.
    Release = 5,  ///< Lease/escrow release returns it to the authority.
    Complete = 6, ///< Exit-condition completion (win state).
};

/// One row from `unique_custody_log`.
struct CustodyEntry {
    std::string unique_id;
    int64_t seq{};
    std::optional<std::string> holder;    ///< Identity token of the holder, or nullopt.
    std::optional<std::string> hosted_by; ///< Universe (identity token) that anchors it, or nullopt.
    std::optional<int16_t> shard_id;
    std::optional<std::string> lease_expires; ///< ISO-8601 string, or nullopt.
    CustodyEvent event{CustodyEvent::Seed};
    std::string at; ///< TIMESTAMPTZ as an ISO-8601 string.
};

/// Parameters for IUniqueCustodyLog::append().
struct AppendParams {
    std::string unique_id;
    std::optional<std::string> holder;
    std::optional<std::string> hosted_by;
    std::optional<int16_t> shard_id;
    std::optional<std::string> lease_expires; ///< ISO-8601 string, or nullopt for NULL.
    CustodyEvent event{CustodyEvent::Seed};
};

/// Abstract interface for the unique-custody append-only log.
///
/// All methods are synchronous; implementations throw
/// drogon::orm::DrogonDbException on unrecoverable DB errors.
class IUniqueCustodyLog {
  public:
    virtual ~IUniqueCustodyLog() = default;

    /// Appends a new custody row for `params.unique_id`.
    ///
    /// `seq` is assigned as `MAX(seq) + 1` for that `unique_id` (1 for the
    /// first row).  The assignment is atomic within a single INSERT statement.
    /// UniqueAuthority is a global singleton so concurrent callers for the
    /// same `unique_id` are not expected in practice.
    ///
    /// @return the newly assigned seq number.
    virtual int64_t append(const AppendParams &params) = 0;

    /// Returns the latest custody entry (highest `seq`) for `unique_id`, or
    /// `std::nullopt` if no rows exist for that unique_id.
    virtual std::optional<CustodyEntry> currentCustody(const std::string &unique_id) = 0;

    /// Returns the custody entry that was active at `point_in_time` — the
    /// latest row with `at <= point_in_time` — or `std::nullopt` if none.
    ///
    /// `point_in_time` is any TIMESTAMPTZ-parseable string (e.g. `now()::TEXT`).
    virtual std::optional<CustodyEntry>
    custodyAt(const std::string &unique_id, const std::string &point_in_time) = 0;

    /// Returns `COUNT(*)` of rows for `unique_id` — the custody depth without
    /// a separately maintained counter on `item_instance`.
    virtual int64_t custodyDepth(const std::string &unique_id) = 0;

    /// Returns the number of INV-2 violations for `unique_id`: pairs of `Take`
    /// events with no intervening `Release` or `Bleed` event between them.
    ///
    /// A return value > 0 indicates the duplication-detection property from
    /// 15-server-ops.md §9.2 has fired — the unique was somehow taken twice
    /// without being handed back.
    virtual int64_t duplicateTakeCount(const std::string &unique_id) = 0;
};

/// Postgres implementation of IUniqueCustodyLog backed by a synchronous Drogon DbClient.
class PgUniqueCustodyLog : public IUniqueCustodyLog {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgUniqueCustodyLog(drogon::orm::DbClientPtr client);

    int64_t append(const AppendParams &params) override;
    std::optional<CustodyEntry> currentCustody(const std::string &unique_id) override;
    std::optional<CustodyEntry> custodyAt(const std::string &unique_id,
                                          const std::string &point_in_time) override;
    int64_t custodyDepth(const std::string &unique_id) override;
    int64_t duplicateTakeCount(const std::string &unique_id) override;

  private:
    drogon::orm::DbClientPtr client_;

    /// Build a CustodyEntry from a single DB result row.
    static CustodyEntry rowToEntry(const drogon::orm::Row &row);
};

} // namespace assembled_server
