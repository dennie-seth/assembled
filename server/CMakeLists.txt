cmake_minimum_required(VERSION 3.20)
project(assembled_server LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
  doctest
  GIT_REPOSITORY https://github.com/doctest/doctest.git
  GIT_TAG v2.4.11
)
FetchContent_MakeAvailable(doctest)

# T-0040: Drogon comes from the distro package manager (Ubuntu/Debian
# `libdrogon-dev`), not vcpkg/Conan/FetchContent. Rationale (server/README.md
# "Dependency manager" section has the full writeup):
#   - Ubuntu 24.04 (noble) universe ships libdrogon-dev 1.8.7, already built
#     with PostgreSQL support (linked against libpq), on the exact OS/version
#     both local WSL dev and the ci-server GitHub runner (ubuntu-latest) use.
#   - It ships a real CMake package config, so find_package(Drogon CONFIG)
#     behaves identically to a vcpkg/Conan install — swapping dependency
#     managers later is a one-line change here, not a rewrite.
#   - No from-source Drogon build means no extra CI cache warm-up and a much
#     smaller "minimal dev-env" footprint, which is the point of this task.
find_package(Drogon CONFIG REQUIRED)

# T-0094: OpenSSL::Crypto for HMAC-SHA256 token derivation.  libssl-dev is
# already a transitive dependency of libdrogon-dev but we declare it
# explicitly so the linker sees it regardless of Drogon's link visibility.
find_package(OpenSSL REQUIRED)

enable_testing()

# Library shared by the server binary, the migrate tool, and the tests, so
# none of them re-declare HealthController/Database/MigrationRunner (DRY).
# OBJECT, not STATIC: Drogon controllers register themselves via a static
# initializer with no symbol any caller references directly, so a STATIC
# archive's linker would see HealthController.cpp.o as "unused" and drop it,
# silently turning /health into a 404. OBJECT libraries link every object
# file into consumers unconditionally, avoiding that trap.
add_library(assembled_server_lib OBJECT
  src/HealthController.cpp
  src/Database.cpp
  src/MigrationRunner.cpp
  src/SeedPhrase.cpp
  src/RateLimiter.cpp
  src/IdentityController.cpp
  src/NoteRepo.cpp
  src/NoteController.cpp
  src/SessionLeaseRepo.cpp
  src/ItemRepo.cpp
  src/ItemSpawner.cpp
  src/RunAssembler.cpp
  src/AnchorRepo.cpp
  src/AnchorController.cpp
  src/UnlockRepo.cpp
  src/OfferingRepo.cpp
  src/OfferingController.cpp
  src/TransferReceiptRepo.cpp
  src/SweepWorker.cpp
)
# PUBLIC: server headers under include/, plus repo root so that both server
# and tests can #include "shared/note_templates.hpp" (T-0043).
target_include_directories(assembled_server_lib PUBLIC include ${CMAKE_SOURCE_DIR}/..)
target_link_libraries(assembled_server_lib PUBLIC Drogon::Drogon OpenSSL::Crypto)
target_compile_definitions(assembled_server_lib PUBLIC
  ASSEMBLED_MIGRATIONS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/migrations"
  # T-0171: debugGrant API compiled in for every non-Release config so dev
  # and test builds can seed items without touching the live economy.
  # Release builds omit the define → the symbol never enters the binary.
  $<$<NOT:$<CONFIG:Release>>:ASSEMBLED_DEBUG_GRANT>
)

# T-0040/T-0050 proof-of-life: real server binary serving GET /health.
add_executable(server src/main.cpp)
target_link_libraries(server PRIVATE assembled_server_lib)

# T-0042: standalone migration-apply tool (see server/README.md).
add_executable(migrate src/migrate_main.cpp)
target_link_libraries(migrate PRIVATE assembled_server_lib)

add_executable(server_tests
  test/smoke_test.cpp
  test/health_test.cpp
  test/migration_test.cpp
  test/seed_parity_test.cpp
)
target_link_libraries(server_tests PRIVATE assembled_server_lib doctest::doctest)

include(${doctest_SOURCE_DIR}/scripts/cmake/doctest.cmake)
doctest_discover_tests(server_tests)

# T-0094: identity tests in a separate binary — drogon::app() is a
# process-global singleton; after health_test stops it via quit(), calling
# run() again is unsupported.  A fresh process gets a clean singleton.
# identity_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(identity_tests
  test/identity_test.cpp
)
target_link_libraries(identity_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(identity_tests)

# T-0044: NoteRepo tests in a separate binary — keeps a clean singleton
# state (same rationale as identity_tests vs server_tests).
# note_repo_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(note_repo_tests
  test/note_repo_test.cpp
)
target_link_libraries(note_repo_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(note_repo_tests)

# T-0045: NoteController HTTP handler tests — separate binary (same
# singleton rationale as above).
# note_handler_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(note_handler_tests
  test/note_handler_test.cpp
)
target_link_libraries(note_handler_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(note_handler_tests)

# T-0046: GET /v1/notes — tag equality + ranking tests.
# Separate binary: spins up a drogon::app() instance; must not share the
# singleton with other test binaries.
# notes_handler_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(notes_handler_tests
  test/notes_handler_test.cpp
)
target_link_libraries(notes_handler_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(notes_handler_tests)

# T-0093: SessionLeaseRepo tests — heartbeat, TTL, evict-on-takeover (INV-11).
# Separate binary: no drogon::app() singleton contention risk.
# session_lease_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(session_lease_tests
  test/session_lease_test.cpp
)
target_link_libraries(session_lease_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(session_lease_tests)

# T-0096: Two-player economy integration test (INV-1/2/3).
# Exercises the full A-leaves-X / B-takes-X scenario against real repo code.
# Separate binary: no drogon::app() singleton contention risk.
# item_economy_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(item_economy_tests
  test/item_economy_test.cpp
)
target_link_libraries(item_economy_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(item_economy_tests)

# T-0095: use() and transmute() integration tests (INV-2/INV-3/INV-5).
# Tests the hold→anchor transfer with unlock side-effect (use) and the
# two-item-in one-item-out atomic transmutation (transmute).
# Separate binary: no drogon::app() singleton contention risk.
# item_use_transmute_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(item_use_transmute_tests
  test/item_use_transmute_test.cpp
)
target_link_libraries(item_use_transmute_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(item_use_transmute_tests)

# T-0123: RunAssembler tests — 3-archetype selection, V-9 eligibility gating,
# 18-room cap, and run/run_variant/archetype_seen recording.
# Separate binary: no drogon::app() singleton contention risk.
# run_assembler_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(run_assembler_tests
  test/run_assembler_test.cpp
)
target_link_libraries(run_assembler_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(run_assembler_tests)

# T-0047: Note rating tests — one vote per player, idempotent upsert, score
# accuracy, and POST /v1/notes/{id}/rate HTTP integration.
# Separate binary: spins up its own drogon::app() on port 18091.
# note_rating_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(note_rating_tests
  test/note_rating_test.cpp
)
target_link_libraries(note_rating_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(note_rating_tests)

# T-0124: anchor snapshot tests — room-entry GET /v1/anchors/{arch}/{tag}.
# Tests: single-transaction snapshot (items/offerings/notes), concurrent
# offering race never produces a torn read, broadcasts excluded, HTTP handler.
# Separate binary: spins up its own drogon::app() on port 18090; must not
# share the singleton with other test binaries.
# anchor_snapshot_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(anchor_snapshot_tests
  test/anchor_snapshot_test.cpp
)
target_link_libraries(anchor_snapshot_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(anchor_snapshot_tests)

# T-0127: UnlockRepo tests — tier-appropriate expiry, expired-row-as-absent
# invariant, and unique-keyed unlock persistence across session boundaries.
# Separate binary: no drogon::app() singleton contention risk.
# unlock_persistence_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(unlock_persistence_tests
  test/unlock_persistence_test.cpp
)
target_link_libraries(unlock_persistence_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(unlock_persistence_tests)

# T-0097: offering escrow tests — atomic pay-and-release (INV-4).
# Tests: happy-path claim, REPEATABLE READ atomicity proof, concurrent-claimer
# race (FOR UPDATE serialisation), expiry, type mismatch, payment-not-held,
# rollback leaves no partial state, CAS-on-version guard, structural
# impossibility of both-hold and neither-hold states.
# Separate binary: no drogon::app() singleton contention risk.
# offering_escrow_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(offering_escrow_tests
  test/offering_escrow_test.cpp
)
target_link_libraries(offering_escrow_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(offering_escrow_tests)

# T-0128: Spontaneous item spawner tests — rarity-cap enforcement (INV-6, INV-7).
# Tests: hard cap respected per tier, cap held under rapid population growth,
# gating-type floor top-up, unique tier is population-independent, pluggable
# rate model is used by the spawner.
# Separate binary: no drogon::app() singleton contention risk.
# item_spawner_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(item_spawner_tests
  test/item_spawner_test.cpp
)
target_link_libraries(item_spawner_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(item_spawner_tests)

# T-0126: Transfer receipts — idempotent leave/use/take/transmute.
# Verifies receipt creation, idempotent replay, concurrent slot-claim safety,
# and expired-receipt refresh semantics.
# Separate binary: no drogon::app() singleton contention risk.
# transfer_receipt_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(transfer_receipt_tests
  test/transfer_receipt_test.cpp
)
target_link_libraries(transfer_receipt_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(transfer_receipt_tests)

# T-0125: sweep worker tests — advisory lock, SKIP LOCKED, bleed, collapse,
# retention, census.  Separate binary: no drogon::app() singleton risk.
# sweep_worker_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(sweep_worker_tests
  test/sweep_worker_test.cpp
)
target_link_libraries(sweep_worker_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(sweep_worker_tests)

# T-0171: debugGrant tests — only built for non-Release configs.
# In Release builds ASSEMBLED_DEBUG_GRANT is undefined, the grant API is
# compiled out of assembled_server_lib, and this target does not exist.
# item_grant_test.cpp contains a static_assert that fires if someone
# somehow links the binary without the define.
# T-0118: unique_custody_log tests — append-only custody history for unique items.
# Tests: table schema, monotonic seq, currentCustody, custodyDepth = count(*),
# duplicate-take detection (INV-2), and custodyAt past-instant reconstruction.
# Separate binary: no drogon::app() singleton contention risk.
# unique_custody_log_test.cpp defines its own DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
add_executable(unique_custody_log_tests
  test/unique_custody_log_test.cpp
)
target_link_libraries(unique_custody_log_tests PRIVATE assembled_server_lib doctest::doctest)
doctest_discover_tests(unique_custody_log_tests)

if(NOT CMAKE_BUILD_TYPE STREQUAL "Release")
  add_executable(item_grant_tests
    test/item_grant_test.cpp
  )
  target_link_libraries(item_grant_tests PRIVATE assembled_server_lib doctest::doctest)
  doctest_discover_tests(item_grant_tests)
endif()
