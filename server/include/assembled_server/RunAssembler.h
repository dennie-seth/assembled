#pragma once

/// @file assembled_server/RunAssembler.h
/// @brief Run assembly interface — selects exactly 3 archetypes (one eligible
/// variant each, V-9 population-gated), respects the 18-room cap
/// (01-vision.md §7), and records the result in run/run_variant/archetype_seen
/// (04-data-model.md §6, T-0123).
///
/// Design note — doc conflict:
///   01-vision.md §7 (locked) says "5-7 archetypes per run / ~15 rooms".
///   16-level-design.md §2 (mechanically load-bearing) says "exactly 3
///   archetypes".  This implementation follows 16 §2 because the tear budget
///   (chain/pocket) depends directly on there being exactly 3.  The conflict
///   is documented in the T-0123 card for design-chat reconciliation.

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace assembled_server {

/// One archetype slot in an assembled run.
struct SelectedVariant {
    int16_t archetype_id{}; ///< Archetype selected for this slot.
    int16_t variant_id{};   ///< Variant chosen from that archetype.
    int16_t room_count{};   ///< Room count this variant contributes.
};

/// The assembled run record returned to the caller.
struct RunRecord {
    std::string run_id;                      ///< Server-minted UUID of the new run row.
    std::vector<SelectedVariant> selections; ///< Exactly 3 entries.
};

/// Parameters for IRunAssembler::assemble.
struct AssembleParams {
    std::string token;    ///< Identity token of the player starting the run.
    int32_t population{}; ///< Current universe population for V-9 gating.
};

/// Abstract run-assembly interface.
///
/// @throws drogon::orm::DrogonDbException on unrecoverable DB errors.
class IRunAssembler {
  public:
    virtual ~IRunAssembler() = default;

    /// Assembles a run of exactly 3 archetypes (one eligible variant each).
    ///
    /// Variant eligibility: variant.unlock_population <= params.population (V-9).
    /// Room-count constraint: sum of selected room_counts <= 18 (01-vision.md §7).
    ///
    /// Selection is randomised (ORDER BY RANDOM()) so consecutive calls for
    /// the same population can produce different archetype/variant combinations.
    ///
    /// On success, atomically (in a single transaction):
    ///   - Inserts one run row.
    ///   - Inserts 3 run_variant rows.
    ///   - Upserts 3 archetype_seen rows for the identity.
    ///
    /// @return RunRecord on success; std::nullopt if fewer than 3 archetypes
    ///         have eligible variants or no size-fitting combination is found.
    virtual std::optional<RunRecord> assemble(const AssembleParams &params) = 0;
};

/// Postgres implementation of IRunAssembler backed by a synchronous Drogon DbClient.
class PgRunAssembler : public IRunAssembler {
  public:
    /// @param client  live Drogon Postgres client (must not be null).
    explicit PgRunAssembler(drogon::orm::DbClientPtr client);

    std::optional<RunRecord> assemble(const AssembleParams &params) override;

  private:
    drogon::orm::DbClientPtr client_;
};

} // namespace assembled_server
