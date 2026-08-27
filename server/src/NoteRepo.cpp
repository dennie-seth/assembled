#include "assembled_server/NoteRepo.h"

namespace assembled_server {

PgNoteRepo::PgNoteRepo(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

std::string PgNoteRepo::create(const CreateNoteParams &params) {
    // Use SqlBinder directly so we can conditionally push nullptr (→ SQL NULL)
    // for optional slot_a, slot_b, and item_ref columns.  SqlBinder throws
    // DrogonDbException on FK violation or any DB error.
    drogon::orm::Result r(nullptr);
    {
        auto binder = *client_ << "INSERT INTO notes "
                                  "(author_token, archetype_id, anchor_tag, template_id, "
                                  "slot_a, slot_b, item_ref) "
                                  "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id";
        binder << params.author_token;
        binder << params.archetype_id;
        binder << params.anchor_tag;
        binder << params.template_id;

        if (params.slot_a.has_value())
            binder << params.slot_a.value();
        else
            binder << nullptr;

        if (params.slot_b.has_value())
            binder << params.slot_b.value();
        else
            binder << nullptr;

        if (params.item_ref.has_value())
            binder << params.item_ref.value();
        else
            binder << nullptr;

        binder << drogon::orm::Mode::Blocking;
        binder >> [&r](const drogon::orm::Result &result) { r = result; };
        binder.exec();
    }
    return r[0]["id"].as<std::string>();
}

std::vector<NoteRecord> PgNoteRepo::fetch(int16_t archetype_id, int16_t anchor_tag) {
    const auto rows =
        client_->execSqlSync("SELECT id, author_token, archetype_id, anchor_tag, template_id, "
                             "slot_a, slot_b, item_ref, rating "
                             "FROM notes "
                             "WHERE archetype_id = $1 AND anchor_tag = $2 "
                             "ORDER BY created_at DESC",
                             archetype_id, anchor_tag);

    std::vector<NoteRecord> result;
    result.reserve(static_cast<std::size_t>(rows.size()));
    for (const auto &row : rows) {
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
        result.push_back(std::move(n));
    }
    return result;
}

std::vector<NoteRecord> PgNoteRepo::fetchRanked(int16_t archetype_id, int16_t anchor_tag,
                                                int limit) {
    const int32_t clamped = (limit < 1) ? 1 : (limit > kMaxNotesLimit ? kMaxNotesLimit : limit);

    // Interpolate clamped directly: it is server-controlled and already range-checked,
    // so string interpolation is safe and avoids Drogon binary-protocol wire-format
    // mismatches for the LIMIT parameter (Postgres rejects mis-sized binary params).
    const std::string sql = "SELECT id, author_token, archetype_id, anchor_tag, template_id, "
                            "slot_a, slot_b, item_ref, rating "
                            "FROM notes "
                            "WHERE archetype_id = $1 AND anchor_tag = $2 "
                            "ORDER BY rating DESC "
                            "LIMIT " +
                            std::to_string(clamped);
    const auto rows = client_->execSqlSync(sql, archetype_id, anchor_tag);

    std::vector<NoteRecord> result;
    result.reserve(static_cast<std::size_t>(rows.size()));
    for (const auto &row : rows) {
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
        result.push_back(std::move(n));
    }
    return result;
}

std::string PgNoteRepo::createBroadcast(const CreateBroadcastParams &params) {
    // archetype_id and anchor_tag are omitted from the INSERT so they default to
    // NULL (migration 015 dropped the NOT NULL constraint).  is_broadcast = true
    // marks this row as a petition visible through GET /v1/petitions.
    drogon::orm::Result r(nullptr);
    {
        auto binder = *client_ << "INSERT INTO notes "
                                  "(author_token, template_id, item_ref, is_broadcast) "
                                  "VALUES ($1, $2, $3, true) RETURNING id";
        binder << params.author_token;
        binder << params.template_id;

        if (params.item_ref.has_value())
            binder << params.item_ref.value();
        else
            binder << nullptr;

        binder << drogon::orm::Mode::Blocking;
        binder >> [&r](const drogon::orm::Result &result) { r = result; };
        binder.exec();
    }
    return r[0]["id"].as<std::string>();
}

std::vector<NoteRecord> PgNoteRepo::fetchBroadcast(int limit) {
    const int32_t clamped = (limit < 1) ? 1 : (limit > kMaxNotesLimit ? kMaxNotesLimit : limit);

    const std::string sql =
        "SELECT id, author_token, template_id, slot_a, slot_b, item_ref, rating "
        "FROM notes "
        "WHERE is_broadcast = true "
        "ORDER BY rating DESC "
        "LIMIT " +
        std::to_string(clamped);
    const auto rows = client_->execSqlSync(sql);

    std::vector<NoteRecord> result;
    result.reserve(static_cast<std::size_t>(rows.size()));
    for (const auto &row : rows) {
        NoteRecord n;
        n.id = row["id"].as<std::string>();
        n.author_token = row["author_token"].as<std::string>();
        n.template_id = row["template_id"].as<int16_t>();
        n.is_broadcast = true;
        // archetype_id and anchor_tag are NULL for broadcast notes — leave at 0.

        if (!row["slot_a"].isNull())
            n.slot_a = row["slot_a"].as<int16_t>();

        if (!row["slot_b"].isNull())
            n.slot_b = row["slot_b"].as<int16_t>();

        if (!row["item_ref"].isNull())
            n.item_ref = row["item_ref"].as<std::string>();

        n.rating = row["rating"].as<int32_t>();
        result.push_back(std::move(n));
    }
    return result;
}

RateResult PgNoteRepo::rate(const std::string &note_id, const std::string &voter, int16_t val) {
    // Look up the note's anchor + author. Needed both for the proof-of-play
    // gate below and, on a genuine upvote, to know whose held items to slow.
    const auto noteRows = client_->execSqlSync(
        "SELECT archetype_id, is_broadcast, author_token FROM notes WHERE id = $1::uuid", note_id);

    // Proof-of-play (02-notes-system.md §7, T-0207): a non-broadcast note is
    // anchored to an archetype, and only a voter who has actually played
    // that archetype (an archetype_seen row) may rate it. Broadcast notes
    // have no archetype to prove against and are exempt. A missing note is
    // left to the INSERT below, which fails its FK exactly as before.
    if (!noteRows.empty() && !noteRows[0]["is_broadcast"].as<bool>() &&
        !noteRows[0]["archetype_id"].isNull()) {
        const auto archetype_id = noteRows[0]["archetype_id"].as<int16_t>();
        const auto seenRows = client_->execSqlSync(
            "SELECT 1 FROM archetype_seen WHERE token = $1 AND archetype_id = $2", voter,
            archetype_id);
        if (seenRows.empty()) {
            return RateResult{RateError::ProofOfPlayMissing};
        }
    }

    // Upsert: insert the vote or overwrite it if val changed.
    // The WHERE clause in DO UPDATE makes same-val a no-op at the row level;
    // RETURNING tells us whether this call actually changed the tally, so
    // the held-bleed bonus below never double-dips on a resubmitted vote.
    const auto voteRows = client_->execSqlSync("INSERT INTO note_votes (note_id, voter, val) "
                                               "VALUES ($1::uuid, $2, $3::smallint) "
                                               "ON CONFLICT (note_id, voter) DO UPDATE "
                                               "SET val = EXCLUDED.val "
                                               "WHERE note_votes.val != EXCLUDED.val "
                                               "RETURNING val",
                                               note_id, voter, val);
    const bool changed = !voteRows.empty();

    // Recompute the denormalized score from the authoritative votes table.
    client_->execSqlSync(
        "UPDATE notes "
        "SET rating = (SELECT COALESCE(SUM(val), 0) FROM note_votes WHERE note_id = $1::uuid) "
        "WHERE id = $1::uuid",
        note_id);

    // Held-bleed slowdown (docs/design/02-notes-system.md §7,
    // docs/design/07-items-economy.md §5, T-0207): a genuine +1 vote slows
    // the author's held bleed. Ceiling-clamped to kHeldBleedCeilingMinutes
    // from now so a single note cannot bank bleed time indefinitely. The
    // outer GREATEST(bleed_at, ...) is what actually makes this monotonic:
    // a bare LEAST(bleed_at + bonus, now() + ceiling) would *shorten*
    // bleed_at whenever it already sits beyond the ceiling (e.g. a freshly
    // spawned world item's 72h timer, ItemSpawner.cpp), which inverts the
    // acceptance criterion instead of satisfying it. With the GREATEST
    // guard a vote can only ever push bleed_at later, up to the ceiling —
    // never earlier than where it already was.
    // MUST NOT touch identity.collapse_expires_at
    //   (docs/design/10-time-and-progression.md §5) — that clock is
    //   intentionally immune to rating to prevent solo players from extending
    //   their own collapse window indefinitely.
    if (changed && val == 1 && !noteRows.empty()) {
        const auto author = noteRows[0]["author_token"].as<std::string>();
        // kHeldBleedRatingBonusMinutes/kHeldBleedCeilingMinutes are compile-time
        // constants, not user input — interpolating them into INTERVAL literals
        // avoids Drogon binary-protocol parameter issues (see fetchRanked's LIMIT).
        const std::string sql = "UPDATE item_instance "
                                "SET bleed_at = GREATEST(bleed_at, LEAST(bleed_at + INTERVAL '" +
                                std::to_string(kHeldBleedRatingBonusMinutes) +
                                " minutes', now() + INTERVAL '" +
                                std::to_string(kHeldBleedCeilingMinutes) +
                                " minutes')) "
                                "WHERE holder = $1";
        client_->execSqlSync(sql, author);
    }

    return RateResult{RateError::None};
}

} // namespace assembled_server
