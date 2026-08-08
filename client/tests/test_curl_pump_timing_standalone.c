/*
 * T-0062: libcurl multi-handle non-blocking timing test (standalone C).
 *
 * Verifies the same invariant as test_curl_pump_timing.gd without requiring
 * a Godot binary: 100 consecutive curl_multi_perform() calls with an
 * in-flight GET to a closed local port must complete in < 500 ms total.
 * If the multi-handle blocked synchronously, each call would stall for at
 * least one OS connect-timeout (~2 s on Linux), making the total >> 500 ms.
 *
 * Build (from repo root):
 *   gcc -DCURL_STATICLIB \
 *       -Iclient/vendor/curl/include \
 *       client/tests/test_curl_pump_timing_standalone.c \
 *       client/vendor/curl/lib/libcurl.a \
 *       -lz -o /tmp/curl_pump_timing_test
 *
 * Run:
 *   /tmp/curl_pump_timing_test
 *
 * Exit 0 on PASS, 1 on FAIL.
 */

#include <curl/curl.h>
#include <stdio.h>
#include <time.h>

#define TICK_COUNT    100
#define MAX_TOTAL_MS  500.0

/* Discard write callback — mirrors CurlPump::discard_write(). */
static size_t discard_write(void *buf, size_t size, size_t nmemb, void *ud) {
    (void)buf;
    (void)ud;
    return size * nmemb;
}

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1.0e6;
}

int main(void) {
    curl_global_init(CURL_GLOBAL_DEFAULT);

    CURLM *multi = curl_multi_init();
    if (!multi) {
        fprintf(stderr, "T-0062 FAIL: curl_multi_init() returned NULL\n");
        curl_global_cleanup();
        return 1;
    }

    CURL *easy = curl_easy_init();
    if (!easy) {
        fprintf(stderr, "T-0062 FAIL: curl_easy_init() returned NULL\n");
        curl_multi_cleanup(multi);
        curl_global_cleanup();
        return 1;
    }

    /* Target a local port that is intentionally not listening. */
    curl_easy_setopt(easy, CURLOPT_URL, "http://127.0.0.1:19999/");
    curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, discard_write);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT_MS, 5000L);
    curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT_MS, 2000L);

    curl_multi_add_handle(multi, easy);

    double start = now_ms();

    int running = 0;
    for (int i = 0; i < TICK_COUNT; i++) {
        curl_multi_perform(multi, &running);
    }

    double total_ms = now_ms() - start;

    curl_multi_remove_handle(multi, easy);
    curl_easy_cleanup(easy);
    curl_multi_cleanup(multi);
    curl_global_cleanup();

    if (total_ms >= MAX_TOTAL_MS) {
        fprintf(stderr,
                "T-0062 FAIL: %d curl_multi_perform() calls took %.1f ms"
                " — main thread was blocked (limit %.0f ms)\n",
                TICK_COUNT, total_ms, MAX_TOTAL_MS);
        return 1;
    }

    printf("T-0062 PASS: %d curl_multi_perform() calls with in-flight request"
           " completed in %.1f ms (limit %.0f ms)\n",
           TICK_COUNT, total_ms, MAX_TOTAL_MS);
    return 0;
}
