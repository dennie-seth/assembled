/// T-0125: PgSweepWorker — per-shard background sweep worker.
///
/// Concurrency model (docs/design/04-data-model.md §7, 15-server-ops.md §2):
///
///   Advisory lock (session-level pg_try_advisory_lock):
///     Ensures only one worker runs per shard.  A second instance calling
///     tryAcquireLock() gets false immediately — never blocks, never errors.
///
///   FOR UPDATE SKIP LOCKED (bleed phase):
///     Within a sweep cycle, each bleed batch is a single auto-committed SQL
///     statement.  Any row already locked by another session's transaction is
///     skipped rather than waited on, preventing double-processing in a future
///     multi-node deployment where two workers could race past the advisory
///     lock (split-brain scenario).
///
/// Sweep phases (runOnce() order):
///   1. Bleed   — expired items: landing roll + recipient selection.
///   2. Collapse — expired identities: drop unlocks, queue held items for bleed.
///   3. Retention — transfer_receipt rows older than 72 h.
///   4. Census  — upsert type_census with current live counts.

#include "assembled_server/SweepWorker.h"

namespace assembled_server {

// ── Constructor / destructor ──────────────────────────────────────────────────

PgSweepWorker::PgSweepWorker(drogon::orm::DbClientPtr client, int16_t shard_id)
    : client_(std::move(client)), shard_id_(shard_id) {}

PgSweepWorker::~PgSweepWorker() {
    if (lock_held_) {
        releaseLock();
    }
}

// ── Advisory lock ─────────────────────────────────────────────────────────────

bool PgSweepWorker::tryAcquireLock() {
    if (lock_held_) {
        return true; // already held by this instance — don't double-acquire
    }
    auto result = client_->execSqlSync(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        static_cast<int64_t>(shard_id_));
    lock_held_ = result[0]["acquired"].as<bool>();
    return lock_held_;
}

void PgSweepWorker::releaseLock() {
    if (!lock_held_) {
        return;
    }
    client_->execSqlSync("SELECT pg_advisory_unlock($1::bigint)",
                         static_cast<int64_t>(shard_id_));
    lock_held_ = false;
}

// ── runOnce ───────────────────────────────────────────────────────────────────

SweepResult PgSweepWorker::runOnce() {
    SweepResult res;
    const bool acquired_here = !lock_held_; // did we acquire inside this call?

    if (!lock_held_) {
        if (!tryAcquireLock()) {
            return res; // lock_acquired = false
        }
    }

    res.lock_acquired = true;
    res.bleed = runBleed();
    res.collapsed = runCollapse();
    res.receipts_purged = runRetention();
    res.census_updated = runCensus();

    if (acquired_here) {
        releaseLock();
    }
    return res;
}

// ── Bleed phase ───────────────────────────────────────────────────────────────
//
// Single auto-committed SQL statement — the FOR UPDATE SKIP LOCKED inside the
// `candidates` CTE locks the selected rows for the duration of this statement's
// implicit transaction.  A concurrent worker's SKIP LOCKED will therefore skip
// any rows this statement has locked while it processes them.
//
// Landing logic (07-items-economy.md §4/§5):
//   - Pick one random identity as recipient and one random anchor pair.
//   - If recipient AND anchor exist: re-anchor ALL candidates (landed).
//   - If no recipient: delete non-unique candidates (unlanded); skip uniques
//     (they are exempt from deletion — they will be retried next cycle).
//   - If no anchor but recipient exists: skip all (retry next cycle).
//
// The `any_recipient` and `any_anchor` CTEs each pick a single row shared
// across the whole batch.  Per-item selection is sim territory (DM-5); the
// batch approach satisfies T-0125's acceptance criteria.

BleedResult PgSweepWorker::runBleed() {
    // clang-format off
    auto result = client_->execSqlSync(
        "WITH candidates AS ("
        "    SELECT ii.id, it.rarity"
        "    FROM item_instance ii"
        "    JOIN item_type it ON it.id = ii.type_id"
        "    WHERE ii.bleed_at < now()"
        "      AND ii.shard_id = $1"
        "    FOR UPDATE OF ii SKIP LOCKED"
        "    LIMIT 100"
        "),"
        "any_recipient AS ("
        "    SELECT token FROM identity ORDER BY random() LIMIT 1"
        "),"
        "any_anchor AS ("
        "    SELECT archetype_id, tag FROM anchor_tag ORDER BY random() LIMIT 1"
        "),"
        "re_anchored AS ("
        "    UPDATE item_instance"
        "    SET holder        = NULL,"
        "        hosted_by     = (SELECT token FROM any_recipient),"
        "        anchor_arch   = (SELECT archetype_id FROM any_anchor),"
        "        anchor_tag    = (SELECT tag FROM any_anchor),"
        "        bleed_at      = now() + INTERVAL '48 hours',"
        "        version       = version + 1,"
        "        custody_depth = custody_depth + 1"
        "    FROM candidates c"
        "    WHERE item_instance.id = c.id"
        "      AND (SELECT COUNT(*) FROM any_recipient) > 0"
        "      AND (SELECT COUNT(*) FROM any_anchor) > 0"
        "    RETURNING item_instance.id"
        "),"
        "deleted AS ("
        "    DELETE FROM item_instance"
        "    USING candidates c"
        "    WHERE item_instance.id = c.id"
        "      AND c.rarity != 2"
        "      AND (SELECT COUNT(*) FROM any_recipient) = 0"
        "    RETURNING item_instance.id"
        ")"
        "SELECT"
        "    (SELECT COUNT(*)::int FROM re_anchored) AS landed,"
        "    (SELECT COUNT(*)::int FROM deleted)     AS unlanded",
        static_cast<int16_t>(shard_id_));
    // clang-format on

    BleedResult res;
    if (!result.empty()) {
        res.landed = result[0]["landed"].as<int32_t>();
        res.unlanded = result[0]["unlanded"].as<int32_t>();
    }

    // Append to economy_ledger for INV-3 audit (04-data-model.md §7).
    // Only write when there is something to record.
    if (res.unlanded > 0) {
        client_->execSqlSync(
            "INSERT INTO economy_ledger (at, spawned, unlanded, transmute_sink) "
            "VALUES (now(), 0, $1, 0)",
            res.unlanded);
    }

    return res;
}

// ── Collapse phase ────────────────────────────────────────────────────────────
//
// Identities whose universe clock has expired (10-time-and-progression.md §5):
//   - Held items: bleed_at set to now() so the next bleed pass scatters them.
//   - Unlocks: deleted immediately.
//   - Identity: collapse_expires_at reset to now()+21d; first_universe=false.
//
// All three DML operations execute against the same DB snapshot (CTE
// semantics); the DELETE and UPDATE are mutually exclusive by design.

int32_t PgSweepWorker::runCollapse() {
    // clang-format off
    auto result = client_->execSqlSync(
        "WITH expired AS ("
        "    SELECT token FROM identity"
        "    WHERE collapse_expires_at < now()"
        "    LIMIT 100"
        "),"
        "items_scattered AS ("
        "    UPDATE item_instance"
        "    SET bleed_at = now()"
        "    WHERE holder IN (SELECT token FROM expired)"
        "      AND bleed_at > now()"
        "    RETURNING id"
        "),"
        "unlocks_dropped AS ("
        "    DELETE FROM unlock"
        "    WHERE token IN (SELECT token FROM expired)"
        "    RETURNING token"
        "),"
        "identities_reset AS ("
        "    UPDATE identity"
        "    SET collapse_expires_at = now() + INTERVAL '21 days',"
        "        first_universe      = false"
        "    WHERE token IN (SELECT token FROM expired)"
        "    RETURNING token"
        ")"
        "SELECT COUNT(DISTINCT token)::int AS collapsed FROM identities_reset");
    // clang-format on

    if (result.empty()) {
        return 0;
    }
    return result[0]["collapsed"].as<int32_t>();
}

// ── Retention phase ───────────────────────────────────────────────────────────
//
// Transfer receipts older than 72 h are deleted (04-data-model.md §4).
// The created_at index (migration 012) keeps this fast.

int32_t PgSweepWorker::runRetention() {
    auto result = client_->execSqlSync(
        "WITH deleted AS ("
        "    DELETE FROM transfer_receipt"
        "    WHERE created_at < now() - INTERVAL '72 hours'"
        "    RETURNING transfer_id"
        ")"
        "SELECT COUNT(*)::int AS purged FROM deleted");

    if (result.empty()) {
        return 0;
    }
    return result[0]["purged"].as<int32_t>();
}

// ── Census phase ──────────────────────────────────────────────────────────────
//
// Refreshes type_census with a live COUNT(*) per type_id across all shards.
// The upsert touches every type_id that has at least one live instance; types
// with zero instances are not upserted (their census row, if any, retains its
// last non-zero value until a bleed cycle deletes all instances of that type).

int32_t PgSweepWorker::runCensus() {
    // clang-format off
    auto result = client_->execSqlSync(
        "WITH counts AS ("
        "    SELECT type_id, COUNT(*)::int AS n"
        "    FROM item_instance"
        "    GROUP BY type_id"
        "),"
        "upserted AS ("
        "    INSERT INTO type_census (type_id, live_count, updated_at)"
        "    SELECT type_id, n, now() FROM counts"
        "    ON CONFLICT (type_id) DO UPDATE"
        "        SET live_count = EXCLUDED.live_count,"
        "            updated_at = EXCLUDED.updated_at"
        "    RETURNING type_id"
        ")"
        "SELECT COUNT(*)::int AS updated FROM upserted");
    // clang-format on

    if (result.empty()) {
        return 0;
    }
    return result[0]["updated"].as<int32_t>();
}

} // namespace assembled_server
