#include <drogon/HttpAppFramework.h>

#include <cstdlib>
#include <string>

/// T-0040/T-0050 proof-of-life server binary. Registers whatever
/// HttpController-derived classes are linked in (HealthController today)
/// via Drogon's static registration and serves them. Real /v1 handlers land
/// in later cards -- this only proves the toolchain builds and serves.
int main() {
    const char *portEnv = std::getenv("PORT");
    uint16_t port = portEnv ? static_cast<uint16_t>(std::stoi(portEnv)) : 8080;

    drogon::app().addListener("0.0.0.0", port);
    drogon::app().run();
    return 0;
}
