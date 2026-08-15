#pragma once

/// @file assembled_server/OfferingController.h
/// @brief HTTP handler for POST /v1/offerings/{id}/claim (T-0097).
///
/// Claims an offering: atomically transfers the offered item to the taker
/// and the payment item to the offering's author (INV-4).
///
/// Endpoint contract (03-net-protocol.md §5):
///   POST /v1/offerings/{id}/claim
///   Authorization: Bearer <token>
///   X-Lease-Id: <lease_id>        (required for mutations)
///   Body: { "transfer_id": "<uuid>", "payment_item_id": "<uuid>" }
///
/// Responses:
///   200  JSON receipt on success.
///   400  { "error": 3005 } — PAYMENT_TYPE_MISMATCH
///   404  { "error": 3004 } — OFFERING_ALREADY_CLAIMED (expired or missing)
///   409  { "error": 3001 } — TRANSFER_LOST (CAS miss on item version)
///   422  { "error": 3002 } — ITEM_NOT_HELD (payment item not in taker's hold)
///   401  { "error": 1001 } — UNKNOWN_TOKEN
///   503               — DATABASE_URL not configured

#include <drogon/HttpController.h>

#include <string>

namespace assembled_server {

/// POST /v1/offerings/{id}/claim — escrow claim (T-0097).
class OfferingController : public drogon::HttpController<OfferingController> {
  public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(OfferingController::claim, "/v1/offerings/{1}/claim", drogon::Post);
    METHOD_LIST_END

    /// @param req        POST /v1/offerings/{id}/claim with auth headers and JSON body.
    /// @param callback   invoked with the HTTP response.
    /// @param offering   offering ID path segment (UUID string).
    void claim(const drogon::HttpRequestPtr &req,
               std::function<void(const drogon::HttpResponsePtr &)> &&callback,
               const std::string &offering);
};

} // namespace assembled_server
