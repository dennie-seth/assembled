extends SceneTree
## T-0062: libcurl multi-handle non-blocking timing test.
##
## Verifies that CurlPump.tick() (the same code path _process() delegates to)
## never blocks the main thread while an HTTP request is in flight.  The test
## measures wall time for TICK_COUNT consecutive tick() calls; if the
## multi-handle were blocking synchronously each call would stall for at least
## one OS timeout, making the total >> MAX_TOTAL_MS.
##
## Run headless:
##   godot --headless --script tests/test_curl_pump_timing.gd
## from client/. Exit 0 on PASS, 1 on any failure.

## Number of simulated _process frames to time.
const TICK_COUNT: int = 100
## Wall-time ceiling for all ticks combined (generous; a single blocking
## HTTP connect timeout on a closed port is >> 1000 ms).
const MAX_TOTAL_MS: float = 500.0

func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("CurlPump"):
		printerr("T-0062 FAIL: CurlPump class is not registered — GDExtension did not load")
		quit(1)
		return

	var pump: CurlPump = CurlPump.new()

	# Enqueue a GET to a local port that is intentionally not listening.
	# curl_multi_perform() queues the connect attempt non-blockingly; each
	# subsequent tick() call must still return within budget.
	pump.enqueue_get("http://127.0.0.1:19999/")

	var start_us: int = Time.get_ticks_usec()

	for _i: int in range(TICK_COUNT):
		pump.tick(0.016)

	var total_ms: float = float(Time.get_ticks_usec() - start_us) / 1000.0

	pump.free()

	if total_ms >= MAX_TOTAL_MS:
		failures.append(
			"%d tick() calls took %.1f ms — main thread was blocked (limit %.0f ms)" \
			% [TICK_COUNT, total_ms, MAX_TOTAL_MS]
		)

	if failures.is_empty():
		print(
			"T-0062 PASS: %d tick() calls with in-flight request completed in %.1f ms (limit %.0f ms)" \
			% [TICK_COUNT, total_ms, MAX_TOTAL_MS]
		)
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0062 FAIL: %s" % f)
		quit(1)
