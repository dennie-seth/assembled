/// T-0123: PgRunAssembler — assembles a run of exactly 3 archetypes.
///
/// Selection algorithm:
///   1. Query all eligible variants (unlock_population <= population) from
///      Postgres with ORDER BY RANDOM() — this simultaneously randomises
///      which archetype is encountered first AND which variant within each
///      archetype appears first.
///   2. Group rows by archetype_id in first-encounter order (also random).
///   3. Greedily pick the first variant per archetype that fits within the
///      remaining room budget, reserving kMinRoomBand rooms for each archetype
///      still to be filled.
///   4. If 3 selections are found, write them inside a transaction:
///        - INSERT INTO run (token) RETURNING id
///        - INSERT INTO run_variant for each selection
///        - UPSERT INTO archetype_seen for each selection
///
/// The greedy budget-aware step ensures the 18-room cap is always respected
/// while maximising variety (it does not bias toward small or large variants
/// beyond what the cap requires).
///
/// Design note: doc conflict between 01-vision.md §7 ("5-7 archetypes") and
/// 16-level-design.md §2 ("exactly 3 archetypes") is documented in T-0123.
/// This implementation follows 16 §2 (the mechanically load-bearing spec).

#include "assembled_server/RunAssembler.h"

#include <drogon/orm/Exception.h>

#include <unordered_map>
#include <vector>

namespace assembled_server {

namespace {

constexpr int kRunSize = 3;     ///< Exactly 3 archetypes per run (16-level-design.md §2).
constexpr int kRoomCap = 18;    ///< 18-room ceiling (01-vision.md §7).
constexpr int kMinRoomBand = 5; ///< Minimum rooms per variant (01-vision.md §7).

struct VariantRow {
    int16_t archetype_id{};
    int16_t variant_id{};
    int16_t room_count{};
};

} // namespace

PgRunAssembler::PgRunAssembler(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

std::optional<RunRecord> PgRunAssembler::assemble(const AssembleParams &params) {
    // Query eligible variants in random order (ORDER BY RANDOM() satisfies the
    // "two consecutive assemblies can differ" acceptance criterion without any
    // application-layer shuffle).
    auto rows = client_->execSqlSync("SELECT v.archetype_id, v.id AS variant_id, v.room_count "
                                     "FROM variant v "
                                     "WHERE v.unlock_population <= $1 "
                                     "ORDER BY RANDOM()",
                                     params.population);

    // Group by archetype_id, preserving the random first-encounter order so
    // that both the archetype sequence and the within-archetype variant order
    // are uniformly random.
    std::unordered_map<int16_t, std::vector<VariantRow>> by_arch;
    std::vector<int16_t> arch_order;

    for (size_t i = 0; i < rows.size(); ++i) {
        VariantRow vr;
        vr.archetype_id = rows[i]["archetype_id"].as<int16_t>();
        vr.variant_id = rows[i]["variant_id"].as<int16_t>();
        vr.room_count = rows[i]["room_count"].as<int16_t>();

        if (by_arch.find(vr.archetype_id) == by_arch.end()) {
            arch_order.push_back(vr.archetype_id);
        }
        by_arch[vr.archetype_id].push_back(vr);
    }

    if (arch_order.size() < static_cast<size_t>(kRunSize)) {
        return std::nullopt;
    }

    // Greedy budget-aware selection:
    //   For each archetype in random order, pick the first variant that fits
    //   within (budget - remaining_after_this * kMinRoomBand).  This
    //   guarantees the 18-room cap while allowing archetypes with no fitting
    //   variant to be skipped in favour of later ones.
    int budget = kRoomCap;
    std::vector<SelectedVariant> selections;

    for (size_t i = 0; i < arch_order.size() && static_cast<int>(selections.size()) < kRunSize;
         ++i) {
        const int16_t arch = arch_order[i];
        const int remaining_needed = kRunSize - static_cast<int>(selections.size());
        // Reserve kMinRoomBand for each archetype still to be filled after this one.
        const int max_rooms = budget - (remaining_needed - 1) * kMinRoomBand;

        for (const VariantRow &vr : by_arch[arch]) {
            if (vr.room_count >= kMinRoomBand && vr.room_count <= max_rooms) {
                selections.push_back({arch, vr.variant_id, vr.room_count});
                budget -= vr.room_count;
                break;
            }
        }
    }

    if (static_cast<int>(selections.size()) < kRunSize) {
        return std::nullopt;
    }

    // Record the assembled run in a single transaction: run row, 3 run_variant
    // rows, 3 archetype_seen upserts.  Transaction auto-commits when txn goes
    // out of scope if rollback() has not been called.
    auto txn = client_->newTransaction();

    auto run_res =
        txn->execSqlSync("INSERT INTO run (token) VALUES ($1) RETURNING id::text", params.token);

    const std::string run_id = run_res[0]["id"].as<std::string>();

    for (const auto &sel : selections) {
        txn->execSqlSync("INSERT INTO run_variant (run_id, variant_id) VALUES ($1::uuid, $2)",
                         run_id, sel.variant_id);

        txn->execSqlSync("INSERT INTO archetype_seen (token, archetype_id, last_seen_at) "
                         "VALUES ($1, $2, now()) "
                         "ON CONFLICT (token, archetype_id) "
                         "DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at",
                         params.token, sel.archetype_id);
    }

    return RunRecord{run_id, std::move(selections)};
}

} // namespace assembled_server
