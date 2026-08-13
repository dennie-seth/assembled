/// T-0128: ItemSpawner — spontaneous world spawn with rarity-cap enforcement (INV-6, INV-7).
///
/// The spawner's per-tick algorithm:
///   1. Load all item_type rows (id, rarity).
///   2. For each type, compute cap(rarity, P) and floor (for gating types).
///   3. Count current item_instance rows for that type.
///   4. Ask the pluggable rate model how many to spawn.
///   5. Clamp to cap − current_count (hard cap, INV-6 — independent of the model).
///   6. Insert world-anchored item_instance rows at provided SpawnLocations,
///      round-robining across the list.
///
/// The rate model (ISpawnRateModel) is the only E-7-dependent component.
/// Swapping it at construction is all that landing the Poisson/tear model requires.

#include "assembled_server/ItemSpawner.h"

#include <algorithm>
#include <stdexcept>

namespace assembled_server {

// ── FloorTopUpModel ──────────────────────────────────────────────────────────

int32_t FloorTopUpModel::spawnsNeeded(int16_t /*rarity*/, int32_t current_count,
                                       int32_t cap, int32_t floor, bool is_gating) const {
    if (current_count >= cap)
        return 0;
    if (is_gating && current_count < floor) {
        // Top up to the floor exactly — never request more than cap headroom.
        return floor - current_count;
    }
    return 0;
}

// ── ItemSpawner ──────────────────────────────────────────────────────────────

ItemSpawner::ItemSpawner(drogon::orm::DbClientPtr client, SpawnerConfig config,
                          std::shared_ptr<ISpawnRateModel> rate_model)
    : client_(std::move(client)), config_(config), rate_model_(std::move(rate_model)) {
    if (!rate_model_) {
        throw std::invalid_argument("ItemSpawner: rate_model must not be null");
    }
}

int32_t ItemSpawner::computeCap(int16_t rarity, int32_t population) const {
    switch (rarity) {
    case 0: // common: k_c * P
        return static_cast<int32_t>(config_.k_c * static_cast<float>(population));
    case 1: // rare: k_r * P  (k_r << k_c)
        return static_cast<int32_t>(config_.k_r * static_cast<float>(population));
    case 2: // unique: fixed count, population-independent (07-items-economy.md §2, D-7)
        return config_.unique_cap;
    default:
        return 0;
    }
}

int32_t ItemSpawner::computeFloor(int32_t cap, bool is_gating) const {
    if (!is_gating)
        return 0;
    return static_cast<int32_t>(config_.floor_fraction * static_cast<float>(cap));
}

void ItemSpawner::spawnOne(const SpawnLocation &loc, int16_t type_id, int16_t /*rarity*/) {
    // Inserts a world-anchored item_instance (holder=NULL, hosted_by set, depth=0).
    // bleed_at: 72h world/escrow timer (07-items-economy.md §5 — two-timer model).
    client_->execSqlSync(
        "INSERT INTO item_instance "
        "  (type_id, holder, hosted_by, anchor_arch, anchor_tag, custody_depth, "
        "   bleed_at) "
        "VALUES ($1, NULL, $2, $3, $4, 0, now() + INTERVAL '72 hours')",
        type_id, loc.hosted_by, loc.archetype_id, loc.anchor_tag);
}

SpawnTickResult ItemSpawner::runTick(const SpawnTickParams &params) {
    if (params.locations.empty() || params.population <= 0) {
        return {};
    }

    // Load all item types.
    auto types = client_->execSqlSync("SELECT id, rarity FROM item_type ORDER BY id");

    SpawnTickResult result;
    std::size_t loc_idx = 0;

    for (const auto &row : types) {
        const int16_t type_id = row["id"].as<int16_t>();
        const int16_t rarity = row["rarity"].as<int16_t>();
        const bool is_gating = params.gating_types.count(type_id) > 0;

        const int32_t cap = computeCap(rarity, params.population);
        const int32_t floor = computeFloor(cap, is_gating);

        // Count current instances for this type.
        auto count_row = client_->execSqlSync(
            "SELECT COUNT(*)::int AS c FROM item_instance WHERE type_id = $1", type_id);
        const int32_t current = count_row[0]["c"].as<int32_t>();

        if (current >= cap) {
            ++result.types_at_cap;
            continue;
        }

        int32_t to_spawn =
            rate_model_->spawnsNeeded(rarity, current, cap, floor, is_gating);

        // Hard clamp: INV-6 must hold regardless of what the rate model returns.
        to_spawn = std::min(to_spawn, cap - current);
        if (to_spawn <= 0)
            continue;

        for (int32_t i = 0; i < to_spawn; ++i) {
            const SpawnLocation &loc = params.locations[loc_idx % params.locations.size()];
            ++loc_idx;
            spawnOne(loc, type_id, rarity);
            ++result.spawned_count;
        }
    }

    return result;
}

} // namespace assembled_server
