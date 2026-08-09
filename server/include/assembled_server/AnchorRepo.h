#pragma once

/// @file assembled_server/AnchorRepo.h
/// @brief IAnchorRepo interface and PgAnchorRepo Postgres implementation (T-0124).
///
/// Returns a single-transaction snapshot of everything relevant at a world
/// anchor on room entry (03-net-protocol.md §5 "Items & anchors"):
///
///   - items[]     — loose item_instance rows hosted in the caller's universe
///                   at this anchor (not backed by any open offering).
///   - offerings[] — open offering rows at this anchor, globally visible.
///   - notes[]     — anchor-scoped notes (is_broadcast = false only).
///
/// **All three reads happen inside one database transaction.**  Running them
/// as separate queries would let a concurrent POST /v1/offerings commit
/// between the item read and the offering read, producing a torn view where
/// an item appears as both loose (in items[]) and offered (in offerings[]).
/// A single transaction with REPEATABLE READ isolation eliminates that race.

#include "assembled_server/NoteRepo.h"

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <string>
#include <vector>

namespace assembled_server {

/// Snapshot of a single item_instance row in the loose/anchored context.
struct AnchorItemRecord {
    std::string id;
    int16_t type_id{};
    int32_t custody_depth{};
    int32_t version{};
    std::string bleed_at; ///< ISO 8601 timestamp string from Postgres.
};

/// Snapshot of a single offering row.
struct AnchorOfferingRecord {
    std::string id;
    std::string item_instance_id; ///< UUID of the escrowed item_instance.
    int16_t wants_type{};
    int16_t anchor_arch{};
    int16_t anchor_tag{};
    std::string author; ///< Token of the identity that created the offering.
    std::string expires_at; ///< ISO 8601 timestamp string from Postgres.
};

/// Combined room-entry snapshot for one anchor position.
struct AnchorSnapshot {
    std::vector<AnchorItemRecord> items;         ///< Loose items in caller's universe.
    std::vector<AnchorOfferingRecord> offerings; ///< Open offerings (global).
    std::vector<NoteRecord> notes;               ///< Anchor-scoped notes (no broadcasts).
};

/// Abstract repository interface for room-entry anchor snapshots.
///
/// All methods are synchronous; implementations throw
/// drogon::orm::DrogonDbException on unrecoverable DB errors.
class IAnchorRepo {
  public:
    virtual ~IAnchorRepo() = default;

    /// Returns a consistent snapshot of one anchor in one transaction.
    ///
    /// @param caller_token  Bearer identity; filters items by hosted_by.
    /// @param archetype_id  Archetype of the anchor.
    /// @param anchor_tag    Tag within the archetype.
    virtual AnchorSnapshot snapshot(const std::string &caller_token, int16_t archetype_id,
                                    int16_t anchor_tag) = 0;
};

/// Postgres implementation of IAnchorRepo backed by a synchronous Drogon DbClient.
class PgAnchorRepo : public IAnchorRepo {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgAnchorRepo(drogon::orm::DbClientPtr client);

    AnchorSnapshot snapshot(const std::string &caller_token, int16_t archetype_id,
                            int16_t anchor_tag) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
