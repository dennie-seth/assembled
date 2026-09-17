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

/// Held-bleed bonus granted to a note's author by a single proven +1 vote,
/// in minutes (T-0207, 02-notes-system.md §7). Exact curve is open (N-1);
/// this is the starting shape — flat bonus, ceiling-clamped below.
inline constexpr int kHeldBleedRatingBonusMinutes = 10;

/// Ceiling on held-bleed extension: bleed_at is never pushed further into
/// the future than this many minutes from now, matching the full
/// held-bleed duration (07-items-economy.md §5) so a single note cannot
/// bank bleed time indefinitely.
inline constexpr int kHeldBleedCeilingMinutes = 90;

/// Outcome of INoteRepo::rate.
enum class RateError {
    None,               ///< Vote accepted (including idempotent no-ops).
    ProofOfPlayMissing, ///< Voter has no archetype_seen row for the note's archetype.
};

/// Result returned by INoteRepo::rate.
struct RateResult {
    RateError error{RateError::None};
};

/// A note as returned by the repository (read model).
struct NoteRecord {
    std::string id;                      ///< UUID primary key (hex string).
    std::string author_token;            ///< Derived identity token.
    int16_t archetype_id{};              ///< World archetype (FK → anchor_tag). 0 for broadcasts.
    int16_t anchor_tag{};                ///< Anchor within archetype. 0 for broadcasts.
    int16_t template_id{};               ///< Note template (FK → note_templates).
    std::optional<int16_t> slot_a;       ///< First word slot (FK → note_words).
    std::optional<int16_t> slot_b;       ///< Second word slot (FK → note_words).
    std::optional<std::string> item_ref; ///< Server-assigned item key (nullable).
    int32_t rating{};                    ///< Aggregate rating.
    bool is_broadcast{false};            ///< True for petition/broadcast notes (T-0117).
};

/// Parameters for INoteRepo::createBroadcast (T-0117).
///
/// Broadcast petition notes have no anchor (archetype_id/anchor_tag are NULL
/// in the database).  Template selection follows 02-notes-system.md §6:
///   template 13 ("I need {ITEM_REF}") when item_ref is set;
///   template 14 ("something is wrong") otherwise.
struct CreateBroadcastParams {
    std::string author_token;            ///< Must exist in identity.token.
    int16_t template_id{};               ///< Note template (FK → note_templates).
    std::optional<std::string> item_ref; ///< Optional item-type reference for N-5.
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

    /// Creates an anchorless broadcast petition note (is_broadcast = true).
    ///
    /// archetype_id and anchor_tag are stored as NULL in the DB (migration 015).
    /// Returns the UUID of the new note.
    /// @throws drogon::orm::DrogonDbException on DB error.
    virtual std::string createBroadcast(const CreateBroadcastParams &params) = 0;

    /// Returns all broadcast petition notes (is_broadcast = true) ordered by
    /// rating DESC.  Clamped to kMaxNotesLimit.
    /// Returns an empty vector when none exist — not an error.
    virtual std::vector<NoteRecord> fetchBroadcast(int limit) = 0;

    /// Casts a +1 or -1 vote from voter on note_id.
    ///
    /// Proof-of-play gate (docs/design/02-notes-system.md §7, T-0207): a
    /// non-broadcast note is anchored to an archetype, and only a voter
    /// whose archetype_seen set contains that archetype may rate it —
    /// server-verifiable against the run's assembled archetype set. A voter
    /// who hasn't actually played the archetype gets back
    /// RateError::ProofOfPlayMissing and the vote is not recorded.
    /// Broadcast notes (is_broadcast, no archetype) are exempt — there is no
    /// archetype to prove.
    ///
    /// One vote per (note_id, voter): resubmitting the same val is a no-op;
    /// a different val overwrites the existing vote.  notes.rating is updated
    /// atomically to reflect SUM(val) over note_votes for this note.
    ///
    /// Held-bleed slowdown (docs/design/02-notes-system.md §7,
    /// docs/design/07-items-economy.md §5, T-0207): a vote that genuinely
    /// changes the tally to +1 for this voter (a brand-new upvote, or a flip
    /// from -1) extends bleed_at on every item_instance the note's author
    /// currently holds by kHeldBleedRatingBonusMinutes, clamped so it never
    /// exceeds kHeldBleedCeilingMinutes from now. This never touches
    /// identity.collapse_expires_at (docs/design/10-time-and-progression.md
    /// §5) — that clock is intentionally immune to rating, so a solo player
    /// cannot extend their own collapse window indefinitely.
    ///
    /// @param note_id  UUID of the note being rated.
    /// @param voter    Identity token of the voter (must exist in identity).
    /// @param val      +1 or -1.
    /// @return RateResult::error == RateError::None on success (including
    ///         idempotent no-ops), or RateError::ProofOfPlayMissing if the
    ///         voter hasn't proven play of the note's archetype.
    /// @throws drogon::orm::DrogonDbException if the note or voter does not exist,
    ///         or on other DB errors.
    virtual RateResult rate(const std::string &note_id, const std::string &voter, int16_t val) = 0;
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
    std::string createBroadcast(const CreateBroadcastParams &params) override;
    std::vector<NoteRecord> fetchBroadcast(int limit) override;
    RateResult rate(const std::string &note_id, const std::string &voter, int16_t val) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
