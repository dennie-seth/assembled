#pragma once

/// @file assembled_server/NoteRepo.h
/// @brief INoteRepo interface and PgNoteRepo Postgres implementation (T-0044).
///
/// Lookup is equality on (archetype_id, anchor_tag) — the world is discrete
/// (D-1, docs/HANDOFF.md §3).  No radius, no coordinate, no geometry.

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace assembled_server {

/// Maximum number of notes returned by a single fetchRanked call (T-0046).
/// Requests with a larger limit are silently clamped to this value.
inline constexpr int kMaxNotesLimit = 100;

/// A note as returned by the repository (read model).
struct NoteRecord {
    std::string id;                      ///< UUID primary key (hex string).
    std::string author_token;            ///< Derived identity token.
    int16_t archetype_id{};              ///< World archetype (FK → anchor_tag).
    int16_t anchor_tag{};                ///< Anchor within archetype (FK → anchor_tag).
    int16_t template_id{};               ///< Note template (FK → note_templates).
    std::optional<int16_t> slot_a;       ///< First word slot (FK → note_words).
    std::optional<int16_t> slot_b;       ///< Second word slot (FK → note_words).
    std::optional<std::string> item_ref; ///< Server-assigned item key (nullable).
    int32_t rating{};                    ///< Aggregate rating.
};

/// Parameters for INoteRepo::create.
struct CreateNoteParams {
    std::string author_token; ///< Must exist in identity.token.
    int16_t archetype_id{};
    int16_t anchor_tag{};
    int16_t template_id{};
    std::optional<int16_t> slot_a;
    std::optional<int16_t> slot_b;
    std::optional<std::string> item_ref;
};

/// Abstract repository interface for notes.
///
/// All methods are synchronous; implementations throw
/// drogon::orm::DrogonDbException on DB or FK errors.
class INoteRepo {
  public:
    virtual ~INoteRepo() = default;

    /// Creates a note and returns its UUID string.
    /// @throws drogon::orm::DrogonDbException on FK violation or DB error.
    virtual std::string create(const CreateNoteParams &params) = 0;

    /// Returns all notes at the given discrete anchor, newest-first.
    /// Returns an empty vector when none exist.
    /// No radius parameter — lookup is equality on (archetype_id, anchor_tag).
    virtual std::vector<NoteRecord> fetch(int16_t archetype_id, int16_t anchor_tag) = 0;

    /// Returns notes at the given anchor ordered by rating DESC (score).
    /// @param limit  Maximum results to return; clamped to kMaxNotesLimit.
    ///               Returns an empty vector when no notes exist — not an error.
    /// No radius parameter — lookup is equality on (archetype_id, anchor_tag).
    virtual std::vector<NoteRecord> fetchRanked(int16_t archetype_id, int16_t anchor_tag,
                                                int limit) = 0;

    /// Casts a +1 or -1 vote from voter on note_id.
    ///
    /// One vote per (note_id, voter): resubmitting the same val is a no-op;
    /// a different val overwrites the existing vote.  notes.rating is updated
    /// atomically to reflect SUM(val) over note_votes for this note.
    ///
    /// A clear seam is left after the DB write for a future bleed-timer hook
    /// (docs/design/02-notes-system.md §7); see PgNoteRepo::rate.
    ///
    /// @param note_id  UUID of the note being rated.
    /// @param voter    Identity token of the voter (must exist in identity).
    /// @param val      +1 or -1.
    /// @throws drogon::orm::DrogonDbException if the note or voter does not exist.
    virtual void rate(const std::string &note_id, const std::string &voter, int16_t val) = 0;
};

/// Postgres implementation of INoteRepo backed by a synchronous Drogon DbClient.
class PgNoteRepo : public INoteRepo {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgNoteRepo(drogon::orm::DbClientPtr client);

    std::string create(const CreateNoteParams &params) override;
    std::vector<NoteRecord> fetch(int16_t archetype_id, int16_t anchor_tag) override;
    std::vector<NoteRecord> fetchRanked(int16_t archetype_id, int16_t anchor_tag,
                                        int limit) override;
    void rate(const std::string &note_id, const std::string &voter, int16_t val) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
