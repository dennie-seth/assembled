/// T-0124: PgAnchorRepo — single-transaction room-entry snapshot.
///
/// GET /v1/anchors/{archetype}/{tag} returns items, offerings, and notes
/// at a given anchor in one consistent Postgres transaction
/// (03-net-protocol.md §5).  Running three separate queries would let a
/// concurrent POST /v1/offerings commit between the item read and the
/// offering read, producing a torn view where an item appears as both loose
/// and offered.  Wrapping all three SELECTs in one transaction eliminates
/// that race.
///
/// Items are filtered to the caller's universe (hosted_by = caller_token)
/// and to those not backing an open offering (NOT EXISTS on offering).
/// Offerings are globally visible and filtered to active (expires_at > now()).
/// Notes are anchor-scoped with broadcasts excluded (is_broadcast = false).

#include "assembled_server/AnchorRepo.h"

namespace assembled_server {

PgAnchorRepo::PgAnchorRepo(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

AnchorSnapshot PgAnchorRepo::snapshot(const std::string &caller_token, int16_t archetype_id,
                                      int16_t anchor_tag) {
    // All three SELECTs run inside one transaction so the caller sees a
    // consistent point-in-time view.  Drogon's synchronous transaction
    // auto-commits when the shared_ptr goes out of scope (no explicit
    // COMMIT call required; rollback is only needed on error).
    auto txn = client_->newTransaction();

    AnchorSnapshot result;

    // ── 1. Loose items in the caller's universe ───────────────────────────────
    // "Loose" = hosted_by = caller, anchored here, holder IS NULL, and NOT
    // backed by an open offering.  Items in escrow must appear only in
    // offerings[], never in items[], to avoid a torn read.
    const auto items_rows =
        txn->execSqlSync("SELECT id, type_id, custody_depth, version, "
                         "       bleed_at::text AS bleed_at "
                         "FROM item_instance "
                         "WHERE hosted_by   = $1 "
                         "  AND anchor_arch = $2 "
                         "  AND anchor_tag  = $3 "
                         "  AND holder IS NULL "
                         "  AND NOT EXISTS ( "
                         "      SELECT 1 FROM offering "
                         "      WHERE offering.item_instance = item_instance.id "
                         "  )",
                         caller_token, archetype_id, anchor_tag);

    result.items.reserve(static_cast<std::size_t>(items_rows.size()));
    for (const auto &row : items_rows) {
        AnchorItemRecord rec;
        rec.id = row["id"].as<std::string>();
        rec.type_id = row["type_id"].as<int16_t>();
        rec.custody_depth = row["custody_depth"].as<int32_t>();
        rec.version = row["version"].as<int32_t>();
        rec.bleed_at = row["bleed_at"].as<std::string>();
        result.items.push_back(std::move(rec));
    }

    // ── 2. Open offerings at this anchor (globally visible) ───────────────────
    // expires_at > now() filters out any stale rows the sweep has not yet
    // cleaned up.  The caller's universe is irrelevant here — offerings are
    // the single genuine contention point and visible to everyone.
    const auto offer_rows =
        txn->execSqlSync("SELECT id, item_instance::text AS item_instance_id, "
                         "       wants_type, anchor_arch, anchor_tag, "
                         "       author, expires_at::text AS expires_at "
                         "FROM offering "
                         "WHERE anchor_arch = $1 "
                         "  AND anchor_tag  = $2 "
                         "  AND expires_at  > now()",
                         archetype_id, anchor_tag);

    result.offerings.reserve(static_cast<std::size_t>(offer_rows.size()));
    for (const auto &row : offer_rows) {
        AnchorOfferingRecord rec;
        rec.id = row["id"].as<std::string>();
        rec.item_instance_id = row["item_instance_id"].as<std::string>();
        rec.wants_type = row["wants_type"].as<int16_t>();
        rec.anchor_arch = row["anchor_arch"].as<int16_t>();
        rec.anchor_tag = row["anchor_tag"].as<int16_t>();
        rec.author = row["author"].as<std::string>();
        rec.expires_at = row["expires_at"].as<std::string>();
        result.offerings.push_back(std::move(rec));
    }

    // ── 3. Anchor-scoped notes, broadcasts excluded ───────────────────────────
    // is_broadcast = true notes have no anchor (04-data-model.md §5) and
    // surface via a separate path (T-0117); they must not appear here.
    // NoteRecord.author_token maps to notes.author_token.
    const auto note_rows =
        txn->execSqlSync("SELECT id, author_token, archetype_id, anchor_tag, "
                         "       template_id, slot_a, slot_b, item_ref, rating "
                         "FROM notes "
                         "WHERE archetype_id = $1 "
                         "  AND anchor_tag   = $2 "
                         "  AND is_broadcast = false "
                         "ORDER BY rating DESC",
                         archetype_id, anchor_tag);

    result.notes.reserve(static_cast<std::size_t>(note_rows.size()));
    for (const auto &row : note_rows) {
        NoteRecord n;
        n.id = row["id"].as<std::string>();
        n.author_token = row["author_token"].as<std::string>();
        n.archetype_id = row["archetype_id"].as<int16_t>();
        n.anchor_tag = row["anchor_tag"].as<int16_t>();
        n.template_id = row["template_id"].as<int16_t>();
        if (!row["slot_a"].isNull())
            n.slot_a = row["slot_a"].as<int16_t>();
        if (!row["slot_b"].isNull())
            n.slot_b = row["slot_b"].as<int16_t>();
        if (!row["item_ref"].isNull())
            n.item_ref = row["item_ref"].as<std::string>();
        n.rating = row["rating"].as<int32_t>();
        result.notes.push_back(std::move(n));
    }

    // Transaction auto-commits when txn goes out of scope.
    return result;
}

} // namespace assembled_server
