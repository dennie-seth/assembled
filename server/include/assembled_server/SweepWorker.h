#pragma once

/// @file assembled_server/SweepWorker.h
/// @brief Per-shard background sweep worker (T-0125).
///
/// The sweep worker is the **singleton** mutating background process per shard.
/// Concurrency safety is layered:
///
///   1. **Advisory lock** (`pg_try_advisory_lock`): exactly one worker session
///      per shard holds this lock at a time.  A second worker that calls
///      tryAcquireLock() gets false — it never blocks, never errors.
///
///   2. **`FOR UPDATE SKIP LOCKED`** in the bleed phase: rows that another
///      concurrent worker's transaction has already claimed are skipped rather
///      than waited on.  This is the last-resort guard in a future multi-node
///      deployment where two processes might race past the advisory-lock check
///      (e.g., split-brain) — duplicate processing of a bleed row would
///      violate INV-2 from the inside, where CAS cannot see it.
///
/// Sweep phases (run in order by runOnce()):
///   - **Bleed**: expired item_instance rows get a landing roll + recipient
///     selection per 07-items-economy.md §4/§5.  Uniques always re-anchor.
///   - **Collapse**: identities past collapse_expires_at lose their unlocks
///     and their held items are queued for immediate bleed
///     (10-time-and-progression.md §5).
///   - **Retention**: transfer_receipt rows older than 72 h are purged.
///   - **Census**: type_census is upserted with current live_count per type_id,
///     feeding V-9 variant-eligibility gating and shard-population metrics.

#include <drogon/orm/DbClient.h>

#include <cstdint>

namespace assembled_server {

/// Results from one bleed pass.
struct BleedResult {
    int32_t landed{};   ///< Items re-anchored in a new universe.
    int32_t unlanded{}; ///< Items deleted (no recipient or supply regulator).
};

/// Aggregate results from one full sweep cycle.
struct SweepResult {
    bool lock_acquired{false}; ///< False → another session owns this shard's lock.
    BleedResult bleed;
    int32_t collapsed{};       ///< Identity universes collapsed and reset.
    int32_t receipts_purged{}; ///< transfer_receipt rows older than 72 h deleted.
    int32_t census_updated{};  ///< type_census rows upserted.
};

/// Abstract interface for the per-shard sweep worker.
///
/// Implementations must be single-threaded; one instance per shard per process.
class ISweepWorker {
  public:
    virtual ~ISweepWorker() = default;

    /// Try to acquire the session-level Postgres advisory lock for this shard.
    ///
    /// Uses `pg_try_advisory_lock(shard_id::bigint)`.  The lock is
    /// session-scoped: it persists until releaseLock() is called or the
    /// underlying DB connection is closed.
    ///
    /// @return true if this session now holds the lock; false if another
    ///         session already holds it (no error, no block).
    virtual bool tryAcquireLock() = 0;

    /// Release the session-level advisory lock acquired by tryAcquireLock().
    /// No-op if this instance does not currently hold the lock.
    virtual void releaseLock() = 0;

    /// @return true if this instance currently holds the shard advisory lock.
    virtual bool hasLock() const = 0;

    /// Run one full sweep cycle (bleed → collapse → retention → census).
    ///
    /// If the advisory lock is already held by this instance (hasLock()==true),
    /// the work runs under that lock and the lock is NOT released on return.
    ///
    /// If the lock is NOT held, runOnce() tries to acquire it.  If the
    /// acquire fails, it returns immediately with lock_acquired=false and
    /// performs no work.  If it succeeds, it runs the four phases and then
    /// releases the lock before returning.
    ///
    /// @return SweepResult describing what was done (or lock_acquired=false).
    virtual SweepResult runOnce() = 0;

    /// Run only the bleed phase (public for targeted testing).
    ///
    /// Does NOT require the advisory lock — the advisory lock is a per-worker
    /// guard; SKIP LOCKED is the per-row guard within this call.
    virtual BleedResult runBleed() = 0;

    /// Run only the collapse phase (public for targeted testing).
    /// @return count of expired identities processed.
    virtual int32_t runCollapse() = 0;

    /// Run only the retention phase (public for targeted testing).
    /// @return count of transfer_receipt rows purged.
    virtual int32_t runRetention() = 0;

    /// Run only the census phase (public for targeted testing).
    /// @return count of type_census rows upserted.
    virtual int32_t runCensus() = 0;
};

/// Postgres-backed implementation of ISweepWorker.
///
/// All methods execute synchronously via Drogon's `execSqlSync`.
/// Throws `drogon::orm::DrogonDbException` on unrecoverable DB errors.
class PgSweepWorker : public ISweepWorker {
  public:
    /// @param client    Synchronous Drogon DB client (must not be null).
    /// @param shard_id  Shard this worker owns; used as the advisory lock key.
    explicit PgSweepWorker(drogon::orm::DbClientPtr client, int16_t shard_id);

    /// Releases the advisory lock if still held.
    ~PgSweepWorker() override;

    bool tryAcquireLock() override;
    void releaseLock() override;
    bool hasLock() const override { return lock_held_; }

    SweepResult runOnce() override;
    BleedResult runBleed() override;
    int32_t runCollapse() override;
    int32_t runRetention() override;
    int32_t runCensus() override;

  private:
    drogon::orm::DbClientPtr client_;
    int16_t shard_id_;
    bool lock_held_{false};
};

} // namespace assembled_server
