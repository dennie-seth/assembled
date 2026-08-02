extends SceneTree
## Headless dev-env smoke test (T-0060/T-0061). Run with:
##   godot --headless --script tests/smoke_test.gd
## from client/. Asserts the GDExtension actually loaded and its class is
## usable from GDScript, not just that the project imports. Exits 0 on
## success, 1 on any failure so CI can gate on the process exit code.

func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("AssembledPing"):
		failures.append("AssembledPing class is not registered — GDExtension did not load")
	else:
		var ping: AssembledPing = AssembledPing.new()
		var result: String = ping.ping()
		if result != "pong":
			failures.append("ping() returned '%s', expected 'pong'" % result)
		if ping.get_ping_count() != 1:
			failures.append("ping_count was %d after one call, expected 1" % ping.get_ping_count())
		ping.ping()
		if ping.get_ping_count() != 2:
			failures.append("ping_count was %d after two calls, expected 2" % ping.get_ping_count())

	if failures.is_empty():
		print("SMOKE TEST PASS: AssembledPing GDExtension loaded and round-tripped correctly")
		quit(0)
	else:
		for f in failures:
			printerr("SMOKE TEST FAIL: %s" % f)
		quit(1)
