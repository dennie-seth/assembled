/// T-0128: ItemSpawner stub — satisfies the linker for the RED phase.
/// Real implementation follows in a second commit (GREEN).
/// FloorTopUpModel and ItemSpawner compile and link but return wrong values;
/// all integration tests that gate on DATABASE_URL will fail.

#include "assembled_server/ItemSpawner.h"

#include <stdexcept>

namespace assembled_server {

// ── FloorTopUpModel stub ──────────────────────────────────────────────────────

int32_t FloorTopUpModel::spawnsNeeded(int16_t /*rarity*/, int32_t /*current_count*/,
                                       int32_t /*cap*/, int32_t /*floor*/,
                                       bool /*is_gating*/) const {
    return 0; // stub: always 0, causing all "spawns N" assertions to fail
}

// ── ItemSpawner stub ──────────────────────────────────────────────────────────

ItemSpawner::ItemSpawner(drogon::orm::DbClientPtr client, SpawnerConfig config,
                          std::shared_ptr<ISpawnRateModel> rate_model)
    : client_(std::move(client)), config_(config), rate_model_(std::move(rate_model)) {}

SpawnTickResult ItemSpawner::runTick(const SpawnTickParams & /*params*/) {
    return {}; // stub: returns zero spawns, causing all count assertions to fail
}

int32_t ItemSpawner::computeCap(int16_t /*rarity*/, int32_t /*population*/) const {
    return 0;
}

int32_t ItemSpawner::computeFloor(int32_t /*cap*/, bool /*is_gating*/) const {
    return 0;
}

void ItemSpawner::spawnOne(const SpawnLocation & /*loc*/, int16_t /*type_id*/,
                            int16_t /*rarity*/) {}

} // namespace assembled_server
