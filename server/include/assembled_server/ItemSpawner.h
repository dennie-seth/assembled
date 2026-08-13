#pragma once

/// @file assembled_server/ItemSpawner.h
/// @brief Spontaneous item spawner that enforces per-tier rarity caps (T-0128).
///
/// INV-6 (08-invariants.md §2, 07-items-economy.md §2): after every tick,
///   count(type) <= cap(type, P)
/// where cap depends on tier:
///   Common : k_c * P
///   Rare   : k_r * P  (k_r << k_c)
///   Unique : fixed absolute count — population-independent.
///
/// INV-7 (08-invariants.md §2): gating-set types are always topped up to at
/// least floor(type, P) = floor_fraction * cap(type, P) while population > 0.
///
/// The rate model (ISpawnRateModel) is a pluggable constructor argument.
/// Landing E-7 (docs/archive/OPEN-QUESTIONS.md — Poisson rate vs. tear-driven
/// seeding) only requires swapping the model, not restructuring the spawner.

#include <drogon/orm/DbClient.h>

#include <cstdint>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace assembled_server {

/// Configuration for the per-tier cap formula (07-items-economy.md §2).
struct SpawnerConfig {
    float k_c{10.0f};          ///< Common cap multiplier: cap = k_c * P.
    float k_r{1.0f};           ///< Rare cap multiplier:   cap = k_r * P.
    int32_t unique_cap{1};     ///< Unique count: fixed, population-independent.
    float floor_fraction{0.5f}; ///< floor = floor_fraction * cap (for gating types, INV-7).
};

/// A world anchor where newly spawned items land.
///
/// Spawned rows have holder=NULL, hosted_by=hosted_by, anchor=(archetype_id,anchor_tag),
/// custody_depth=0 — the initial state for a brand-new world instance.
struct SpawnLocation {
    std::string hosted_by; ///< Universe token (must exist in identity table).
    int16_t archetype_id{};
    int16_t anchor_tag{};
};

/// Pluggable rate model — the only E-7-dependent component of the spawner.
///
/// The spawner enforces the hard cap independently: even if spawnsNeeded()
/// returns a value exceeding cap−current_count, the spawner clamps it (INV-6).
class ISpawnRateModel {
  public:
    virtual ~ISpawnRateModel() = default;

    /// Returns how many new instances to create in this tick for one item type.
    ///
    /// @param rarity        0=common, 1=rare, 2=unique.
    /// @param current_count Existing instance count for this type_id.
    /// @param cap           Hard ceiling computed from config + population.
    /// @param floor         Minimum for gating-set types (0 when not gating).
    /// @param is_gating     True if this type is in the progression-critical set.
    /// @return Desired spawn count (may be clamped by the spawner to cap−current).
    virtual int32_t spawnsNeeded(int16_t rarity, int32_t current_count, int32_t cap,
                                  int32_t floor, bool is_gating) const = 0;
};

/// Simple floor top-up model: spawns exactly enough to reach floor for gating
/// types below the floor; spawns nothing for non-gating types or types at/above cap.
///
/// Used as the default until the E-7 Poisson/tear-driven model lands.
class FloorTopUpModel : public ISpawnRateModel {
  public:
    int32_t spawnsNeeded(int16_t rarity, int32_t current_count, int32_t cap, int32_t floor,
                          bool is_gating) const override;
};

/// Parameters for one spawner tick.
struct SpawnTickParams {
    int32_t population{};                 ///< Active population P.
    std::vector<SpawnLocation> locations; ///< Available world anchors for new items.
    std::set<int16_t> gating_types;       ///< type_ids that are progression-critical (INV-7).
};

/// Result from one spawner tick.
struct SpawnTickResult {
    int32_t spawned_count{}; ///< Total new item_instance rows created this tick.
    int32_t types_at_cap{};  ///< Number of types already at or above their cap (skipped).
};

/// Abstract spawner interface (enables test doubles and future async impl).
class IItemSpawner {
  public:
    virtual ~IItemSpawner() = default;

    /// Performs one spawn tick: reads all item_types, computes caps and floors,
    /// consults the rate model, and inserts new item_instance rows at the
    /// provided locations as needed.
    ///
    /// @param params  Population, world anchors, and gating-type set for this tick.
    virtual SpawnTickResult runTick(const SpawnTickParams &params) = 0;
};

/// Postgres-backed spontaneous item spawner.
class ItemSpawner : public IItemSpawner {
  public:
    /// @param client     Live Drogon Postgres client (must not be null).
    /// @param config     Cap multipliers, unique count, and floor fraction.
    /// @param rate_model Pluggable spawn-rate model (must not be null).
    ItemSpawner(drogon::orm::DbClientPtr client, SpawnerConfig config,
                std::shared_ptr<ISpawnRateModel> rate_model);

    SpawnTickResult runTick(const SpawnTickParams &params) override;

  private:
    drogon::orm::DbClientPtr client_;
    SpawnerConfig config_;
    std::shared_ptr<ISpawnRateModel> rate_model_;

    /// Computes the hard cap for a type given its rarity tier and population.
    int32_t computeCap(int16_t rarity, int32_t population) const;

    /// Computes the floor for a gating type (floor_fraction * cap); 0 if not gating.
    int32_t computeFloor(int32_t cap, bool is_gating) const;

    /// Inserts one item_instance at the given world anchor (holder=NULL, depth=0).
    void spawnOne(const SpawnLocation &loc, int16_t type_id, int16_t rarity);
};

} // namespace assembled_server
