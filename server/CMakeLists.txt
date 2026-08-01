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

enable_testing()

# T-0032 skeleton: real server sources/targets land in Phase 4 (T-0040+).
add_executable(server_tests test/smoke_test.cpp)
target_link_libraries(server_tests PRIVATE doctest::doctest)

include(${doctest_SOURCE_DIR}/scripts/cmake/doctest.cmake)
doctest_discover_tests(server_tests)
