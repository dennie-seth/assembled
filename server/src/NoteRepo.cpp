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

void PgNoteRepo::rate(const std::string &note_id, const std::string &voter, int16_t val) {
    // Upsert: insert the vote or overwrite it if val changed.
    // The WHERE clause in DO UPDATE makes same-val a no-op at the row level.
    client_->execSqlSync("INSERT INTO note_votes (note_id, voter, val) "
                         "VALUES ($1::uuid, $2, $3::smallint) "
                         "ON CONFLICT (note_id, voter) DO UPDATE "
                         "SET val = EXCLUDED.val "
                         "WHERE note_votes.val != EXCLUDED.val",
                         note_id, voter, val);

    // Recompute the denormalized score from the authoritative votes table.
    client_->execSqlSync(
        "UPDATE notes "
        "SET rating = (SELECT COALESCE(SUM(val), 0) FROM note_votes WHERE note_id = $1::uuid) "
        "WHERE id = $1::uuid",
        note_id);

    // Bleed-timer seam (T-0098 / docs/design/02-notes-system.md §7,
    // docs/design/07-items-economy.md §5):
    //   After this point, fetch notes.author_token for note_id and call into
    //   the bleed-timer repo to update the author's held-bleed multiplier based
    //   on the new score.
    // MUST NOT touch identity.collapse_expires_at
    //   (docs/design/10-time-and-progression.md §5) — that clock is
    //   intentionally immune to rating to prevent solo players from extending
    //   their own collapse window indefinitely.
}

} // namespace assembled_server
