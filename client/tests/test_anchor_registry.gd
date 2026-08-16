extends SceneTree
## T-0176: AnchorRegistry — anchor-tag to position binding tests.
##
## Verifies:
##   - register_anchor / has_anchor round-trip
##   - resolve returns the exact registered position
##   - resolve for an unknown anchor returns Vector2.ZERO and logs an error
##     (fails loudly, not silently)
##   - validate_required_tags returns true when all tags are registered
##   - validate_required_tags returns false (and logs errors) when any tag
##     is missing — this is the "build-time failure" gate (01 §7, INV-12)
##
## Run headless:
##   godot --headless --script tests/test_anchor_registry.gd
## from client/. Exit 0 on PASS, 1 on any failure.

func _init() -> void:
	var failures: Array[String] = []

	if not ClassDB.class_exists("AnchorRegistry"):
		printerr("T-0176 FAIL: AnchorRegistry class not registered — GDExtension did not load")
		quit(1)
		return

	failures += _test_register_and_has()
	failures += _test_resolve_known()
	failures += _test_resolve_unknown()
	failures += _test_validate_all_present()
	failures += _test_validate_missing_tag()

	if failures.is_empty():
		print("T-0176 PASS: AnchorRegistry binds anchor tags to positions correctly")
		quit(0)
	else:
		for f: String in failures:
			printerr("T-0176 FAIL: %s" % f)
		quit(1)


## ── Test: register and has_anchor ────────────────────────────────────────────

func _test_register_and_has() -> Array[String]:
	var failures: Array[String] = []
	var reg: AnchorRegistry = AnchorRegistry.new()

	# Before registration, has_anchor must return false.
	if reg.has_anchor(1, 1):
		failures.append("register_and_has: has_anchor(1,1) returned true before any registration")

	reg.register_anchor(1, 1, Vector2(100.0, 200.0))

	if not reg.has_anchor(1, 1):
		failures.append("register_and_has: has_anchor(1,1) returned false after registration")

	# Different archetype with same tag must NOT collide.
	if reg.has_anchor(2, 1):
		failures.append("register_and_has: has_anchor(2,1) should be false (different archetype)")

	# Different tag on same archetype must NOT collide.
	if reg.has_anchor(1, 2):
		failures.append("register_and_has: has_anchor(1,2) should be false (different tag)")

	return failures


## ── Test: resolve returns exact registered position ───────────────────────────

func _test_resolve_known() -> Array[String]:
	var failures: Array[String] = []
	var reg: AnchorRegistry = AnchorRegistry.new()

	var expected: Vector2 = Vector2(320.0, 480.0)
	reg.register_anchor(2, 3, expected)

	var got: Vector2 = reg.resolve(2, 3)
	if got != expected:
		failures.append(
			"resolve_known: expected %s, got %s" % [str(expected), str(got)]
		)

	# Overwrite should reflect the new position.
	var updated: Vector2 = Vector2(10.0, 20.0)
	reg.register_anchor(2, 3, updated)
	var got2: Vector2 = reg.resolve(2, 3)
	if got2 != updated:
		failures.append(
			"resolve_known: after overwrite expected %s, got %s" % [str(updated), str(got2)]
		)

	return failures


## ── Test: resolve on unknown anchor returns Vector2.ZERO (loud fail) ──────────
## The method logs an error to stderr via ERR_FAIL_COND_V_MSG — that is the
## intended loud signal.  The test only checks the return value so Godot's
## error system emits naturally without crashing the runner.

func _test_resolve_unknown() -> Array[String]:
	var failures: Array[String] = []
	var reg: AnchorRegistry = AnchorRegistry.new()

	var got: Vector2 = reg.resolve(999, 999)
	if got != Vector2.ZERO:
		failures.append(
			"resolve_unknown: expected Vector2.ZERO for unknown anchor, got %s" % str(got)
		)

	return failures


## ── Test: validate_required_tags — all present ────────────────────────────────

func _test_validate_all_present() -> Array[String]:
	var failures: Array[String] = []
	var reg: AnchorRegistry = AnchorRegistry.new()

	# Register the full HOSPITAL archetype tag set (archetype 1: tags 1–5).
	for tag: int in [1, 2, 3, 4, 5]:
		reg.register_anchor(1, tag, Vector2(float(tag) * 10.0, 0.0))

	var ok: bool = reg.validate_required_tags(1, [1, 2, 3, 4, 5])
	if not ok:
		failures.append(
			"validate_all_present: validate_required_tags returned false when all 5 HOSPITAL tags registered"
		)

	# Empty required list should always return true.
	var empty_ok: bool = reg.validate_required_tags(1, [])
	if not empty_ok:
		failures.append(
			"validate_all_present: validate_required_tags returned false for empty required list"
		)

	return failures


## ── Test: validate_required_tags — missing tag ────────────────────────────────
## This is the "build-time failure" gate: a Room variant that omits a required
## tag must be caught at scene load, not at runtime.

func _test_validate_missing_tag() -> Array[String]:
	var failures: Array[String] = []
	var reg: AnchorRegistry = AnchorRegistry.new()

	# Register only tag 1; require tags 1 and 2.
	reg.register_anchor(1, 1, Vector2(50.0, 50.0))

	var ok: bool = reg.validate_required_tags(1, [1, 2])
	if ok:
		failures.append(
			"validate_missing_tag: validate_required_tags returned true with tag 2 absent"
		)

	# Requiring only the present tag should still succeed.
	var partial_ok: bool = reg.validate_required_tags(1, [1])
	if not partial_ok:
		failures.append(
			"validate_missing_tag: validate_required_tags returned false for a registered tag"
		)

	return failures
