cmake_minimum_required(VERSION 3.16)
project(curl_pump_timing_test C)

# ---------------------------------------------------------------------------
# T-0062: standalone non-blocking timing test for the libcurl multi-handle.
#
# Builds test_curl_pump_timing_standalone.c against the prebuilt static
# libcurl installed under client/vendor/curl/ (produced by SConstruct's
# _vendor_curl() step, or by running `scons` in client/).
#
# Usage (from repo root):
#   cmake -S client/tests -B client/tests/build
#   cmake --build client/tests/build
#   ctest --test-dir client/tests/build --output-on-failure
#
# Prerequisites:
#   * client/vendor/curl/ must exist (run `scons` in client/ if absent).
#   * zlib must be installed (libz, always present on Linux/macOS).
# ---------------------------------------------------------------------------

set(CURL_PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/../vendor/curl")
set(CURL_STATIC_LIB "${CURL_PREFIX}/lib/libcurl.a")
set(CURL_INCLUDE_DIR "${CURL_PREFIX}/include")

if(NOT EXISTS "${CURL_STATIC_LIB}")
    message(FATAL_ERROR
        "Prebuilt libcurl not found at ${CURL_STATIC_LIB}.\n"
        "Run `scons` inside client/ first to vendor libcurl, then re-run cmake.")
endif()

add_executable(curl_pump_timing_standalone
    test_curl_pump_timing_standalone.c
)

target_compile_definitions(curl_pump_timing_standalone PRIVATE CURL_STATICLIB)
target_include_directories(curl_pump_timing_standalone PRIVATE "${CURL_INCLUDE_DIR}")

# Link against prebuilt static libcurl plus zlib (libcurl's only dep here).
target_link_libraries(curl_pump_timing_standalone PRIVATE "${CURL_STATIC_LIB}" z)

enable_testing()

add_test(
    NAME T0062_curl_pump_non_blocking_timing
    COMMAND curl_pump_timing_standalone
)

set_tests_properties(T0062_curl_pump_non_blocking_timing PROPERTIES
    LABELS "T-0062;timing;non-blocking"
)
