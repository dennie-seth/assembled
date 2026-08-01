#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

// T-0032: proves the CMake + doctest toolchain builds and runs on ubuntu-latest
// before any real server code exists. Delete once real server tests land.
TEST_CASE("server CI toolchain is wired") { CHECK(1 + 1 == 2); }
