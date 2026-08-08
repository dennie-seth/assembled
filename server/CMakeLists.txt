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
)
# PUBLIC: server headers under include/, plus repo root so that both server
# and tests can #include "shared/note_templates.hpp" (T-0043).
target_include_directories(assembled_server_lib PUBLIC include ${CMAKE_SOURCE_DIR}/..)
target_link_libraries(assembled_server_lib PUBLIC Drogon::Drogon OpenSSL::Crypto)
target_compile_definitions(assembled_server_lib PUBLIC
  ASSEMBLED_MIGRATIONS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/migrations"
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
