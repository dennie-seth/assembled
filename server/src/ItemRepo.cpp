/// T-0095: PgItemRepo — custody transfer as CAS on version (INV-2).
/// STUB: methods declared so the test binary links and compiles, but every
/// call throws std::runtime_error("not implemented").  Tests will be RED
/// until the real implementation replaces this stub.

#include "assembled_server/ItemRepo.h"

#include <stdexcept>

namespace assembled_server {

PgItemRepo::PgItemRepo(drogon::orm::DbClientPtr client) : client_(std::move(client)) {}

std::optional<ItemRecord> PgItemRepo::find(const std::string & /*item_id*/) {
    throw std::runtime_error("PgItemRepo::find not implemented");
}

int32_t PgItemRepo::countByType(int16_t /*type_id*/) {
    throw std::runtime_error("PgItemRepo::countByType not implemented");
}

TransferResult PgItemRepo::leave(const LeaveParams & /*params*/) {
    throw std::runtime_error("PgItemRepo::leave not implemented");
}

TransferResult PgItemRepo::take(const TakeParams & /*params*/) {
    throw std::runtime_error("PgItemRepo::take not implemented");
}

} // namespace assembled_server
