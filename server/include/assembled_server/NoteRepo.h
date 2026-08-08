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

    /// Increments the note's rating by 1.
    /// @throws drogon::orm::DrogonDbException if the note is not found or on
    ///         any DB error.
    virtual void rate(const std::string &note_id) = 0;
};

/// Postgres implementation of INoteRepo backed by a synchronous Drogon DbClient.
class PgNoteRepo : public INoteRepo {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgNoteRepo(drogon::orm::DbClientPtr client);

    std::string create(const CreateNoteParams &params) override;
    std::vector<NoteRecord> fetch(int16_t archetype_id, int16_t anchor_tag) override;
    void rate(const std::string &note_id) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
